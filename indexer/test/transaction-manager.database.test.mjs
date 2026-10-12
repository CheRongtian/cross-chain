import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createDatabasePool, applyMigrations, resetIndexerTables, tableName } from "../src/db.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { encodeDestinationSubmission } from "../src/relayer/encoding.mjs";
import { createRelaySubmissionRepository } from "../src/relayer/repository.mjs";
import { createSingleRelayer } from "../src/relayer/service.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { createTransactionRepository } from "../src/transaction-manager/repository.mjs";
import { transactionConfig, transactionHarness } from "./helpers/transaction-fixtures.mjs";
import { persistReadyTransactionFixture } from "./helpers/transaction-database-fixtures.mjs";
import { fixtureHash } from "./helpers/delivery-fixtures.mjs";
import { sourceState } from "../../validator/test/helpers/four-process.mjs";

const config = transactionConfig({ DATABASE_URL: process.env.DATABASE_URL,
  INDEXER_DB_SCHEMA: `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_tx`, RELAYER_MAX_JOBS_PER_RUN: "100" });
const pool = createDatabasePool(config);
const queue = createDeliveryRepository({ config, pool });
const accounts = tableName(config.databaseSchema, "transaction_accounts");
const intents = tableName(config.databaseSchema, "transaction_intents");
const attempts = tableName(config.databaseSchema, "transaction_attempts");
let h;
let jobs;

before(async () => { await applyMigrations(pool, config.databaseSchema); });
beforeEach(async () => {
  await resetIndexerTables(pool, config.databaseSchema);
  await persistReadyTransactionFixture({ config, pool });
  jobs = await queue.listReadyDeliveryJobs();
  h = await transactionHarness({ config });
});
after(async () => { await pool.end(); });

function managerFor(databasePool = pool, overrides = {}) {
  const reader = createDeliveryRepository({ config, pool: databasePool });
  const rpc = { ...h.rpc, async broadcast(raw) {
    h.calls.broadcast.push(raw);
    const row = (await databasePool.query(`SELECT * FROM ${attempts} WHERE raw_signed_transaction = $1`, [raw])).rows[0];
    assert.ok(row, "SIGNED attempt must be durably visible to an independent client before send");
    assert.equal(row.status, "SIGNED");
    return row.transaction_hash;
  } };
  return createTransactionManager({ config, pool: databasePool, queue: reader, rpc, ...overrides });
}
async function counts() {
  return (await pool.query(`SELECT (SELECT COUNT(*) FROM ${accounts})::int AS accounts,
    (SELECT COUNT(*) FROM ${intents})::int AS intents,(SELECT COUNT(*) FROM ${attempts})::int AS attempts`)).rows[0];
}

test("independent clients atomically allocate unique consecutive nonces and one intent for a concurrent duplicate job", async () => {
  const fresh = [createDatabasePool(config),createDatabasePool(config)];
  try {
    const managers = [managerFor(),...fresh.map(client => managerFor(client))];
    const signed = await Promise.all(jobs.map((job,index) => managers[index].prepareDeliveryTransaction(job.deliveryJobId)));
    assert.deepEqual(signed.map(value => BigInt(value.attempt.nonce)).sort((a,b) => a < b ? -1 : 1),[9n,10n,11n]);
    assert.deepEqual(await counts(),{ accounts: 1,intents: 3,attempts: 3 });
    assert.equal((await managers[1].repository.getAccount()).nextNonce,"12");
    const repeats = await Promise.all(Array.from({ length: 9 },(_,index) => managers[index % 3].prepareDeliveryTransaction(jobs[0].deliveryJobId)));
    assert.ok(repeats.every(value => value.created === false));
    assert.ok(repeats.every(value => value.attempt.rawSignedTransaction === signed[0].attempt.rawSignedTransaction));
    assert.deepEqual(await counts(),{ accounts: 1,intents: 3,attempts: 3 });
  } finally { await Promise.all(fresh.map(client => client.end())); }
});

test("concurrent first preparation of the same READY job reserves exactly one nonce", async () => {
  const fresh = createDatabasePool(config);
  try {
    const managers = [managerFor(),managerFor(fresh)];
    const results = await Promise.all(Array.from({ length: 6 },(_,index) => managers[index % 2].prepareDeliveryTransaction(jobs[0].deliveryJobId)));
    assert.equal(results.filter(value => value.created).length,1);
    assert.equal(new Set(results.map(value => value.attempt.transactionHash)).size,1);
    assert.deepEqual(await counts(),{ accounts: 1,intents: 1,attempts: 1 });
    assert.equal((await managers[1].repository.getAccount()).nextNonce,"10");
  } finally { await fresh.end(); }
});

test("failure after SQL inserts before commit rolls back intent, attempt and nonce together", async () => {
  const manager = managerFor(pool,{ beforeSignedCommit: async () => { throw new Error("injected failure before signed commit"); } });
  await assert.rejects(manager.submitDelivery(jobs[0].deliveryJobId),/injected failure before signed commit/);
  assert.deepEqual(await counts(),{ accounts: 0,intents: 0,attempts: 0 }); assert.equal(h.calls.broadcast.length,0);
  const recovered = await managerFor().prepareDeliveryTransaction(jobs[0].deliveryJobId);
  assert.equal(recovered.attempt.nonce,"9");
});

test("durable allocator wins over RPC, safely advances to higher RPC pending, and never resets on restart", async () => {
  h.state.pendingNonce = (1n << 100n) + 1n;
  const first = await managerFor().prepareDeliveryTransaction(jobs[0].deliveryJobId);
  assert.equal(first.attempt.nonce,h.state.pendingNonce.toString());
  const fresh = createDatabasePool(config);
  try {
    h.state.pendingNonce = 0n;
    const second = await managerFor(fresh).prepareDeliveryTransaction(jobs[1].deliveryJobId);
    assert.equal(BigInt(second.attempt.nonce),BigInt(first.attempt.nonce) + 1n);
    h.state.pendingNonce = BigInt(second.attempt.nonce) + 10n;
    const third = await managerFor(fresh).prepareDeliveryTransaction(jobs[2].deliveryJobId);
    assert.equal(third.attempt.nonce,h.state.pendingNonce.toString());
    assert.equal((await managerFor(fresh).repository.getAccount()).nextNonce,(h.state.pendingNonce + 1n).toString());
    await assert.rejects(pool.query(`UPDATE ${accounts} SET next_nonce = 0`),/cannot regress/);
    assert.deepEqual((await managerFor(fresh).prepareDeliveryTransaction(jobs[0].deliveryJobId)).attempt,first.attempt);
  } finally { await fresh.end(); }
});

test("SIGNED survives broadcast failure, blocks later nonces, and can be explicitly broadcast unchanged", async () => {
  const original = await sourceState(pool,config.databaseSchema);
  const rpc = { ...h.rpc, async broadcast() { throw new Error("injected unavailable broadcaster"); } };
  const failure = managerFor(pool,{ rpc });
  await assert.rejects(failure.submitDelivery(jobs[0].deliveryJobId),/injected unavailable broadcaster/);
  const signed = await failure.repository.getTransactionAttempt(jobs[0].deliveryJobId);
  assert.equal(signed.status,"SIGNED"); assert.deepEqual(await counts(),{ accounts: 1,intents: 1,attempts: 1 });
  const manager = managerFor();
  await assert.rejects(manager.submitDelivery(jobs[1].deliveryJobId),{ code: "SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST" });
  await manager.prepareDeliveryTransaction(jobs[1].deliveryJobId);
  await assert.rejects(manager.broadcastPreparedTransaction(jobs[1].deliveryJobId),{ code: "EARLIER_SIGNED_TRANSACTION_BLOCKS_BROADCAST" });
  const broadcast = await manager.broadcastPreparedTransaction(jobs[0].deliveryJobId);
  assert.equal(broadcast.attempt.status,"BROADCAST"); assert.equal(broadcast.attempt.rawSignedTransaction,signed.rawSignedTransaction);
  assert.equal(broadcast.attempt.transactionHash,signed.transactionHash);
  assert.equal((await manager.broadcastPreparedTransaction(jobs[0].deliveryJobId)).broadcast,false);
  await manager.broadcastPreparedTransaction(jobs[1].deliveryJobId);
  assert.equal(h.calls.broadcast.length,2);
  assert.deepEqual(await sourceState(pool,config.databaseSchema),original); assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
});

test("RPC wrong hash fails closed with one unchanged SIGNED attempt and no successful broadcast timestamp", async () => {
  const manager = managerFor(pool,{ rpc: { ...h.rpc, async broadcast() { return fixtureHash(999); } } });
  await assert.rejects(manager.submitDelivery(jobs[0].deliveryJobId),{ code: "RPC_TRANSACTION_HASH_MISMATCH" });
  const attempt = await manager.repository.getTransactionAttempt(jobs[0].deliveryJobId);
  assert.equal(attempt.status,"SIGNED"); assert.equal(attempt.broadcastAt,null);
  assert.deepEqual(await counts(),{ accounts: 1,intents: 1,attempts: 1 });
});

test("migration reruns preserve historical direct submissions and production Relayer skips them without fabricating attempts", async () => {
  const legacy = createRelaySubmissionRepository({ config,pool,queue });
  const id = jobs[0].deliveryJobId;
  const encoded = await encodeDestinationSubmission(await queue.getDeliveryPackage(id),{ validatorSets: config.validatorSets });
  const historical = await legacy.recordSubmission({ deliveryJobId: id,encoded,transactionHash: fixtureHash(888) });
  const migrations = await applyMigrations(pool,config.databaseSchema);
  assert.equal(migrations.at(-1),"011_transaction_manager.sql"); await applyMigrations(pool,config.databaseSchema);
  const manager = managerFor();
  assert.deepEqual((await manager.prepareDeliveryTransaction(id)).historicalSubmission,historical);
  assert.deepEqual(await counts(),{ accounts: 0,intents: 0,attempts: 0 });
  const relayer = createSingleRelayer({ config,queue,repository: legacy,transactionManager: manager });
  assert.equal((await relayer.runOnce()).submitted,2);
  assert.equal((await relayer.runOnce()).selected,0);
  assert.deepEqual(await legacy.getSubmission(id),historical);
  assert.equal(await manager.repository.getTransactionAttempt(id),null);
  assert.deepEqual(await counts(),{ accounts: 1,intents: 2,attempts: 2 });
});

test("SQL guards signed fields and terminal outcomes; fresh clients recover all four states", async () => {
  const manager = managerFor(); const id = jobs[0].deliveryJobId;
  await manager.prepareDeliveryTransaction(id);
  for (const limit of [0,1001,"1",1.5]) await assert.rejects(manager.repository.listTransactions({ status: "SIGNED",limit }),{ code: "INVALID_DELIVERY_LIMIT" });
  await assert.rejects(manager.repository.listTransactions({ status: "UNKNOWN" }),{ code: "INVALID_TRANSACTION_STATUS" });
  for (const assignment of ["nonce = nonce + 1","gas_limit = gas_limit + 1","max_fee_per_gas = max_fee_per_gas + 1",
    "max_priority_fee_per_gas = max_priority_fee_per_gas + 1",`raw_signed_transaction = '0x02ff'`,
    `transaction_hash = '${fixtureHash(99)}'`,"attempt_number = 1"]) {
    await assert.rejects(pool.query(`UPDATE ${attempts} SET ${assignment} WHERE delivery_job_id = $1`,[id]),/immutable/);
  }
  for (const assignment of ["calldata = '0xffff'",`destination_gateway = '${jobs[0].destinationGateway}'`,
    "chain_id = 3001",`sender_address = '0x${"22".repeat(20)}'`,`package_digest = '${fixtureHash(99)}'`]) {
    await assert.rejects(pool.query(`UPDATE ${intents} SET ${assignment} WHERE delivery_job_id = $1`,[id]),/immutable/);
  }
  await assert.rejects(pool.query(`DELETE FROM ${attempts}`),/immutable/);
  await assert.rejects(pool.query(`DELETE FROM ${intents}`),/immutable/);
  await assert.rejects(pool.query(`DELETE FROM ${accounts}`),/immutable/);
  const signed = await manager.repository.getTransaction(id);
  const fresh = createDatabasePool(config);
  try {
    assert.deepEqual(await managerFor(fresh).repository.getTransaction(id),signed);
    const broadcast = await manager.broadcastPreparedTransaction(id);
    assert.deepEqual((await managerFor(fresh).repository.getTransaction(id)).attempt,broadcast.attempt);
    const outcome = { transactionHash: broadcast.attempt.transactionHash,blockNumber: 100n,blockHash: fixtureHash(1000),head: 102n,status: 1 };
    const confirmed = await manager.repository.recordOutcome(id,outcome);
    assert.deepEqual(await managerFor(fresh).repository.getTransaction(id),confirmed);
    const revertedId = jobs[1].deliveryJobId;
    const other = await manager.submitDelivery(revertedId);
    const reverted = await manager.repository.recordOutcome(revertedId,{ ...outcome,transactionHash: other.attempt.transactionHash,status: 0 });
    assert.deepEqual(await managerFor(fresh).repository.getTransaction(revertedId),reverted);
    for (const assignment of ["status = 'SIGNED'","status = 'BROADCAST'",`receipt_block_hash = '${fixtureHash(99)}'`,"receipt_block_number = 99","confirmed_head = 103"]) {
      await assert.rejects(pool.query(`UPDATE ${attempts} SET ${assignment} WHERE delivery_job_id = $1`,[id]),/illegal transaction status transition/);
    }
    await assert.rejects(pool.query(`UPDATE ${attempts} SET status = 'SIGNED' WHERE delivery_job_id = $1`,[revertedId]),/illegal transaction status transition/);
    assert.ok(!JSON.stringify(confirmed).includes(config.privateKey));
  } finally { await fresh.end(); }
});

test("strict reads reject corrupted raw bytes, hashes and nonce state even when verification fixtures bypass SQL guards", async () => {
  const manager = managerFor(); const id = jobs[0].deliveryJobId;
  await manager.prepareDeliveryTransaction(id);
  for (const kind of ["raw","nonce"]) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE ${kind === "raw" ? attempts : accounts} DISABLE TRIGGER ${kind === "raw" ? "transaction_attempts_guard" : "transaction_accounts_guard"}`);
      if (kind === "raw") await client.query(`UPDATE ${attempts} SET raw_signed_transaction = '0x02ff' WHERE delivery_job_id = $1`,[id]);
      else await client.query(`UPDATE ${accounts} SET next_nonce = 0`);
      const transactionPool = { async connect() { return { query: client.query.bind(client),release() {} }; },query: client.query.bind(client) };
      // Query inside the already-open fixture transaction without nesting BEGIN/COMMIT.
      const fixturePool = { ...transactionPool,async connect() { return { async query(sql,values) {
        if (["BEGIN","COMMIT","ROLLBACK"].includes(sql)) return { rows: [] };
        return client.query(sql,values);
      },release() {} }; } };
      const repository = createTransactionRepository({ config,pool: fixturePool,resolveIntent: jobId => manager.resolveIntent(jobId) });
      await assert.rejects(repository.getTransaction(id),{ code: kind === "raw" ? "CORRUPTED_SIGNED_TRANSACTION" : "NONCE_STATE_REGRESSION" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  }
});
