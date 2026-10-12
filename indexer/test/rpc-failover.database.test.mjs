import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { toHex } from "viem";
import { applyMigrations, createDatabasePool, resetIndexerTables, tableName } from "../src/db.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { verifySignedTransaction } from "../src/transaction-manager/transaction.mjs";
import { transactionConfig, transactionHarness } from "./helpers/transaction-fixtures.mjs";
import { persistReadyTransactionFixture } from "./helpers/transaction-database-fixtures.mjs";
import { destinationRpcFixture, transactionBody, rpcTimeout } from "./helpers/destination-rpc-fixtures.mjs";
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
function managerFor(databasePool = pool,rpc = destination.rpc) {
  return createTransactionManager({ config,pool: databasePool,queue: createDeliveryRepository({ config,pool: databasePool }),rpc,clock: h.clock });
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
