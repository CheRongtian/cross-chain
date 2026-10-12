import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { applyMigrations, createDatabasePool, resetIndexerTables, tableName } from "../src/db.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { createRelayerLeaseRepository } from "../src/relayer/leases.mjs";
import { createRelayerWorker } from "../src/relayer/service.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { verifySignedTransaction } from "../src/transaction-manager/transaction.mjs";
import { transactionConfig, transactionHarness } from "./helpers/transaction-fixtures.mjs";
import { persistReadyTransactionFixture } from "./helpers/transaction-database-fixtures.mjs";
import { destinationRpcFixture, transactionBody } from "./helpers/destination-rpc-fixtures.mjs";
import { sourceState } from "../../validator/test/helpers/four-process.mjs";

const config = transactionConfig({ DATABASE_URL: process.env.DATABASE_URL,
  INDEXER_DB_SCHEMA: `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_leases`,
  CHAIN_B_RPC_URLS: '["http://127.0.0.1:9545","http://127.0.0.1:9546"]',RELAYER_LEASE_MS: "60000" });
const configB = { ...config,workerId: "relayer-b" };
const pool = createDatabasePool(config); const poolB = createDatabasePool(configB);
const queue = createDeliveryRepository({ config,pool }); const queueB = createDeliveryRepository({ config: configB,pool: poolB });
const leases = createRelayerLeaseRepository({ config,pool,queue });
const leasesB = createRelayerLeaseRepository({ config: configB,pool: poolB,queue: queueB });
const leaseTable = tableName(config.databaseSchema,"relayer_job_leases");
const intentTable = tableName(config.databaseSchema,"transaction_intents");
const attemptTable = tableName(config.databaseSchema,"transaction_attempts");
let jobs; let h; let destination; let reader;
before(async () => { await applyMigrations(pool,config.databaseSchema); });
beforeEach(async () => {
  await resetIndexerTables(pool,config.databaseSchema); await persistReadyTransactionFixture({ config,pool });
  jobs = await queue.listReadyDeliveryJobs(); h = await transactionHarness({ config });
  destination = destinationRpcFixture({ config,async onBroadcast(raw) {
    const row = (await pool.query(`SELECT delivery_job_id,attempt_id FROM ${attemptTable} WHERE raw_signed_transaction = $1`,[raw])).rows[0];
    assert.ok(row,"another DB client must see committed signed bytes before send");
    const stored = await reader.repository.getTransaction(row.delivery_job_id);
    const attempt = stored.attempts.find(a => a.attemptId === row.attempt_id); await verifySignedTransaction(stored.intent,attempt);
    return transactionBody(stored.intent,attempt);
  } }); reader = manager();
});
after(async () => { await Promise.all([pool.end(),poolB.end()]); });
function manager({ cfg = config,db = pool,rpc = destination.rpc,...options } = {}) {
  return createTransactionManager({ config: cfg,pool: db,queue: createDeliveryRepository({ config: cfg,pool: db }),rpc,clock: h.clock,...options });
}
async function expire(id) {
  // Verification-only controlled expiry; production has no force-steal API.
  await pool.query(`UPDATE ${leaseTable} SET lease_expires_at = clock_timestamp() - interval '1 millisecond' WHERE delivery_job_id = $1`,[id]);
}
async function counts() {
  return (await pool.query(`SELECT (SELECT COUNT(*) FROM ${intentTable})::int AS intents,
    (SELECT COUNT(*) FROM ${attemptTable})::int AS attempts`)).rows[0];
}

test("migration reruns preserve lease history; independent clients contend for one owner", async () => {
  const id = jobs[0].deliveryJobId;
  await leases.withWorker(async a => leasesB.withWorker(async b => {
    const claims = await Promise.all([leases.tryAcquireLease(id,a),leasesB.tryAcquireLease(id,b)]);
    assert.equal(claims.filter(Boolean).length,1);
    const first = claims.find(Boolean); const repo = first.ownerId === a.workerId ? leases : leasesB;
    const session = first.ownerId === a.workerId ? a : b;
    assert.deepEqual(await repo.tryAcquireLease(id,session),first);
    await applyMigrations(pool,config.databaseSchema); assert.deepEqual(await repo.getLease(id),first);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${leaseTable} WHERE delivery_job_id = $1`,[id])).rows[0].count,1);
    await assert.rejects(pool.query(`UPDATE ${leaseTable} SET fencing_token = 0 WHERE delivery_job_id = $1`,[id]));
    await assert.rejects(pool.query(`DELETE FROM ${leaseTable} WHERE delivery_job_id = $1`,[id]),/history/);
  }));
  assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
});

test("DB time, renewal, stale rejection and release/reacquire retain monotonic tokens across clients", async () => {
  const id = jobs[0].deliveryJobId; let old;
  await leases.withWorker(async a => leasesB.withWorker(async b => {
    old = await leases.tryAcquireLease(id,a);
    // A different process clock cannot authoritatively expire a DB lease.
    h.advance(1000000000); assert.equal(await leasesB.tryAcquireLease(id,b),null);
    const renewed = await leases.renewLease(old); assert.equal(renewed.fencingToken,old.fencingToken);
    assert.ok(Date.parse(renewed.leaseExpiresAt) >= Date.parse(old.leaseExpiresAt));
    await assert.rejects(leasesB.renewLease({ ...old,ownerId: b.workerId,ownerSessionId: b.sessionId }),{ code: "STALE_FENCE" });
    await expire(id); const current = await leasesB.tryAcquireLease(id,b); assert.equal(current.fencingToken,"2");
    for (const action of [() => leases.renewLease(old),() => leases.releaseLease(old)]) await assert.rejects(action(),{ code: "STALE_FENCE" });
    const released = await leasesB.releaseLease(current); assert.deepEqual(await leasesB.releaseLease(current),released);
    const third = await leases.tryAcquireLease(id,a); assert.equal(third.fencingToken,"3");
    await leases.releaseLease(third); assert.equal((await leasesB.tryAcquireLease(id,b)).fencingToken,"4");
  }));
  const fresh = createDatabasePool(config);
  try {
    const restarted = createRelayerLeaseRepository({ config,pool: fresh,queue });
    assert.deepEqual(await restarted.getLease(id),await leases.getLease(id));
    await restarted.withWorker(async a => assert.equal(await restarted.tryAcquireLease(id,a),null));
  } finally { await fresh.end(); }
});

test("duplicate configured IDs fail fast without blocking distinct workers", async () => {
  const duplicate = createRelayerLeaseRepository({ config,pool: poolB,queue });
  await leases.withWorker(async a => {
    await assert.rejects(duplicate.withWorker(async () => {}),{ code: "RELAYER_WORKER_ALREADY_RUNNING" });
    await leasesB.withWorker(async b => {
      assert.notEqual(a.sessionId,b.sessionId); assert.notEqual(a.workerId,b.workerId);
      await leases.tryAcquireLease(jobs[0].deliveryJobId,a);
      const available = await leasesB.listClaimableJobs({ session: b });
      assert.equal(available.some(j => j.deliveryJobId === jobs[0].deliveryJobId),false);
      assert.ok(await leasesB.tryAcquireLease(available[0].deliveryJobId,b));
    });
  });
  await duplicate.withWorker(async () => {});
});

test("not-yet-due pending jobs do not fill the selection limit ahead of new work", async () => {
  const id = jobs[0].deliveryJobId;
  // Use the actual wall clock for retry scheduling, independent of the unit fixture clock.
  const active = manager({ clock: { now: Date.now } });
  const first = await active.submitDelivery(id);
  assert.equal(first.attempt.status,"BROADCAST");
  await leasesB.withWorker(async b => {
    const selected = await leasesB.listClaimableJobs({ session: b,limit: 1 });
    assert.equal(selected.length,1); assert.notEqual(selected[0].deliveryJobId,id);
  });
});

test("stale create/broadcast cannot mutate nonce or attempts; existing SIGNED identity survives takeover", async () => {
  const id = jobs[0].deliveryJobId; const beforeSource = await sourceState(pool,config.databaseSchema);
  await leases.withWorker(async a => leasesB.withWorker(async b => {
    const old = await leases.tryAcquireLease(id,a); await expire(id); const current = await leasesB.tryAcquireLease(id,b);
    await assert.rejects(reader.prepareDeliveryTransaction(id,{ fence: old }),{ code: "STALE_FENCE" });
    assert.deepEqual(await counts(),{ intents: 0,attempts: 0 }); assert.equal(await reader.repository.getAccount(),null);
    const active = manager({ cfg: configB,db: poolB });
    const results = await Promise.all(Array.from({ length: 4 },() => active.prepareDeliveryTransaction(id,{ fence: current })));
    assert.equal(results.filter(r => r.created).length,1); const signed = results[0]; const account = await active.repository.getAccount();
    await expire(id); const next = await leases.tryAcquireLease(id,a);
    const resumed = await reader.prepareDeliveryTransaction(id,{ fence: next });
    assert.deepEqual(resumed.attempt,signed.attempt); assert.deepEqual(resumed.intent,signed.intent);
    await assert.rejects(active.continueDeliveryTransactionOnce(id,{ fence: current }),{ code: "STALE_FENCE" });
    await assert.rejects(active.repository.broadcastPrepared(id,async () => { throw new Error("stale fence reached network"); },{ fence: current }),{ code: "STALE_FENCE" });
    assert.deepEqual(await reader.repository.getTransaction(id),{
      intent: signed.intent,attempt: signed.attempt,attempts: signed.attempts,winningAttempt: signed.winningAttempt });
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,0);
    destination.nodes[0].available = false;
    const sent = await reader.continueDeliveryTransactionOnce(id,{ fence: next });
    assert.equal(sent.acceptedEndpointLabel,"rpc-1"); assert.equal(sent.attempt.rawSignedTransaction,signed.attempt.rawSignedTransaction);
    assert.equal(sent.attempt.transactionHash,signed.attempt.transactionHash); assert.equal(sent.intent.senderAddress,signed.intent.senderAddress);
    assert.deepEqual(await reader.repository.getAccount(),account); assert.deepEqual(await counts(),{ intents: 1,attempts: 1 });
    assert.deepEqual(await leases.getLease(id),await leasesB.getLease(id));
  }));
  assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs); assert.deepEqual(await sourceState(pool,config.databaseSchema),beforeSource);
});

test("different current owners race preparation through the same account lock without a second nonce space", async () => {
  await leases.withWorker(async a => leasesB.withWorker(async b => {
    const idA = jobs[0].deliveryJobId; const idB = jobs[1].deliveryJobId;
    const fenceA = await leases.tryAcquireLease(idA,a); const fenceB = await leasesB.tryAcquireLease(idB,b);
    const active = manager({ cfg: configB,db: poolB });
    const candidates = [{ manager: reader,id: idA,fence: fenceA },{ manager: active,id: idB,fence: fenceB }];
    const prepared = await Promise.allSettled(candidates.map(c => c.manager.prepareDeliveryTransaction(c.id,{ fence: c.fence })));
    assert.equal(prepared.filter(result => result.status === "fulfilled").length,1);
    const winner = candidates[prepared.findIndex(result => result.status === "fulfilled")];
    const waiting = candidates[prepared.findIndex(result => result.status === "rejected")];
    assert.equal(prepared.find(result => result.status === "rejected").reason.code,"SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST");
    const first = await winner.manager.continueDeliveryTransactionOnce(winner.id,{ fence: winner.fence });
    const secondPrepared = await waiting.manager.prepareDeliveryTransaction(waiting.id,{ fence: waiting.fence });
    const second = await waiting.manager.continueDeliveryTransactionOnce(waiting.id,{ fence: waiting.fence });
    assert.equal(BigInt(second.intent.nonce),BigInt(first.intent.nonce) + 1n); assert.equal(second.intent.senderAddress,first.intent.senderAddress);
    assert.equal(second.attempt.rawSignedTransaction,secondPrepared.attempt.rawSignedTransaction);
    assert.equal((await reader.repository.getAccount()).nextNonce,(BigInt(second.intent.nonce) + 1n).toString());
    assert.deepEqual(await counts(),{ intents: 2,attempts: 2 });
  }));
});

test("fence is rechecked after RPC and inside the signed commit boundary", async () => {
  const id = jobs[0].deliveryJobId;
  await leases.withWorker(async a => leasesB.withWorker(async b => {
    const old = await leases.tryAcquireLease(id,a);
    let switched = false;
    const stale = manager({ rpc: { ...destination.rpc,async fees() {
      const value = await destination.rpc.fees(); await expire(id); await leasesB.tryAcquireLease(id,b); switched = true; return value;
    } } });
    await assert.rejects(stale.prepareDeliveryTransaction(id,{ fence: old }),{ code: "STALE_FENCE" });
    assert.equal(switched,true); assert.deepEqual(await counts(),{ intents: 0,attempts: 0 }); assert.equal(await reader.repository.getAccount(),null);
    const current = await leasesB.getLease(id);
    const expiredDuringCommit = manager({ cfg: configB,db: poolB,beforeSignedCommit: async ({ client }) => {
      await client.query(`UPDATE ${leaseTable} SET lease_expires_at = clock_timestamp() - interval '1 millisecond' WHERE delivery_job_id = $1`,[id]);
    } });
    await assert.rejects(expiredDuringCommit.prepareDeliveryTransaction(id,{ fence: current }),{ code: "STALE_FENCE" });
    assert.deepEqual(await counts(),{ intents: 0,attempts: 0 }); assert.equal(await reader.repository.getAccount(),null);
  }));
});

test("pending/replacement state is reused, final jobs and exhausted retries are excluded", async () => {
  const id = jobs[0].deliveryJobId;
  const workerA = createRelayerWorker({ config,pool,queue,leases,transactionManager: reader });
  const active = manager({ cfg: configB,db: poolB });
  const workerB = createRelayerWorker({ config: configB,pool: poolB,queue: queueB,leases: leasesB,transactionManager: active });
  const first = await workerA.submitJob(id); const pending = await workerB.submitJob(id);
  assert.deepEqual(pending.attempt,first.attempt);
  h.advance(config.replacementAfterMs); const replacement = await reader.prepareReplacement(id);
  const account = await reader.repository.getAccount(); destination.nodes[0].available = false;
  const sent = await workerB.submitJob(id);
  assert.equal(sent.attempts.length,2); assert.equal(sent.attempt.rawSignedTransaction,replacement.attempt.rawSignedTransaction);
  assert.equal(sent.attempt.nonce,first.attempt.nonce); assert.deepEqual(sent.attempts[0],replacement.attempts[0]);
  assert.deepEqual(await reader.repository.getAccount(),account);
  await reader.repository.stopRetry(id,"MAX_ATTEMPTS_REACHED"); const stopped = await reader.repository.getTransaction(id);
  assert.equal((await workerA.submitJob(id)).action,"BUSY"); assert.deepEqual(await reader.repository.getTransaction(id),stopped);
  // Existing independent manager outcome persistence does not require a lease.
  await reader.repository.recordOutcome(id,{ transactionHash: sent.attempt.transactionHash,status: 1,
    blockNumber: 100n,blockHash: config.destinationGenesisHash,head: 100n + config.destinationConfirmations - 1n });
  await leasesB.withWorker(async b => {
    assert.equal((await leasesB.listClaimableJobs({ session: b })).some(job => job.deliveryJobId === id),false);
    assert.equal(await leasesB.tryAcquireLease(id,b),null);
  });
  assert.deepEqual(await counts(),{ intents: 1,attempts: 2 });
});
