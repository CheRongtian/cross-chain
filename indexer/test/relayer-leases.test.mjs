import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkerId, normalizeLeaseDuration } from "../src/relayer/config.mjs";
import { normalizeLeaseFence } from "../src/relayer/leases.mjs";
import { createRelayerWorker } from "../src/relayer/service.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { transactionHarness,transientSendError } from "./helpers/transaction-fixtures.mjs";
import { memoryLeaseFixture } from "./helpers/lease-fixtures.mjs";

async function fixture() {
  const h = await transactionHarness(); const leases = memoryLeaseFixture(h);
  const a = leases.repository(); const bConfig = { ...h.config,workerId: "relayer-b" }; const b = leases.repository(bConfig);
  const managerB = createTransactionManager({ ...h.options,config: bConfig });
  const worker = (config,repository,manager,options = {}) => createRelayerWorker({ config,queue: h.queue,leases: repository,transactionManager: manager,...options });
  return { ...h,leases,a,b,bConfig,managerB,worker,id: h.jobs[0].deliveryJobId };
}

test("fenced recovery sends retain the injected RPC failure diagnostic through the worker boundary", async () => {
  const h = await fixture();
  const message = "expected injected Relayer RPC submission failure";
  const observations = [{ endpointLabel: "rpc-0",operation: "broadcast",outcome: "UNAVAILABLE",errorClass: "TRANSIENT_RPC_ERROR" }];
  h.rpc.broadcast = async (raw,_hash,observe) => {
    h.calls.broadcast.push(raw); observe({ acceptedEndpointLabel: null,observations });
    throw transientSendError(`${message} ${h.config.privateKey}`);
  };
  await assert.rejects(h.worker(h.config,h.a,h.manager).submitJob(h.id),error => {
    assert.equal(error.code,"ECONNREFUSED"); assert.equal(error.message,`${message} <redacted>`);
    assert.deepEqual(error.observations,observations); return true;
  });
  const stored = await h.repository.getTransaction(h.id);
  assert.equal(stored.attempt.status,"SIGNED"); assert.equal(stored.attempts.length,1); assert.equal(h.records.size,1);
  assert.equal(stored.attempt.broadcastAttemptCount,"1"); assert.equal(stored.intent.retryStoppedAt,null);
  assert.equal((await h.repository.getAccount()).nextNonce,"10");
  assert.equal(h.calls.sign,1); assert.equal(h.calls.broadcast.length,1);
  assert.notEqual((await h.a.getLease(h.id)).releasedAt,null);
});

test("worker IDs and lease durations are strict, bounded and log-safe", () => {
  assert.equal(normalizeWorkerId("relayer-b"),"relayer-b"); assert.equal(normalizeLeaseDuration("30000"),30000);
  for (const id of [""," Relayer-A","RELAYER-A","relayer\nb","x".repeat(65),"a/b",123]) assert.throws(() => normalizeWorkerId(id),{ code: "INVALID_RELAYER_WORKER_ID" });
  for (const value of ["0","-1","01","1.5","3600001",30000]) assert.throws(() => normalizeLeaseDuration(value),{ code: "INVALID_RELAYER_LEASE_DURATION" });
});

test("one concurrent owner, idempotent active acquisition and session-aware duplicate worker rejection", async () => {
  const h = await fixture();
  await h.a.withWorker(async a => h.b.withWorker(async b => {
    const claims = await Promise.all([h.a.tryAcquireLease(h.id,a),h.b.tryAcquireLease(h.id,b)]);
    assert.equal(claims.filter(Boolean).length,1);
    const first = claims[0]; assert.equal(first.fencingToken,"1");
    assert.deepEqual(await h.a.tryAcquireLease(h.id,a),first);
    assert.equal(await h.b.tryAcquireLease(h.id,b),null);
    await assert.rejects(h.a.withWorker(async () => {}),{ code: "RELAYER_WORKER_ALREADY_RUNNING" });
  }));
  // The same configured ID after restart cannot assume the old session's lease.
  await h.a.withWorker(async fresh => assert.equal(await h.a.tryAcquireLease(h.id,fresh),null));
});

test("renewal uses the current owner/token; expiry and release preserve strictly increasing exact tokens", async () => {
  const h = await fixture(); let first;
  await h.a.withWorker(async a => {
    first = await h.a.tryAcquireLease(h.id,a); h.advance(1000);
    const renewed = await h.a.renewLease(first); assert.ok(Date.parse(renewed.leaseExpiresAt) > Date.parse(first.leaseExpiresAt));
    await assert.rejects(h.b.renewLease({ ...first,ownerId: "relayer-b" }),{ code: "STALE_FENCE" });
    await assert.rejects(h.a.renewLease({ ...first,fencingToken: "2" }),{ code: "STALE_FENCE" });
    h.advance(h.config.leaseMs);
    await assert.rejects(h.a.renewLease(first),{ code: "STALE_FENCE" });
  });
  await h.b.withWorker(async b => {
    const second = await h.b.tryAcquireLease(h.id,b); assert.equal(second.fencingToken,"2");
    await assert.rejects(h.a.releaseLease(first),{ code: "STALE_FENCE" });
    await assert.rejects(h.a.renewLease(first),{ code: "STALE_FENCE" });
    const released = await h.b.releaseLease(second); assert.deepEqual(await h.b.releaseLease(second),released);
    const third = await h.b.tryAcquireLease(h.id,b); assert.equal(third.fencingToken,"3");
    await assert.rejects(h.b.releaseLease(second),{ code: "STALE_FENCE" });
    h.leases.rows.get(h.id).fencingToken = "9007199254740993";
    await h.b.releaseLease({ ...third,fencingToken: "9007199254740993" });
    assert.equal((await h.b.tryAcquireLease(h.id,b)).fencingToken,"9007199254740994");
  });
  for (const token of [1,"0","01","9223372036854775808"]) assert.throws(() => normalizeLeaseFence({ ...first,fencingToken: token },h.id));
});

test("stale intent preparation cannot allocate or sign; the new owner creates one canonical intent", async () => {
  const h = await fixture(); let stale;
  await h.a.withWorker(async a => { stale = await h.a.tryAcquireLease(h.id,a); });
  h.advance(h.config.leaseMs);
  await h.b.withWorker(async b => {
    const current = await h.b.tryAcquireLease(h.id,b);
    await assert.rejects(h.manager.prepareDeliveryTransaction(h.id,{ fence: stale }),{ code: "STALE_FENCE" });
    assert.equal(h.records.size,0); assert.equal(h.calls.sign,0); assert.equal(await h.repository.getAccount(),null);
    const stored = await h.managerB.prepareDeliveryTransaction(h.id,{ fence: current });
    const repeated = await h.managerB.prepareDeliveryTransaction(h.id,{ fence: current });
    assert.equal(repeated.created,false); assert.deepEqual(repeated.intent,stored.intent); assert.deepEqual(repeated.attempt,stored.attempt);
    assert.equal(h.records.size,1); assert.equal(h.calls.sign,1); assert.equal((await h.repository.getAccount()).nextNonce,"10");
    assert.equal((await h.b.getLease(h.id)).ownerId,"relayer-b");
  });
});

test("SIGNED takeover preserves intent, sender, nonce, exact bytes/hash and performs no new gas/fee/sign work", async () => {
  const h = await fixture(); let prepared;
  await h.a.withWorker(async a => {
    const fence = await h.a.tryAcquireLease(h.id,a); prepared = await h.manager.prepareDeliveryTransaction(h.id,{ fence });
  });
  const account = await h.repository.getAccount(); h.advance(h.config.leaseMs);
  const result = await h.worker(h.bConfig,h.b,h.managerB).submitJob(h.id);
  assert.deepEqual(result.intent.packageDigest,prepared.intent.packageDigest); assert.equal(result.intent.intentId,prepared.intent.intentId);
  assert.equal(result.intent.senderAddress,prepared.intent.senderAddress);
  for (const field of ["nonce","rawSignedTransaction","transactionHash","gasLimit","maxFeePerGas","maxPriorityFeePerGas"]) assert.equal(result.attempt[field],prepared.attempt[field]);
  assert.equal(result.attempt.status,"BROADCAST"); assert.equal(result.fencingToken,"2");
  assert.equal(h.calls.sign,1); assert.equal(h.calls.gas,1); assert.equal(h.calls.fees,1); assert.equal(h.calls.broadcast.length,1);
  assert.deepEqual(await h.repository.getAccount(),account); assert.deepEqual(h.packets,h.original);
});

test("lease loss between durable SIGNED and send rejects stale orchestration without a network side effect", async () => {
  const h = await fixture();
  const worker = h.worker(h.config,h.a,h.manager,{ afterPrepared: async () => {
    h.advance(h.config.leaseMs);
    await h.b.withWorker(b => h.b.tryAcquireLease(h.id,b));
  } });
  await assert.rejects(worker.submitJob(h.id),{ code: "STALE_FENCE" });
  assert.equal(h.calls.broadcast.length,0); assert.equal(h.records.size,1); assert.equal(h.calls.sign,1);
  assert.equal((await h.b.getLease(h.id)).ownerId,"relayer-b");
});

test("pending broadcast and replacement lineage remain durable across owner changes", async () => {
  const h = await fixture();
  const first = await h.worker(h.config,h.a,h.manager).submitJob(h.id);
  const pending = await h.worker(h.bConfig,h.b,h.managerB).submitJob(h.id);
  assert.deepEqual(pending.attempt,first.attempt); assert.equal(h.calls.broadcast.length,1);
  h.advance(h.config.replacementAfterMs);
  const replacement = await h.manager.prepareReplacement(h.id);
  const account = await h.repository.getAccount();
  const sent = await h.worker(h.bConfig,h.b,h.managerB).submitJob(h.id);
  assert.equal(sent.attempts.length,2); assert.equal(sent.attempt.attemptNumber,1);
  assert.equal(sent.attempt.rawSignedTransaction,replacement.attempt.rawSignedTransaction);
  assert.equal(sent.attempt.transactionHash,replacement.attempt.transactionHash);
  assert.deepEqual(sent.attempts[0],replacement.attempts[0]); assert.deepEqual(await h.repository.getAccount(),account);
  h.mine(h.id,{ attemptId: first.attempt.attemptId,status: 0 }); h.state.head = 102n;
  const reverted = await h.worker(h.config,h.a,h.manager).submitJob(h.id);
  assert.equal(reverted.intent.status,"REVERTED"); assert.equal(reverted.intent.winningAttemptId,first.attempt.attemptId);
});

test("replacement recovery rejects the old fence and lets the new owner send exactly the existing candidate", async () => {
  const h = await fixture();
  await h.worker(h.config,h.a,h.manager).submitJob(h.id);
  h.advance(h.config.replacementAfterMs);
  const replacement = await h.manager.prepareReplacement(h.id);
  const account = await h.repository.getAccount();
  const counts = { gas: h.calls.gas,fees: h.calls.fees,sign: h.calls.sign };
  let stale;
  await h.a.withWorker(async a => { stale = await h.a.tryAcquireLease(h.id,a); });
  h.advance(h.config.leaseMs);
  await h.b.withWorker(async b => {
    const current = await h.b.tryAcquireLease(h.id,b);
    const before = await h.repository.getRecoverySnapshot(h.id);
    await assert.rejects(h.manager.recoverTransactionsOnce({ deliveryJobId: h.id,fence: stale }),{ code: "STALE_FENCE" });
    assert.deepEqual(await h.repository.getRecoverySnapshot(h.id),before); assert.equal(h.calls.broadcast.length,1);
    const recovered = await h.managerB.continueDeliveryTransactionOnce(h.id,{ fence: current });
    assert.equal(recovered.submitted,true); assert.equal(recovered.attempts.length,2);
    assert.ok(BigInt(current.fencingToken) > BigInt(stale.fencingToken));
    for (const field of ["nonce","rawSignedTransaction","transactionHash","gasLimit","maxFeePerGas","maxPriorityFeePerGas"]) {
      assert.equal(recovered.attempt[field],replacement.attempt[field]);
    }
    assert.equal(h.calls.broadcast.length,2);
    await h.b.releaseLease(current);
  });
  assert.deepEqual({ gas: h.calls.gas,fees: h.calls.fees,sign: h.calls.sign },counts);
  assert.deepEqual(await h.repository.getAccount(),account);
});

test("distinct workers can claim different jobs; final and retry-stopped intents cannot be reclaimed or reset", async () => {
  const h = await fixture();
  await h.a.withWorker(async a => h.b.withWorker(async b => {
    const owned = await h.a.tryAcquireLease(h.id,a);
    const jobsB = await h.b.listClaimableJobs({ session: b,limit: 100 }); assert.equal(jobsB.some(job => job.deliveryJobId === h.id),false);
    assert.ok(await h.b.tryAcquireLease(jobsB[0].deliveryJobId,b));
    await h.a.releaseLease(owned);
  }));
  const first = await h.worker(h.config,h.a,h.manager).submitJob(h.id);
  await h.repository.stopRetry(h.id,"MAX_ATTEMPTS_REACHED"); const stopped = await h.repository.getTransaction(h.id);
  const result = await h.worker(h.bConfig,h.b,h.managerB).submitJob(h.id); assert.equal(result.action,"BUSY");
  assert.deepEqual(await h.repository.getTransaction(h.id),stopped);
  // Receipt processing remains independent of the operational lease lifetime.
  h.mine(h.id); h.state.head = 102n; await h.manager.checkReceiptsOnce();
  assert.equal((await h.worker(h.bConfig,h.b,h.managerB).submitJob(h.id)).action,"BUSY");
  assert.equal(h.calls.sign,1); assert.equal(first.attempt.nonce,"9");
});

test("corrupt evidence fails before nonce/signing and leaves immutable input intact", async () => {
  const h = await transactionHarness({ mutate: pack => { pack.message.payload = "0xffff"; } });
  const leases = memoryLeaseFixture(h);
  await assert.rejects(createRelayerWorker({ config: h.config,queue: h.queue,leases: leases.repository(),transactionManager: h.manager }).runOnce());
  assert.equal(h.calls.sign,0); assert.equal(h.calls.broadcast.length,0); assert.equal(h.records.size,0);
});

test("pending not-yet-due jobs do not starve later new jobs before the per-worker limit", async () => {
  const h = await fixture(); const limited = { ...h.config,maxJobs: 1 };
  const a = h.leases.repository(limited); const worker = h.worker(limited,a,h.manager);
  const first = await worker.runOnce(); assert.equal(first.selected,1); assert.equal(first.submitted,1);
  const second = await worker.runOnce(); assert.equal(second.selected,1); assert.equal(second.submitted,1);
  assert.notEqual(first.results[0].intent.intentId,second.results[0].intent.intentId);
  assert.equal(h.calls.sign,2); assert.equal(h.records.size,2);
});
