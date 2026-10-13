import assert from "node:assert/strict";
import { after,before,beforeEach,test } from "node:test";
import { applyMigrations,createDatabasePool,resetIndexerTables,tableName } from "../src/db.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { verifySignedTransaction } from "../src/transaction-manager/transaction.mjs";
import { transactionConfig,transactionHarness } from "./helpers/transaction-fixtures.mjs";
import { persistReadyTransactionFixture } from "./helpers/transaction-database-fixtures.mjs";
import { destinationRpcFixture,transactionBody,rpcTimeout } from "./helpers/destination-rpc-fixtures.mjs";
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
function manager({ db = pool,hooks = {},rpc = destination.rpc,account } = {}) {
  return createTransactionManager({ config,pool: db,queue: createDeliveryRepository({ config,pool: db }),rpc,hooks,account,clock: h.clock });
}
function crashOnce() { let active = true; return async () => { if (active) { active = false; throw Object.assign(new Error("controlled database checkpoint"),{ code: "TEST_CHECKPOINT" }); } }; }
async function mine(id,attemptId,status = 1) {
  const stored = await reader.repository.getTransaction(id); const winner = stored.attempts.find(a => a.attemptId === attemptId);
  destination.receipts.set(winner.transactionHash,{ transactionHash: winner.transactionHash,blockNumber: "0x64",blockHash: fixtureHash(1100),status: status ? "0x1" : "0x0" });
  destination.transactions.set(winner.transactionHash,transactionBody(stored.intent,winner,100n,fixtureHash(1100)));
  destination.nodes.forEach(node => { node.head = 102n; node.latestNonce = BigInt(stored.intent.nonce) + 1n; });
}

const immutableAttemptFields = ["attemptId","attemptNumber","replacementOfAttemptId","nonce","gasLimit",
  "maxFeePerGas","maxPriorityFeePerGas","rawSignedTransaction","transactionHash","createdAt"];
function sameSignedAttempt(before,after) {
  for (const field of immutableAttemptFields) assert.equal(after[field],before[field]);
}
async function replacementWithPendingParent() {
  const id = jobs[0].deliveryJobId;
  const parent = await reader.submitDelivery(id); h.advance(config.replacementAfterMs);
  const replacement = await reader.prepareReplacement(id);
  assert.equal(replacement.created,true); assert.equal(replacement.attempt.status,"SIGNED");
  assert.equal(replacement.attempt.broadcastAttemptCount,"0");
  assert.equal((await destination.rpc.transaction(parent.attempt.transactionHash)).blockNumber,null);
  assert.equal(destination.receipts.has(parent.attempt.transactionHash),false);
  return { id,parent,replacement,account: await reader.repository.getAccount() };
}

test("a fresh client broadcasts the exact persisted replacement through failover while its parent remains pending", async () => {
  const sourceBefore = await sourceState(pool,config.databaseSchema);
  const { id,parent,replacement,account } = await replacementWithPendingParent();
  assert.ok(Date.parse(replacement.intent.nextActionAt) > h.clock.now());
  assert.equal((await reader.repository.getBroadcastEvents(id)).filter(event => event.attemptId === replacement.attempt.attemptId).length,0);
  const fresh = createDatabasePool(config); destination.nodes[0].available = false;
  try {
    const rpc = { ...destination.restart().rpc,
      async estimateGas() { assert.fail("durable replacement recovery must not estimate gas"); },
      async fees() { assert.fail("durable replacement recovery must not resolve fees"); } };
    const recovered = manager({ db: fresh,rpc,account: { address: config.relayerAddress,
      async signTransaction() { assert.fail("durable replacement recovery must not re-sign"); } } });
    const persisted = await recovered.repository.getTransaction(id);
    sameSignedAttempt(replacement.attempt,persisted.attempt);
    const result = await recovered.recoverTransactionsOnce({ deliveryJobId: id });
    assert.equal(result.rebroadcast,1); assert.equal(result.results[0].acceptedEndpointLabel,"rpc-1");
    const stored = await recovered.repository.getTransaction(id);
    assert.equal(stored.attempt.status,"BROADCAST");
    assert.deepEqual(stored.attempts.map(attempt => attempt.attemptNumber),[0,1]);
    sameSignedAttempt(replacement.attempt,stored.attempt); sameSignedAttempt(parent.attempt,stored.attempts[0]);
    assert.deepEqual(await recovered.repository.getAccount(),account);
    assert.deepEqual(destination.nodes[0].broadcasts,[parent.attempt.rawSignedTransaction]);
    assert.deepEqual(destination.nodes[1].broadcasts,[replacement.attempt.rawSignedTransaction]);
    assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).rebroadcast,0);
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,2);
    await mine(id,replacement.attempt.attemptId);
    assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).finalized,1);
    const final = await recovered.repository.getTransaction(id);
    assert.equal(final.intent.winningAttemptId,replacement.attempt.attemptId);
    assert.equal(final.intent.status,"CONFIRMED"); assert.equal(final.attempts.length,2);
    assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore);
    assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
  } finally { await fresh.end(); }
});

test("a replacement's pre-send marker recovers without confusing the visible pending parent", async () => {
  const { id,replacement,account } = await replacementWithPendingParent();
  const stopped = manager({ hooks: { afterBroadcastStart: crashOnce() } });
  await assert.rejects(stopped.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
  const marker = (await reader.repository.getBroadcastEvents(id)).find(event => event.attemptId === replacement.attempt.attemptId);
  assert.equal(marker.completedAt,null); assert.equal(destination.transactions.has(replacement.attempt.transactionHash),false);
  const fresh = createDatabasePool(config);
  try {
    const recovered = manager({ db: fresh,rpc: destination.restart().rpc });
    assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).rebroadcast,1);
    sameSignedAttempt(replacement.attempt,(await recovered.repository.getTransaction(id)).attempt);
    assert.equal((await recovered.repository.getBroadcastEvents(id)).find(event => event.eventId === marker.eventId).resultClass,"RECONCILED");
    assert.deepEqual(await recovered.repository.getAccount(),account);
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,2);
  } finally { await fresh.end(); }
});

test("historical journal reconciliation advances the version before sending a persisted replacement", async () => {
  const id = jobs[0].deliveryJobId; await reader.submitDelivery(id); h.advance(config.replacementAfterMs);
  await assert.rejects(manager({ hooks: { afterBroadcastStart: crashOnce() } }).rebroadcastTransaction(id),{ code: "TEST_CHECKPOINT" });
  h.advance(config.rebroadcastIntervalMs); const replacement = await reader.prepareReplacement(id);
  const before = await reader.repository.getRecoverySnapshot(id); const account = await reader.repository.getAccount();
  const fresh = createDatabasePool(config);
  try {
    const recovered = manager({ db: fresh,rpc: destination.restart().rpc });
    assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).rebroadcast,1);
    const after = await recovered.repository.getRecoverySnapshot(id);
    assert.ok(BigInt(after.version) > BigInt(before.version));
    assert.ok(after.broadcastEvents.filter(event => event.attemptId === replacement.attempts[0].attemptId).every(event => event.completedAt !== null));
    sameSignedAttempt(replacement.attempt,after.attempt); assert.equal(after.attempts.length,2);
    assert.deepEqual(await recovered.repository.getAccount(),account);
  } finally { await fresh.end(); }
});

for (const confirmed of [false,true]) {
  test(`a fresh client suppresses the replacement for an old ${confirmed ? "confirmed" : "unconfirmed"} canonical receipt`, async () => {
    const { id,parent,replacement,account } = await replacementWithPendingParent();
    await mine(id,parent.attempt.attemptId); destination.nodes.forEach(node => { node.head = confirmed ? 102n : 100n; });
    const fresh = createDatabasePool(config);
    try {
      const recovered = manager({ db: fresh,rpc: destination.restart().rpc });
      const result = await recovered.recoverTransactionsOnce({ deliveryJobId: id });
      assert.equal(result.results[0].action,confirmed ? "FINALIZED" : "RECEIPT_UNCONFIRMED");
      const stored = await recovered.repository.getTransaction(id);
      assert.equal(stored.intent.status,confirmed ? "CONFIRMED" : "PENDING");
      if (confirmed) { assert.equal(stored.intent.winningAttemptId,parent.attempt.attemptId); assert.equal(stored.winningAttempt.receiptBlockNumber,"100"); }
      sameSignedAttempt(replacement.attempt,stored.attempt); assert.equal(stored.attempt.broadcastAttemptCount,"0");
      assert.equal((await recovered.repository.getBroadcastEvents(id)).some(event => event.attemptId === replacement.attempt.attemptId),false);
      assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,1);
      assert.deepEqual(await recovered.repository.getAccount(),account);
    } finally { await fresh.end(); }
  });
}

test("a parent mined during visibility reads is reconciled before nonce consumption can stop replacement recovery", async () => {
  const { id,parent,replacement,account } = await replacementWithPendingParent();
  const fresh = createDatabasePool(config); const rpc = destination.restart().rpc;
  let advanced = false;
  try {
    const recoveringRpc = { ...rpc,async transaction(hash) {
      const transaction = await rpc.transaction(hash);
      if (!advanced && hash === parent.attempt.transactionHash) {
        advanced = true; await mine(id,parent.attempt.attemptId);
      }
      return transaction;
    } };
    const recovered = manager({ db: fresh,rpc: recoveringRpc });
    const result = await recovered.recoverTransactionsOnce({ deliveryJobId: id });
    assert.equal(result.results[0].action,"RECEIPT_UNCONFIRMED","receipt recheck must use the original confirmation head");
    const observed = await recovered.repository.getTransaction(id);
    assert.equal(observed.intent.status,"PENDING"); assert.equal(observed.intent.retryStoppedAt,null);
    sameSignedAttempt(replacement.attempt,observed.attempt);
    assert.equal((await recovered.repository.getBroadcastEvents(id)).some(event => event.attemptId === replacement.attempt.attemptId),false);
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,1);
    assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).finalized,1);
    assert.equal((await recovered.repository.getTransaction(id)).intent.winningAttemptId,parent.attempt.attemptId);
    assert.deepEqual(await recovered.repository.getAccount(),account);
  } finally { await fresh.end(); }
});

test("a fresh client's replacement response-loss recovery keeps its fixed head and defers finalization", async () => {
  const sourceBefore = await sourceState(pool,config.databaseSchema);
  const { id,parent,replacement,account } = await replacementWithPendingParent();
  const fresh = createDatabasePool(config); const rpc = destination.restart().rpc; const heads = [];
  destination.nodes[0].faults.set("eth_sendRawTransaction",async ({ forward }) => {
    await forward(); await mine(id,replacement.attempt.attemptId); throw rpcTimeout();
  });
  destination.nodes[1].alreadyKnown = true;
  const readView = rpc.readView; let viewReads = 0;
  rpc.readView = async () => { viewReads++; return readView(); };
  rpc.estimateGas = async () => assert.fail("response-loss recovery must not estimate gas");
  rpc.fees = async () => assert.fail("response-loss recovery must not resolve fees");
  try {
    const recovered = manager({ db: fresh,rpc,hooks: { afterReceiptObserved: ({ head }) => { heads.push(head); } },
      account: { address: config.relayerAddress,async signTransaction() { assert.fail("response-loss recovery must not re-sign"); } } });
    const result = await recovered.recoverTransactionsOnce({ deliveryJobId: id });
    assert.equal(result.rebroadcast,1); assert.equal(result.finalized,0);
    assert.equal(viewReads,1); assert.deepEqual(heads,[100n]);
    const observed = await recovered.repository.getTransaction(id);
    assert.equal(observed.intent.status,"PENDING"); assert.equal(observed.intent.winningAttemptId,null);
    assert.equal(observed.attempt.status,"BROADCAST"); assert.equal(observed.attempt.receiptBlockNumber,null);
    assert.equal(observed.attempts.length,2); sameSignedAttempt(replacement.attempt,observed.attempt);
    sameSignedAttempt(parent.attempt,observed.attempts[0]);
    assert.deepEqual(destination.nodes[0].broadcasts,[parent.attempt.rawSignedTransaction,replacement.attempt.rawSignedTransaction]);
    assert.deepEqual(destination.nodes[1].broadcasts,[replacement.attempt.rawSignedTransaction]);
    assert.deepEqual(await recovered.repository.getAccount(),account);
    assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).finalized,1);
    assert.equal(viewReads,2); assert.deepEqual(heads,[100n,102n]);
    const final = await recovered.repository.getTransaction(id);
    assert.equal(final.intent.status,"CONFIRMED"); assert.equal(final.intent.winningAttemptId,replacement.attempt.attemptId);
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,3);
    assert.deepEqual(await recovered.repository.getAccount(),account);
    assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore);
    assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
  } finally { await fresh.end(); }
});

test("independent clients serialize recovery of a pending-parent replacement without branching", async () => {
  const { id,replacement,account } = await replacementWithPendingParent(); const fresh = createDatabasePool(config);
  const reached = Promise.withResolvers(); const resume = Promise.withResolvers();
  const stopped = manager({ hooks: { afterBroadcastStart: async () => { reached.resolve(); await resume.promise; } } });
  const active = stopped.recoverTransactionsOnce({ deliveryJobId: id });
  try {
    await Promise.race([reached.promise,active.then(() => assert.fail("recovery did not reach its committed marker barrier"))]);
    const other = await manager({ db: fresh,rpc: destination.restart().rpc }).recoverTransactionsOnce({ deliveryJobId: id });
    assert.equal(other.results[0].reason,"TRANSACTION_RECOVERY_BUSY");
    resume.resolve(); assert.equal((await active).rebroadcast,1);
    const stored = await reader.repository.getTransaction(id); sameSignedAttempt(replacement.attempt,stored.attempt);
    assert.deepEqual(stored.attempts.map(attempt => attempt.attemptNumber),[0,1]);
    assert.deepEqual(await reader.repository.getAccount(),account); assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,2);
  } finally { resume.resolve(); await active.catch(() => {}); await fresh.end(); }
});

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
