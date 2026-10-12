import assert from "node:assert/strict";
import { after,before,beforeEach,test } from "node:test";
import { applyMigrations,createDatabasePool,resetIndexerTables,tableName } from "../src/db.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { verifySignedTransaction } from "../src/transaction-manager/transaction.mjs";
import { transactionConfig,transactionHarness } from "./helpers/transaction-fixtures.mjs";
import { persistReadyTransactionFixture } from "./helpers/transaction-database-fixtures.mjs";
import { destinationRpcFixture,transactionBody } from "./helpers/destination-rpc-fixtures.mjs";
import { fixtureHash } from "./helpers/delivery-fixtures.mjs";
import { sourceState } from "../../validator/test/helpers/four-process.mjs";

const config = transactionConfig({ DATABASE_URL: process.env.DATABASE_URL,
  INDEXER_DB_SCHEMA: `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_recovery`,
  CHAIN_B_RPC_URLS: '["http://127.0.0.1:9545","http://127.0.0.1:9546"]' });
const pool = createDatabasePool(config); const queue = createDeliveryRepository({ config,pool });
const eventTable = tableName(config.databaseSchema,"transaction_broadcast_events");
const attemptTable = tableName(config.databaseSchema,"transaction_attempts");
let h; let jobs; let destination; let reader;
before(async () => { await applyMigrations(pool,config.databaseSchema); });
beforeEach(async () => {
  await resetIndexerTables(pool,config.databaseSchema); await persistReadyTransactionFixture({ config,pool });
  jobs = await queue.listReadyDeliveryJobs(); h = await transactionHarness({ config });
  destination = destinationRpcFixture({ config,async onBroadcast(raw) {
    const attempt = (await pool.query(`SELECT * FROM ${attemptTable} WHERE raw_signed_transaction = $1`,[raw])).rows[0];
    assert.ok(attempt); const stored = await reader.repository.getTransaction(attempt.delivery_job_id);
    const journal = await reader.repository.getBroadcastEvents(attempt.delivery_job_id);
    assert.ok(journal.some(e => e.attemptId === attempt.attempt_id && e.endpointLabel !== null && e.completedAt === null),"committed endpoint marker must be visible before every raw send");
    const exact = stored.attempts.find(a => a.attemptId === attempt.attempt_id); await verifySignedTransaction(stored.intent,exact);
    return transactionBody(stored.intent,exact);
  } }); reader = manager();
});
after(async () => { await pool.end(); });
function manager({ db = pool,hooks = {},rpc = destination.rpc } = {}) {
  return createTransactionManager({ config,pool: db,queue: createDeliveryRepository({ config,pool: db }),rpc,hooks,clock: h.clock });
}
function crashOnce() { let active = true; return async () => { if (active) { active = false; throw Object.assign(new Error("controlled database checkpoint"),{ code: "TEST_CHECKPOINT" }); } }; }
async function mine(id,attemptId,status = 1) {
  const stored = await reader.repository.getTransaction(id); const winner = stored.attempts.find(a => a.attemptId === attemptId);
  destination.receipts.set(winner.transactionHash,{ transactionHash: winner.transactionHash,blockNumber: "0x64",blockHash: fixtureHash(1100),status: status ? "0x1" : "0x0" });
  destination.transactions.set(winner.transactionHash,transactionBody(stored.intent,winner,100n,fixtureHash(1100)));
  destination.nodes.forEach(node => { node.head = 102n; node.latestNonce = BigInt(stored.intent.nonce) + 1n; });
}

test("journal markers survive restart, sequence is unique, history is immutable and migration preserves artifacts", async () => {
  const id = jobs[0].deliveryJobId; const before = await sourceState(pool,config.databaseSchema);
  const stopped = manager({ hooks: { afterBroadcastStart: crashOnce() } }); const signed = await stopped.prepareDeliveryTransaction(id);
  const account = await stopped.repository.getAccount(); await assert.rejects(stopped.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
  const unresolved = await stopped.repository.getBroadcastEvents(id); assert.equal(unresolved.length,1); assert.equal(unresolved[0].completedAt,null);
  const fresh = createDatabasePool(config);
  try {
    const recovered = manager({ db: fresh }); assert.deepEqual(await recovered.repository.getBroadcastEvents(id),unresolved);
    assert.equal((await recovered.recoverTransactionsOnce()).rebroadcast,1);
    const stored = await recovered.repository.getTransaction(id);
    assert.equal(stored.attempt.rawSignedTransaction,signed.attempt.rawSignedTransaction); assert.equal(stored.attempt.transactionHash,signed.attempt.transactionHash);
    assert.deepEqual(await recovered.repository.getAccount(),account);
    const events = await recovered.repository.getBroadcastEvents(id);
    assert.deepEqual(events.map(e => e.broadcastSequence),["1","2","3"]); assert.equal(events[0].resultClass,"RECONCILED");
    await assert.rejects(pool.query(`UPDATE ${eventTable} SET endpoint_label = 'rpc-9' WHERE event_id = $1`,[events[2].eventId]),/immutable/);
    await assert.rejects(pool.query(`DELETE FROM ${eventTable} WHERE event_id = $1`,[events[0].eventId]),/history/);
    await applyMigrations(pool,config.databaseSchema); assert.deepEqual(await recovered.repository.getBroadcastEvents(id),events);
    assert.deepEqual(await sourceState(pool,config.databaseSchema),before); assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
  } finally { await fresh.end(); }
});

test("accepted transaction with missing endpoint result is reconciled by a fresh client without rebroadcast", async () => {
  const id = jobs[0].deliveryJobId; const stopped = manager({ hooks: { afterEndpointResult: crashOnce() } });
  const first = await stopped.prepareDeliveryTransaction(id); await assert.rejects(stopped.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
  assert.equal((await stopped.repository.getTransaction(id)).attempt.status,"SIGNED");
  const snapshot = await stopped.repository.getRecoverySnapshot(id); destination.nodes.forEach(node => { node.available = false; });
  assert.equal((await reader.recoverTransactionsOnce()).results[0].reason,"RPC_UNAVAILABLE");
  assert.deepEqual(await reader.repository.getRecoverySnapshot(id),snapshot);
  destination.nodes[1].available = true; const fresh = createDatabasePool(config);
  try {
    const recovered = manager({ db: fresh,rpc: destination.restart().rpc });
    assert.equal((await recovered.recoverTransactionsOnce()).reconciled,1);
    const stored = await recovered.repository.getTransaction(id); assert.equal(stored.attempt.status,"BROADCAST");
    assert.equal(stored.attempt.rawSignedTransaction,first.attempt.rawSignedTransaction); assert.equal(stored.attempts.length,1);
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,1);
  } finally { await fresh.end(); }
});

test("finalization interruption rolls back winner, receipt and intent atomically and a fresh process retries", async () => {
  const id = jobs[0].deliveryJobId; const first = await reader.submitDelivery(id); await mine(id,first.attempt.attemptId,0);
  const before = await reader.repository.getTransaction(id);
  const stopped = manager({ hooks: { beforeOutcomeCommit: crashOnce() } });
  await assert.rejects(stopped.recoverTransactionsOnce(),{ code: "TEST_CHECKPOINT" });
  assert.deepEqual(await reader.repository.getTransaction(id),before);
  assert.equal((await reader.recoverTransactionsOnce()).finalized,1);
  const final = await reader.repository.getTransaction(id); assert.equal(final.intent.status,"REVERTED"); assert.equal(final.intent.winningAttemptId,first.attempt.attemptId);
  assert.equal((await reader.recoverTransactionsOnce()).scanned,0); assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,1);
});

test("replacement ambiguity considers the old winner without branching or changing nonce", async () => {
  const id = jobs[0].deliveryJobId; const first = await reader.submitDelivery(id); h.advance(config.replacementAfterMs);
  const next = await reader.prepareReplacement(id); const account = await reader.repository.getAccount();
  const stopped = manager({ hooks: { afterBroadcastStart: crashOnce() } }); await assert.rejects(stopped.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
  await mine(id,first.attempt.attemptId);
  assert.equal((await reader.recoverTransactionsOnce()).finalized,1);
  const final = await reader.repository.getTransaction(id); assert.equal(final.intent.winningAttemptId,first.attempt.attemptId);
  assert.equal(final.attempts.length,2); assert.equal(final.attempt.rawSignedTransaction,next.attempt.rawSignedTransaction);
  assert.deepEqual(await reader.repository.getAccount(),account);
});

test("concurrent recovery uses one send; post-read version changes reject stale writeback", async () => {
  const id = jobs[0].deliveryJobId; await reader.prepareDeliveryTransaction(id);
  const fresh = createDatabasePool(config);
  try {
    const other = manager({ db: fresh,rpc: destination.restart().rpc });
    const results = await Promise.all([reader.recoverTransactionsOnce(),other.recoverTransactionsOnce()]);
    assert.equal(results.reduce((sum,r) => sum + r.rebroadcast,0),1); assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,1);
    const snapshot = await reader.repository.getRecoverySnapshot(id); await other.repository.scheduleRetry(id);
    await assert.rejects(reader.repository.applyRecoveryObservation(snapshot,{ knownAttempts: [snapshot.attempt.attemptId] }),{ code: "RECOVERY_STATE_CHANGED" });
  } finally { await fresh.end(); }
});

test("interruption after intent insert cannot commit a ghost nonce or partial attempt", async () => {
  const id = jobs[0].deliveryJobId;
  const stopped = manager({ hooks: { afterIntentInsert: crashOnce() } });
  await assert.rejects(stopped.prepareDeliveryTransaction(id),{ code: "TEST_CHECKPOINT" });
  assert.equal(await reader.repository.getTransaction(id),null); assert.equal(await reader.repository.getAccount(),null);
  assert.equal((await reader.prepareDeliveryTransaction(id)).attempt.nonce,"9");
});
