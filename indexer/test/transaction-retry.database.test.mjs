import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { toHex } from "viem";
import { applyMigrations, createDatabasePool, resetIndexerTables, tableName } from "../src/db.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { createRelaySubmissionRepository } from "../src/relayer/repository.mjs";
import { encodeDestinationSubmission } from "../src/relayer/encoding.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { signDeliveryTransaction } from "../src/transaction-manager/transaction.mjs";
import { replacementFees } from "../src/transaction-manager/retry-policy.mjs";
import { transactionConfig, transactionHarness, transientSendError } from "./helpers/transaction-fixtures.mjs";
import { persistReadyTransactionFixture } from "./helpers/transaction-database-fixtures.mjs";
import { fixtureHash } from "./helpers/delivery-fixtures.mjs";
import { sourceState } from "../../validator/test/helpers/four-process.mjs";

const config = transactionConfig({ DATABASE_URL: process.env.DATABASE_URL,
  INDEXER_DB_SCHEMA: `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_tx_retry` });
const pool = createDatabasePool(config);
const queue = createDeliveryRepository({ config,pool });
const intents = tableName(config.databaseSchema,"transaction_intents");
const attempts = tableName(config.databaseSchema,"transaction_attempts");
let h;
let jobs;
before(async () => { await applyMigrations(pool,config.databaseSchema); });
beforeEach(async () => {
  await resetIndexerTables(pool,config.databaseSchema);
  await persistReadyTransactionFixture({ config,pool });
  jobs = await queue.listReadyDeliveryJobs(); h = await transactionHarness({ config });
});
after(async () => { await pool.end(); });

function body(intent,attempt,blockNumber = null,blockHash = null) {
  return { hash: attempt.transactionHash,from: intent.senderAddress,to: intent.destinationGateway,input: intent.calldata,
    nonce: toHex(BigInt(intent.nonce)),value: "0x0",type: "0x2",chainId: toHex(BigInt(intent.chainId)),
    gas: toHex(BigInt(attempt.gasLimit)),maxFeePerGas: toHex(BigInt(attempt.maxFeePerGas)),
    maxPriorityFeePerGas: toHex(BigInt(attempt.maxPriorityFeePerGas)),blockNumber: blockNumber === null ? null : toHex(blockNumber),blockHash };
}
function managerFor(databasePool = pool,overrides = {}) {
  const cfg = overrides.config ?? config;
  const rpc = { ...h.rpc,async broadcast(raw) {
    const row = (await databasePool.query(`SELECT * FROM ${attempts} WHERE raw_signed_transaction = $1`,[raw])).rows[0];
    assert.ok(row,"raw transaction must be durably visible before send");
    assert.ok(["SIGNED","BROADCAST"].includes(row.status));
    const intent = (await databasePool.query(`SELECT * FROM ${intents} WHERE delivery_job_id = $1`,[row.delivery_job_id])).rows[0];
    h.calls.broadcast.push(raw);
    h.state.transactions.set(row.transaction_hash,body({ chainId: intent.chain_id,senderAddress: intent.sender_address,
      destinationGateway: intent.destination_gateway,calldata: intent.calldata,nonce: intent.nonce },{
      transactionHash: row.transaction_hash,gasLimit: row.gas_limit,maxFeePerGas: row.max_fee_per_gas,maxPriorityFeePerGas: row.max_priority_fee_per_gas }));
    if (BigInt(row.nonce) >= h.state.pendingNonce) h.state.pendingNonce = BigInt(row.nonce) + 1n;
    return row.transaction_hash;
  } };
  return createTransactionManager({ config: cfg,pool: databasePool,queue: createDeliveryRepository({ config: cfg,pool: databasePool }),
    clock: h.clock,rpc,...overrides });
}
async function mine(manager,id,attemptId,status = 1) {
  const stored = await manager.repository.getTransaction(id);
  const attempt = stored.attempts.find(a => a.attemptId === attemptId);
  const hash = fixtureHash(1100);
  h.state.receipts.set(attempt.transactionHash,{ transactionHash: attempt.transactionHash,blockNumber: "0x64",blockHash: hash,status: toHex(status) });
  h.state.blocks.set("100",{ number: "0x64",hash });
  h.state.transactions.set(attempt.transactionHash,body(stored.intent,attempt,100n,hash));
  h.state.latestNonce = BigInt(stored.intent.nonce) + 1n; h.state.head = 102n;
}

test("durable exact retry counters and schedules recover through an independent pool", async () => {
  const id = jobs[0].deliveryJobId;
  const failed = managerFor(pool,{ rpc: { ...h.rpc,async broadcast() { throw transientSendError(); } } });
  await assert.rejects(failed.submitDelivery(id));
  const before = await failed.repository.getTransaction(id); const account = await failed.repository.getAccount();
  for (const limit of [0,1001,"1",1.5]) {
    await assert.rejects(failed.repository.listDueIntents({ now: h.clock.now(),limit }),{ code: "INVALID_DELIVERY_LIMIT" });
    await assert.rejects(failed.repository.listTrackingIntents({ limit }),{ code: "INVALID_DELIVERY_LIMIT" });
  }
  assert.equal(before.attempt.broadcastAttemptCount,"1"); assert.equal(before.attempt.lastErrorClass,"TRANSIENT_RPC_ERROR");
  const fresh = createDatabasePool(config);
  try {
    const recovered = managerFor(fresh);
    assert.deepEqual(await recovered.repository.getTransaction(id),before);
    assert.equal((await recovered.processTransactionRetriesOnce()).processed,0);
    h.advance(config.replacementAfterMs);
    assert.equal((await recovered.processTransactionRetriesOnce()).replacements,0);
    const after = await recovered.repository.getTransaction(id);
    assert.equal(after.attempt.broadcastAttemptCount,"2"); assert.equal(after.attempts.length,1);
    assert.equal(after.attempt.transactionHash,before.attempt.transactionHash);
    assert.equal(after.attempt.rawSignedTransaction,before.attempt.rawSignedTransaction);
    assert.deepEqual(await recovered.repository.getAccount(),account);
  } finally { await fresh.end(); }
});

test("competing clients create exactly one linear child of the same parent", async () => {
  const id = jobs[0].deliveryJobId; const manager = managerFor();
  const first = await manager.submitDelivery(id); const account = await manager.repository.getAccount();
  const sourceBefore = await sourceState(pool,config.databaseSchema);
  const fresh = createDatabasePool(config);
  try {
    h.advance(config.replacementAfterMs);
    const other = managerFor(fresh);
    const results = await Promise.all([manager.prepareReplacement(id,first.attempt.attemptId),other.prepareReplacement(id,first.attempt.attemptId)]);
    assert.equal(results.filter(value => value.created).length,1);
    const record = await other.repository.getTransaction(id);
    assert.equal(record.attempts.length,2); assert.equal(record.attempt.attemptNumber,1);
    assert.equal(record.attempt.replacementOfAttemptId,first.attempt.attemptId);
    assert.equal(record.intent.nonce,first.intent.nonce); assert.equal(record.attempt.nonce,first.attempt.nonce);
    for (const field of ["gasLimit","rawSignedTransaction","transactionHash","maxFeePerGas","maxPriorityFeePerGas"]) {
      assert.equal(record.attempts[0][field],first.attempt[field]);
    }
    assert.deepEqual(await other.repository.getAccount(),account);
    assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore);
    assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
    assert.equal((await other.prepareReplacement(id,first.attempt.attemptId)).created,false);
    const recovery = await managerFor(fresh).prepareDeliveryTransaction(id);
    assert.deepEqual(recovery.attempts,record.attempts);
    const sent = await other.broadcastPreparedTransaction(id);
    assert.equal(sent.attempt.rawSignedTransaction,record.attempt.rawSignedTransaction);
  } finally { await fresh.end(); }
});

test("a replacement pre-commit failure preserves the original active attempt and nonce", async () => {
  const id = jobs[0].deliveryJobId; const manager = managerFor();
  const first = await manager.submitDelivery(id); const account = await manager.repository.getAccount();
  h.advance(config.replacementAfterMs);
  const failure = managerFor(pool,{ beforeSignedCommit: async () => { throw new Error("replacement commit interrupted"); } });
  await assert.rejects(failure.prepareReplacement(id),/replacement commit interrupted/);
  assert.deepEqual(await manager.repository.getTransaction(id),{ intent: first.intent,attempt: first.attempt,attempts: first.attempts,winningAttempt: null });
  assert.deepEqual(await manager.repository.getAccount(),account);
  assert.equal(h.calls.broadcast.length,1);
});

test("old and new winners are durable, and finalized intents cannot acquire another attempt", async () => {
  for (const oldWins of [true,false]) {
    const id = jobs[oldWins ? 0 : 1].deliveryJobId; const manager = managerFor();
    const first = await manager.submitDelivery(id); h.advance(config.replacementAfterMs);
    const child = await manager.prepareReplacement(id); await manager.broadcastPreparedTransaction(id);
    const winner = oldWins ? first.attempt : child.attempt;
    await mine(manager,id,winner.attemptId);
    assert.equal((await manager.checkReceiptsOnce()).confirmed,1);
    const fresh = createDatabasePool(config);
    try {
      const restored = managerFor(fresh); const record = await restored.repository.getTransaction(id);
      assert.equal(record.intent.winningAttemptId,winner.attemptId); assert.equal(record.winningAttempt.transactionHash,winner.transactionHash);
      assert.equal(record.attempts.find(a => a.attemptId !== winner.attemptId).status,"REPLACED");
      assert.equal(record.intent.nextActionAt,null);
      assert.equal((await restored.prepareReplacement(id)).created,false);
      assert.equal((await restored.rebroadcastTransaction(id)).broadcast,false);
      const loser = record.attempts.find(a => a.attemptId !== winner.attemptId);
      await assert.rejects(restored.repository.recordOutcome(id,{ transactionHash: loser.transactionHash,blockNumber: 100n,blockHash: fixtureHash(1100),head: 102n,status: 1 }),
        { code: "CONFLICTING_TRANSACTION_OUTCOME" });
      await assert.rejects(pool.query(`UPDATE ${intents} SET winning_attempt_id = $2 WHERE delivery_job_id = $1`,[id,loser.attemptId]),/illegal transaction intent/);
      const fees = replacementFees(record.attempt,h.state.fees,config);
      assert.equal((await restored.repository.persistReplacement({ id,parentAttemptId: record.attempt.attemptId,fees,
        sign: () => assert.fail("finalized intent must never sign") })).created,false);
    } finally { await fresh.end(); }
  }
});

test("SQL guards immutable intent nonce, linear lineage, fee growth and gas preservation", async () => {
  const id = jobs[0].deliveryJobId; const manager = managerFor();
  const first = await manager.submitDelivery(id); h.advance(config.replacementAfterMs);
  const child = await manager.prepareReplacement(id);
  await assert.rejects(pool.query(`UPDATE ${intents} SET nonce = nonce + 1 WHERE delivery_job_id = $1`,[id]),/immutable/);
  for (const assignment of ["nonce = nonce + 1","replacement_of_attempt_id = NULL","gas_limit = gas_limit + 1"]) {
    await assert.rejects(pool.query(`UPDATE ${attempts} SET ${assignment} WHERE attempt_id = $1`,[child.attempt.attemptId]),/immutable/);
  }
  async function invalidInsert(ordinal,parent,nonce,gas,max,priority) {
    return pool.query(`INSERT INTO ${attempts} (delivery_job_id,attempt_number,replacement_of_attempt_id,chain_id,sender_address,status,nonce,
      gas_limit,max_fee_per_gas,max_priority_fee_per_gas,transaction_type,raw_signed_transaction,transaction_hash)
      VALUES ($1,$2,$3,$4,$5,'SIGNED',$6,$7,$8,$9,2,$10,$11)`,
      [id,ordinal,parent,first.intent.chainId,first.intent.senderAddress,nonce,gas,max,priority,"0x02ff",fixtureHash(991)]);
  }
  const a = child.attempt;
  await assert.rejects(invalidInsert(2,a.attemptId,BigInt(a.nonce) + 1n,a.gasLimit,4000000000n,2000000000n),/durable nonce/);
  await assert.rejects(invalidInsert(2,first.attempt.attemptId,a.nonce,a.gasLimit,4000000000n,2000000000n),/linear next/);
  await assert.rejects(invalidInsert(3,a.attemptId,a.nonce,a.gasLimit,4000000000n,2000000000n),/linear next/);
  await assert.rejects(invalidInsert(2,a.attemptId,a.nonce,BigInt(a.gasLimit) + 1n,4000000000n,2000000000n),/linear next/);
  await assert.rejects(invalidInsert(2,a.attemptId,a.nonce,a.gasLimit,a.maxFeePerGas,a.maxPriorityFeePerGas),/linear next/);
  assert.equal((await manager.repository.getTransaction(id)).attempts.length,2);
});

test("winning attempt must belong to its intent; stopped retries cannot be reset", async () => {
  const manager = managerFor(); const firstId = jobs[0].deliveryJobId; const secondId = jobs[1].deliveryJobId;
  await manager.submitDelivery(firstId); const other = await manager.submitDelivery(secondId);
  await assert.rejects(pool.query(`UPDATE ${intents} SET status = 'CONFIRMED',next_action_at = NULL,winning_attempt_id = $2 WHERE delivery_job_id = $1`,
    [firstId,other.attempt.attemptId]),/winning transaction attempt/);
  await manager.repository.stopRetry(firstId,"MAX_ATTEMPTS_REACHED");
  await assert.rejects(pool.query(`UPDATE ${intents} SET retry_stopped_at = NULL,retry_stop_reason = NULL,next_action_at = CURRENT_TIMESTAMP WHERE delivery_job_id = $1`,
    [firstId]),/cannot be reset/);
  h.advance(config.replacementAfterMs);
  const due = await manager.repository.listDueIntents({ now: h.clock.now(),limit: 100 });
  assert.ok(due.every(r => r.intent.deliveryJobId !== firstId));
  const record = await manager.repository.getTransaction(firstId);
  await mine(manager,firstId,record.attempt.attemptId,0);
  assert.equal((await manager.checkReceiptsOnce()).reverted,1);
  assert.equal((await manager.repository.getTransaction(firstId)).intent.status,"REVERTED");
});

test("upgrade preserves original signed artifacts, final receipts, allocator and historical submissions", async () => {
  const names = (await readdir(new URL("../migrations/",import.meta.url))).filter(name => /^\d+_.*\.sql$/.test(name) && Number(name.slice(0,3)) <= 11).sort();
  for (const status of ["SIGNED","BROADCAST","CONFIRMED","REVERTED"]) {
    const schema = `tx_upgrade_${randomUUID().replaceAll("-","")}`;
    const cfg = { ...config,databaseSchema: schema };
    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
      for (const name of names) {
        await client.query(await readFile(new URL(`../migrations/${name}`,import.meta.url),"utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)",[name]);
      }
      await client.query("COMMIT");
      transactionOpen = false;
      await persistReadyTransactionFixture({ config: cfg,pool });
      const reader = createDeliveryRepository({ config: cfg,pool });
      const ready = await reader.listReadyDeliveryJobs();
      const id = ready[0].deliveryJobId;
      const manager = createTransactionManager({ config: cfg,pool,queue: reader,rpc: h.rpc,clock: h.clock });
      const intent = await manager.resolveIntent(id);
      const signed = await signDeliveryTransaction(intent,{ nonce: 9n,gasLimit: 123456n,maxFeePerGas: 3000000000n,maxPriorityFeePerGas: 1000000000n },h.options.account);
      const oldAccounts = tableName(schema,"transaction_accounts");
      const oldIntents = tableName(schema,"transaction_intents");
      const oldAttempts = tableName(schema,"transaction_attempts");
      await pool.query(`INSERT INTO ${oldAccounts} (chain_id,sender_address,next_nonce) VALUES ($1,$2,10)`,[intent.chainId,intent.senderAddress]);
      await pool.query(`INSERT INTO ${oldIntents} (delivery_job_id,package_digest,chain_id,sender_address,destination_gateway,value,calldata)
        VALUES ($1,$2,$3,$4,$5,0,$6)`,[id,intent.packageDigest,intent.chainId,intent.senderAddress,intent.destinationGateway,intent.calldata]);
      await pool.query(`INSERT INTO ${oldAttempts} (delivery_job_id,chain_id,sender_address,status,nonce,gas_limit,max_fee_per_gas,max_priority_fee_per_gas,
        transaction_type,raw_signed_transaction,transaction_hash) VALUES ($1,$2,$3,'SIGNED',9,123456,3000000000,1000000000,2,$4,$5)`,
        [id,intent.chainId,intent.senderAddress,signed.rawSignedTransaction,signed.transactionHash]);
      if (status !== "SIGNED") await pool.query(`UPDATE ${oldAttempts} SET status = 'BROADCAST',broadcast_at = '2026-01-01T00:00:01Z'`);
      if (["CONFIRMED","REVERTED"].includes(status)) await pool.query(`UPDATE ${oldAttempts} SET status = $1,receipt_block_number = 100,receipt_block_hash = $2,
        receipt_status = $3,confirmed_head = 102,confirmed_at = '2026-01-01T00:00:02Z'`,[status,fixtureHash(1100),status === "CONFIRMED" ? 1 : 0]);
      const legacy = createRelaySubmissionRepository({ config: cfg,pool,queue: reader });
      const legacyId = ready[1].deliveryJobId;
      const encoded = await encodeDestinationSubmission(await reader.getDeliveryPackage(legacyId),{ validatorSets: cfg.validatorSets });
      const oldSubmission = await legacy.recordSubmission({ deliveryJobId: legacyId,encoded,transactionHash: fixtureHash(992) });
      const artifacts = (await pool.query(`SELECT * FROM ${oldAttempts}`)).rows[0];
      const allocation = (await pool.query(`SELECT * FROM ${oldAccounts}`)).rows;
      const sourceBefore = await sourceState(pool,schema);
      await applyMigrations(pool,schema);
      const migrated = (await pool.query(`SELECT * FROM ${oldAttempts}`)).rows[0];
      for (const key of Object.keys(artifacts)) assert.deepEqual(migrated[key],artifacts[key],`upgrade must preserve ${status} ${key}`);
      assert.equal(migrated.broadcast_attempt_count,status === "SIGNED" ? "0" : "1");
      assert.equal(migrated.replacement_of_attempt_id,null);
      const restored = await manager.repository.getTransaction(id);
      assert.equal(restored.intent.nonce,"9"); assert.equal(restored.attempts.length,1);
      assert.equal(restored.intent.status,["SIGNED","BROADCAST"].includes(status) ? "PENDING" : status);
      assert.deepEqual((await pool.query(`SELECT * FROM ${oldAccounts}`)).rows,allocation);
      assert.deepEqual(await legacy.getSubmission(legacyId),oldSubmission);
      assert.deepEqual(await sourceState(pool,schema),sourceBefore);
      await applyMigrations(pool,schema);
    } finally {
      if (transactionOpen) await client.query("ROLLBACK");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      client.release();
    }
  }
});
