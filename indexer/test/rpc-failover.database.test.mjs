import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir,readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { toHex } from "viem";
import { applyMigrations, createDatabasePool, resetIndexerTables, tableName } from "../src/db.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { verifySignedTransaction } from "../src/transaction-manager/transaction.mjs";
import { transactionConfig, transactionHarness } from "./helpers/transaction-fixtures.mjs";
import { persistReadyTransactionFixture } from "./helpers/transaction-database-fixtures.mjs";
import { destinationRpcFixture, transactionBody, rpcTimeout, rpcHttpError, rpcProviderLimit, rpcRejection } from "./helpers/destination-rpc-fixtures.mjs";
import { fixtureHash } from "./helpers/delivery-fixtures.mjs";
import { sourceState } from "../../validator/test/helpers/four-process.mjs";

const config = transactionConfig({ DATABASE_URL: process.env.DATABASE_URL,
  INDEXER_DB_SCHEMA: `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_rpc`,
  CHAIN_B_RPC_URLS: '["http://127.0.0.1:9545","http://127.0.0.1:9546"]' });
const pool = createDatabasePool(config);
const queue = createDeliveryRepository({ config,pool });
const intents = tableName(config.databaseSchema,"transaction_intents");
const attempts = tableName(config.databaseSchema,"transaction_attempts");
let h; let destination; let jobs; let reader;
before(async () => { await applyMigrations(pool,config.databaseSchema); });
beforeEach(async () => {
  await resetIndexerTables(pool,config.databaseSchema);
  await persistReadyTransactionFixture({ config,pool });
  jobs = await queue.listReadyDeliveryJobs(); h = await transactionHarness({ config });
  destination = destinationRpcFixture({ config,async onBroadcast(raw) {
    const row = (await pool.query(`SELECT delivery_job_id,status,attempt_id FROM ${attempts} WHERE raw_signed_transaction = $1`,[raw])).rows[0];
    assert.ok(row,"an independent client must see the exact committed signed attempt before endpoint send");
    assert.ok(["SIGNED","BROADCAST"].includes(row.status));
    const stored = await reader.repository.getTransaction(row.delivery_job_id);
    const signed = stored.attempts.find(a => a.attemptId === row.attempt_id);
    await verifySignedTransaction(stored.intent,signed);
    return transactionBody(stored.intent,signed);
  } });
  reader = managerFor();
});
after(async () => { await pool.end(); });
function managerFor(databasePool = pool,rpc = destination.rpc,account) {
  return createTransactionManager({ config,pool: databasePool,queue: createDeliveryRepository({ config,pool: databasePool }),rpc,clock: h.clock,account });
}
async function cardinality() {
  return (await pool.query(`SELECT (SELECT COUNT(*) FROM ${intents})::int AS intents,(SELECT COUNT(*) FROM ${attempts})::int AS attempts`)).rows[0];
}
async function mine(manager,id,attemptId,status = 1) {
  const record = await manager.repository.getTransaction(id);
  const winner = record.attempts.find(a => a.attemptId === attemptId);
  const hash = fixtureHash(1100);
  destination.receipts.set(winner.transactionHash,{ transactionHash: winner.transactionHash,blockNumber: "0x64",blockHash: hash,status: toHex(status) });
  destination.transactions.set(winner.transactionHash,transactionBody(record.intent,winner,100n,hash));
  destination.nodes.forEach(node => { node.head = 102n; node.latestNonce = BigInt(record.intent.nonce) + 1n; });
}

for (const [label,makeFailure] of [
  ["HTTP 429",() => rpcHttpError(429)],
  ["HTTP 503",() => rpcHttpError(503)],
  ["known provider -32007",() => rpcProviderLimit(-32007)],
]) {
  test(label + " all-path failure persists retry scheduling and a fresh client retries the same identity", async () => {
    const id = jobs[0].deliveryJobId; const first = await reader.prepareDeliveryTransaction(id);
    const account = await reader.repository.getAccount(); const original = await sourceState(pool,config.databaseSchema);
    destination.nodes.forEach(node => { node.faults.set("eth_sendRawTransaction",() => { throw makeFailure(); }); });
    await assert.rejects(reader.broadcastPreparedTransaction(id),{ code: "RPC_UNAVAILABLE" });
    const before = await reader.repository.getTransaction(id);
    assert.equal(before.attempt.lastErrorClass,"TRANSIENT_RPC_ERROR"); assert.equal(before.attempt.status,"SIGNED");
    assert.equal(before.intent.retryStoppedAt,null); assert.ok(Date.parse(before.intent.nextActionAt) > h.clock.now());
    assert.equal(before.attempt.broadcastAttemptCount,"1");
    const journal = await reader.repository.getBroadcastEvents(id);
    assert.ok(journal.every(event => event.completedAt !== null && event.errorClass === "TRANSIENT_RPC_ERROR"));
    const fresh = createDatabasePool(config);
    try {
      const rpc = destination.restart().rpc;
      rpc.estimateGas = async () => assert.fail("exact retry must not estimate gas");
      rpc.fees = async () => assert.fail("exact retry must not resolve fees");
      const recovered = managerFor(fresh,rpc,{ address: config.relayerAddress,async signTransaction() { assert.fail("exact retry must not re-sign"); } });
      assert.deepEqual(await recovered.repository.getTransaction(id),before);
      assert.equal((await recovered.processTransactionRetriesOnce()).processed,0);
      destination.nodes.forEach(node => node.faults.clear());
      h.advance(config.rebroadcastIntervalMs);
      const result = await recovered.processTransactionRetriesOnce();
      assert.equal(result.broadcasts,1); assert.equal(result.replacements,0);
      const sent = await recovered.repository.getTransaction(id);
      assert.equal(sent.intent.status,"PENDING"); assert.equal(sent.intent.retryStoppedAt,null);
      assert.equal(sent.attempt.broadcastAttemptCount,"2"); assert.equal(sent.attempts.length,1);
      for (const field of ["nonce","gasLimit","maxFeePerGas","maxPriorityFeePerGas","rawSignedTransaction","transactionHash","createdAt"]) assert.equal(sent.attempt[field],first.attempt[field]);
      assert.deepEqual(await recovered.repository.getAccount(),account); assert.deepEqual(await cardinality(),{ intents: 1,attempts: 1 });
      assert.deepEqual(await sourceState(pool,config.databaseSchema),original); assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
    } finally { await fresh.end(); }
  });
}

test("accepted HTTP 408 with no healthy fallback is found by a fresh client without another send or signature", async () => {
  const id = jobs[0].deliveryJobId; const signed = await reader.prepareDeliveryTransaction(id);
  const account = await reader.repository.getAccount();
  destination.nodes[0].faults.set("eth_sendRawTransaction",async ({ forward }) => { await forward(); throw rpcHttpError(408); });
  destination.nodes[1].available = false;
  await assert.rejects(reader.broadcastPreparedTransaction(id),error => error.code === "RPC_UNAVAILABLE" && error.errorClass === "AMBIGUOUS_BROADCAST");
  const pending = await reader.repository.getTransaction(id);
  assert.equal(pending.attempt.lastErrorClass,"AMBIGUOUS_BROADCAST"); assert.equal(pending.intent.retryStoppedAt,null);
  assert.equal(destination.transactions.size,1); assert.equal(pending.attempt.status,"SIGNED");
  const fresh = createDatabasePool(config);
  try {
    destination.nodes[0].available = false; destination.nodes[1].available = true;
    const recovered = managerFor(fresh,destination.restart().rpc,{ address: config.relayerAddress,async signTransaction() { assert.fail("accepted-hash recovery must not re-sign"); } });
    assert.deepEqual(await recovered.repository.getTransaction(id),pending);
    const result = await recovered.recoverTransactionsOnce({ deliveryJobId: id });
    assert.equal(result.reconciled,1); assert.equal(result.rebroadcast,0);
    const restored = await recovered.repository.getTransaction(id);
    assert.equal(restored.attempt.status,"BROADCAST"); assert.equal(restored.attempts.length,1);
    assert.equal(restored.attempt.rawSignedTransaction,signed.attempt.rawSignedTransaction);
    assert.equal(restored.attempt.transactionHash,signed.attempt.transactionHash);
    assert.equal(restored.attempt.broadcastAttemptCount,"1");
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,1);
    assert.deepEqual(await recovered.repository.getAccount(),account);
    await mine(recovered,id,signed.attempt.attemptId);
    assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).finalized,1);
  } finally { await fresh.end(); }
});

for (const [label,makeFailure,errorClass,reason] of [
  ["invalid transaction",() => rpcRejection("invalid sender"),"DETERMINISTIC_REJECTION","DETERMINISTIC_REJECTION"],
  ["unknown provider error",() => new Error("unclassified provider result"),"RPC_RESPONSE_ERROR","RPC_UNKNOWN_ERROR"],
  ["malformed JSON",() => new SyntaxError("invalid JSON response"),"RPC_RESPONSE_ERROR","RPC_INVALID_RESPONSE"],
]) {
  test(label + " remains explicitly stopped and readable after a fresh database client starts", async () => {
    const id = jobs[0].deliveryJobId; const signed = await reader.prepareDeliveryTransaction(id);
    const account = await reader.repository.getAccount();
    destination.nodes[0].faults.set("eth_sendRawTransaction",() => { throw makeFailure(); });
    await assert.rejects(reader.broadcastPreparedTransaction(id),{ code: reason });
    const before = await reader.repository.getTransaction(id);
    assert.equal(before.attempt.lastErrorClass,errorClass); assert.equal(before.intent.retryStopReason,reason);
    assert.equal(before.intent.nextActionAt,null);
    assert.equal(destination.nodes[1].calls.some(call => call.method === "eth_sendRawTransaction"),false);
    const fresh = createDatabasePool(config);
    try {
      destination.nodes.forEach(node => node.faults.clear()); h.advance(config.replacementAfterMs);
      const recovered = managerFor(fresh,destination.restart().rpc);
      assert.deepEqual(await recovered.repository.getTransaction(id),before);
      assert.equal((await recovered.processTransactionRetriesOnce()).processed,0);
      assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).manualActionRequired,1);
      assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,0);
      assert.deepEqual(await recovered.repository.getAccount(),account);
      assert.equal((await recovered.repository.getTransaction(id)).attempt.rawSignedTransaction,signed.attempt.rawSignedTransaction);
      assert.deepEqual(await cardinality(),{ intents: 1,attempts: 1 });
    } finally { await fresh.end(); }
  });
}

test("response-class migration preserves existing classified attempts, completed journal and account state", async () => {
  const schema = "rpc_upgrade_" + randomUUID().replaceAll("-","");
  const cfg = { ...config,databaseSchema: schema };
  const names = (await readdir(new URL("../migrations/",import.meta.url))).filter(name => /^\d+_.*\.sql$/.test(name) && Number(name.slice(0,3)) <= 14).sort();
  const client = await pool.connect(); let open = false; let failure;
  try {
    await client.query("BEGIN"); open = true;
    await client.query('CREATE SCHEMA "' + schema + '"');
    await client.query('SET LOCAL search_path TO "' + schema + '"');
    await client.query("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    for (const name of names) {
      await client.query(await readFile(new URL("../migrations/" + name,import.meta.url),"utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)",[name]);
    }
    await client.query("COMMIT"); open = false;
    await persistReadyTransactionFixture({ config: cfg,pool });
    const legacyQueue = createDeliveryRepository({ config: cfg,pool });
    const id = (await legacyQueue.listReadyDeliveryJobs())[0].deliveryJobId;
    const legacy = createTransactionManager({ config: cfg,pool,queue: legacyQueue,rpc: destination.rpc,clock: h.clock });
    const prepared = await legacy.prepareDeliveryTransaction(id);
    // Freeze a pre-upgrade completed 503 journal through its existing SQL
    // guards. Live HTTP classification/fallback is covered above; the current
    // sender intentionally requires the current schema, not a compatibility path.
    await client.query("BEGIN"); open = true;
    const journalTable = tableName(schema,"transaction_broadcast_events");
    const parent = (await client.query(`INSERT INTO ${journalTable} (attempt_id,broadcast_sequence) VALUES ($1,1) RETURNING event_id`,[prepared.attempt.attemptId])).rows[0];
    const endpoint = (await client.query(`INSERT INTO ${journalTable} (attempt_id,broadcast_sequence,parent_event_id,endpoint_label)
      VALUES ($1,2,$2,'rpc-0') RETURNING event_id`,[prepared.attempt.attemptId,parent.event_id])).rows[0];
    for (const event of [endpoint,parent]) await client.query(`UPDATE ${journalTable} SET completed_at = clock_timestamp(),result_class = 'ERROR',error_class = 'TRANSIENT_RPC_ERROR'
      WHERE event_id = $1`,[event.event_id]);
    await client.query(`UPDATE ${tableName(schema,"transaction_attempts")} SET broadcast_attempt_count = 1,last_broadcast_attempt_at = $2,
      last_error_class = 'TRANSIENT_RPC_ERROR' WHERE attempt_id = $1`,[prepared.attempt.attemptId,new Date(h.clock.now())]);
    await client.query("COMMIT"); open = false;
    const stored = await legacy.repository.getTransaction(id);
    const journal = await legacy.repository.getBroadcastEvents(id); const account = await legacy.repository.getAccount();
    assert.equal(stored.attempt.lastErrorClass,"TRANSIENT_RPC_ERROR");
    assert.ok(journal.length > 0 && journal.every(event => event.completedAt !== null));
    await applyMigrations(pool,schema);
    assert.deepEqual(await legacy.repository.getTransaction(id),stored);
    assert.deepEqual(await legacy.repository.getBroadcastEvents(id),journal);
    assert.deepEqual(await legacy.repository.getAccount(),account);
  } catch (error) { failure = error; throw error; }
  finally {
    try {
      if (open) await client.query("ROLLBACK");
      await client.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    } catch (error) { if (!failure) throw error; console.error("RPC upgrade fixture cleanup failed: " + error.message); }
    finally { client.release(); }
  }
});

test("provider switching preserves one durable intent, reservation and exact signed attempt", async () => {
  const id = jobs[0].deliveryJobId; const first = await reader.prepareDeliveryTransaction(id);
  const account = await reader.repository.getAccount(); const beforeSource = await sourceState(pool,config.databaseSchema);
  destination.nodes[0].available = false;
  const fresh = createDatabasePool(config);
  try {
    const recovered = managerFor(fresh,destination.restart().rpc);
    const sent = await recovered.broadcastPreparedTransaction(id);
    assert.equal(sent.acceptedEndpointLabel,"rpc-1");
    for (const field of ["nonce","gasLimit","maxFeePerGas","maxPriorityFeePerGas","rawSignedTransaction","transactionHash"]) assert.equal(sent.attempt[field],first.attempt[field]);
    assert.deepEqual(await cardinality(),{ intents: 1,attempts: 1 });
    assert.deepEqual(await recovered.repository.getAccount(),account);
    assert.deepEqual(await sourceState(pool,config.databaseSchema),beforeSource);
    assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
  } finally { await fresh.end(); }
});

test("both unavailable after an ambiguous send retain classified schedule and exact recovery state", async () => {
  const id = jobs[0].deliveryJobId; const first = await reader.prepareDeliveryTransaction(id);
  const account = await reader.repository.getAccount();
  destination.nodes[0].faults.set("eth_sendRawTransaction",() => { throw rpcTimeout(); });
  destination.nodes[1].available = false;
  await assert.rejects(reader.broadcastPreparedTransaction(id),{ code: "RPC_UNAVAILABLE" });
  const stored = await reader.repository.getTransaction(id);
  assert.equal(stored.attempt.status,"SIGNED"); assert.equal(stored.attempt.broadcastAttemptCount,"1");
  assert.equal(stored.attempt.lastErrorClass,"AMBIGUOUS_BROADCAST");
  assert.ok(stored.intent.nextActionAt); assert.equal(stored.intent.retryStoppedAt,null);
  const fresh = createDatabasePool(config);
  try {
    const manager = managerFor(fresh,destination.restart().rpc);
    assert.deepEqual(await manager.repository.getTransaction(id),stored);
    assert.equal((await manager.processTransactionRetriesOnce()).processed,0);
    destination.nodes[0].available = false; destination.nodes[1].available = true;
    h.advance(config.replacementAfterMs);
    const result = await manager.processTransactionRetriesOnce();
    assert.equal(result.replacements,0); assert.equal(result.broadcasts,1);
    const sent = await manager.repository.getTransaction(id);
    assert.equal(sent.attempt.broadcastAttemptCount,"2");
    assert.equal(sent.attempt.rawSignedTransaction,first.attempt.rawSignedTransaction);
    assert.equal(sent.attempt.transactionHash,first.attempt.transactionHash);
    assert.deepEqual(await manager.repository.getAccount(),account);
    assert.deepEqual(await cardinality(),{ intents: 1,attempts: 1 });
  } finally { await fresh.end(); }
});

test("accepted response loss and already-known fallback preserve one database transaction identity", async () => {
  const id = jobs[0].deliveryJobId;
  destination.nodes[0].faults.set("eth_sendRawTransaction",async ({ forward }) => { await forward(); throw rpcTimeout(); });
  destination.nodes[1].alreadyKnown = true;
  const result = await reader.submitDelivery(id);
  assert.equal(result.reconciled,true); assert.equal(result.attempt.status,"BROADCAST");
  assert.equal(result.attempts.length,1); assert.equal(result.attempt.broadcastAttemptCount,"1");
  assert.equal((await reader.repository.getAccount()).nextNonce,"10");
  assert.deepEqual(await cardinality(),{ intents: 1,attempts: 1 });
  assert.equal(destination.transactions.size,1);
});

test("replacement via secondary preserves linear history and either historical candidate can win", async () => {
  for (const oldWins of [true,false]) {
    const id = jobs[oldWins ? 0 : 1].deliveryJobId;
    const manager = managerFor(pool,destination.restart().rpc);
    destination.nodes[0].available = true;
    const first = await manager.submitDelivery(id); h.advance(config.replacementAfterMs);
    const replacement = await manager.prepareReplacement(id);
    const account = await manager.repository.getAccount();
    destination.nodes[0].available = false;
    const sent = await manager.broadcastPreparedTransaction(id);
    assert.equal(sent.acceptedEndpointLabel,"rpc-1"); assert.equal(sent.attempt.rawSignedTransaction,replacement.attempt.rawSignedTransaction);
    assert.equal(sent.attempt.nonce,first.attempt.nonce); assert.equal(sent.attempts.length,2);
    assert.deepEqual(await manager.repository.getAccount(),account);
    const winner = oldWins ? first.attempt : replacement.attempt;
    await mine(manager,id,winner.attemptId,oldWins ? 0 : 1);
    const checked = await manager.checkReceiptsOnce();
    assert.equal(oldWins ? checked.reverted : checked.confirmed,1);
    const fresh = createDatabasePool(config);
    try {
      const recovered = managerFor(fresh,destination.restart().rpc);
      const final = await recovered.repository.getTransaction(id);
      assert.equal(final.intent.winningAttemptId,winner.attemptId);
      assert.equal(final.attempts.find(a => a.attemptId !== winner.attemptId).status,"REPLACED");
      assert.equal((await recovered.prepareReplacement(id)).created,false);
    } finally { await fresh.end(); }
  }
});

test("null and conflicting cross-provider receipt views cannot lose state or finalize prematurely", async () => {
  const id = jobs[0].deliveryJobId; const submitted = await reader.submitDelivery(id);
  await mine(reader,id,submitted.attempt.attemptId);
  destination.nodes[0].hideReceipts = true; destination.nodes[0].hideTransactions = true;
  destination.nodes[0].blocks.set("100",{ number: "0x64",hash: fixtureHash(999) });
  await assert.rejects(reader.checkReceiptsOnce(),{ code: "INCONSISTENT_RPC_VIEW" });
  assert.equal((await reader.repository.getTransaction(id)).intent.status,"PENDING");
  h.advance(config.replacementAfterMs);
  const retry = await reader.processTransactionRetriesOnce();
  assert.equal(retry.replacements,0); assert.equal(retry.broadcasts,0);
  assert.equal(retry.results[0].errorClass,"TRANSIENT_RPC_ERROR");
  assert.equal((await reader.repository.getTransaction(id)).intent.retryStoppedAt,null);
  destination.nodes[0].blocks.delete("100"); h.advance(config.rebroadcastIntervalMs);
  const fresh = createDatabasePool(config);
  try {
    const restored = managerFor(fresh,destination.restart().rpc);
    assert.equal((await restored.processTransactionRetriesOnce()).results[0].action,"CONFIRMED");
    assert.equal((await restored.repository.getTransaction(id)).intent.winningAttemptId,submitted.attempt.attemptId);
    assert.deepEqual(await cardinality(),{ intents: 1,attempts: 1 });
  } finally { await fresh.end(); }
});

test("provider pending visibility can advance allocation but lower fallback cannot regress it", async () => {
  destination.nodes[1].pendingNonce = (1n << 100n) + 11n;
  const first = await reader.prepareDeliveryTransaction(jobs[0].deliveryJobId);
  assert.equal(first.intent.nonce,destination.nodes[1].pendingNonce.toString());
  destination.nodes[1].available = false; destination.nodes[0].pendingNonce = 9n;
  const second = await managerFor(pool,destination.restart().rpc).prepareDeliveryTransaction(jobs[1].deliveryJobId);
  assert.equal(BigInt(second.intent.nonce),BigInt(first.intent.nonce) + 1n);
  assert.equal((await reader.repository.getAccount()).nextNonce,(BigInt(second.intent.nonce) + 1n).toString());
});
