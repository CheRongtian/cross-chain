import assert from "node:assert/strict";
import test from "node:test";
import { classifyRecovery } from "../src/transaction-manager/recovery.mjs";
import { transactionHarness,transientSendError } from "./helpers/transaction-fixtures.mjs";
import { transactionFailoverHarness, rpcTimeout } from "./helpers/destination-rpc-fixtures.mjs";

function crashOnce() {
  let active = true;
  return async () => { if (active) { active = false; throw Object.assign(new Error("controlled crash checkpoint"),{ code: "TEST_CHECKPOINT" }); } };
}
const rawFields = ["nonce","rawSignedTransaction","transactionHash","gasLimit","maxFeePerGas","maxPriorityFeePerGas"];
function sameAttempt(first,second) { for (const field of rawFields) assert.equal(second[field],first[field]); }

test("a failed recovery send preserves its code, redacted diagnostic and endpoint observations", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  const first = await h.manager.prepareDeliveryTransaction(id); const account = await h.repository.getAccount();
  const observations = [{ endpointLabel: "rpc-0",operation: "broadcast",outcome: "UNAVAILABLE",errorClass: "TRANSIENT_RPC_ERROR" }];
  const secrets = [h.config.privateKey,h.config.databaseUrl,...h.config.destinationRpcUrls].filter(Boolean);
  h.rpc.broadcast = async (raw,_hash,observe) => {
    h.calls.broadcast.push(raw); observe({ acceptedEndpointLabel: null,observations });
    throw transientSendError(`expected injected Relayer RPC submission failure ${secrets.join(" ")}`);
  };
  const result = await h.restart().recoverTransactionsOnce(); const failure = result.results[0];
  assert.equal(result.unchanged,1); assert.equal(result.rebroadcast,0);
  assert.equal(failure.errorClass,"TRANSIENT_RPC_ERROR"); assert.equal(failure.errorCode,"ECONNREFUSED");
  assert.ok(failure.errorMessage.startsWith("expected injected Relayer RPC submission failure"));
  assert.deepEqual(failure.rpcObservations,observations);
  for (const secret of secrets) assert.ok(!JSON.stringify(result).includes(secret),"recovery diagnostics must redact configured secrets and URLs");
  const stored = await h.repository.getTransaction(id); sameAttempt(first.attempt,stored.attempt);
  assert.equal(stored.attempt.status,"SIGNED"); assert.equal(stored.attempts.length,1);
  assert.equal(stored.intent.retryStoppedAt,null); assert.equal(h.journal[0].resultClass,"ERROR");
  assert.deepEqual(await h.repository.getAccount(),account); assert.equal(h.calls.sign,1); assert.equal(h.calls.broadcast.length,1);
});

test("clean SIGNED recovery starts the same persisted transaction and final/empty recovery is a no-op", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  assert.equal((await h.manager.recoverTransactionsOnce()).scanned,0); assert.equal(classifyRecovery(null),"NO_INTENT");
  const first = await h.manager.prepareDeliveryTransaction(id); const account = await h.repository.getAccount();
  assert.equal(classifyRecovery(await h.repository.getRecoverySnapshot(id)),"SIGNED_NOT_STARTED");
  assert.equal((await h.restart().recoverTransactionsOnce()).rebroadcast,1);
  sameAttempt(first.attempt,(await h.repository.getTransaction(id)).attempt);
  assert.deepEqual(await h.repository.getAccount(),account); assert.equal(h.calls.sign,1); assert.equal(h.calls.gas,1); assert.equal(h.calls.fees,1);
  h.mine(id); h.state.head = 102n;
  assert.equal((await h.restart().recoverTransactionsOnce()).finalized,1);
  assert.equal((await h.restart().recoverTransactionsOnce()).scanned,0); assert.equal(h.calls.broadcast.length,1);
});

test("committed marker before any RPC survives a crash and exact rebroadcast creates no new identity", async () => {
  const h = await transactionHarness({ hooks: { afterBroadcastStart: crashOnce() } }); const id = h.jobs[0].deliveryJobId;
  const first = await h.manager.prepareDeliveryTransaction(id); const account = await h.repository.getAccount();
  await assert.rejects(h.manager.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
  assert.equal(h.calls.broadcast.length,0); assert.equal(h.journal.length,1); assert.equal(h.journal[0].completedAt,null);
  assert.equal(classifyRecovery(await h.repository.getRecoverySnapshot(id)),"AMBIGUOUS_BROADCAST");
  assert.equal((await h.restart().recoverTransactionsOnce()).rebroadcast,1);
  assert.equal(h.journal.length,2); assert.deepEqual(h.journal.map(e => e.broadcastSequence),["1","2"]);
  assert.equal(h.journal[0].resultClass,"RECONCILED"); assert.equal(h.journal[1].resultClass,"ACCEPTED");
  sameAttempt(first.attempt,(await h.repository.getTransaction(id)).attempt);
  assert.deepEqual(await h.repository.getAccount(),account); assert.equal(h.records.size,1); assert.equal(h.calls.sign,1);
});

test("accepted send with missing local result is found by hash without another send/sign/nonce", async () => {
  const h = await transactionHarness({ hooks: { beforeBroadcastResult: crashOnce() } }); const id = h.jobs[0].deliveryJobId;
  const signed = await h.manager.prepareDeliveryTransaction(id);
  await assert.rejects(h.manager.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
  assert.equal((await h.repository.getTransaction(id)).attempt.status,"SIGNED"); assert.equal(h.calls.broadcast.length,1);
  const result = await h.restart().recoverTransactionsOnce(); assert.equal(result.reconciled,1);
  const stored = await h.repository.getTransaction(id); assert.equal(stored.attempt.status,"BROADCAST");
  sameAttempt(signed.attempt,stored.attempt); assert.equal(h.calls.broadcast.length,1); assert.equal(h.calls.sign,1);
  assert.equal(h.journal[0].resultClass,"RECONCILED");
});

test("primary accepted before an interrupted response can recover through secondary; all-down writes nothing", async () => {
  const h = await transactionFailoverHarness({ hooks: { afterEndpointResult: crashOnce() } }); const id = h.jobs[0].deliveryJobId;
  const first = await h.manager.prepareDeliveryTransaction(id);
  h.destination.nodes[0].faults.set("eth_sendRawTransaction",async ({ forward }) => { await forward(); throw rpcTimeout(); });
  await assert.rejects(h.manager.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
  assert.equal(h.journal.length,2); assert.ok(h.journal.every(e => e.completedAt === null));
  assert.equal(h.destination.nodes[1].broadcasts.length,0);
  const snapshot = await h.repository.getRecoverySnapshot(id); const account = await h.repository.getAccount();
  h.destination.nodes.forEach(node => { node.available = false; });
  const unavailable = await h.restart().recoverTransactionsOnce(); assert.equal(unavailable.results[0].reason,"RPC_UNAVAILABLE");
  assert.equal(unavailable.results[0].errorCode,"RPC_UNAVAILABLE"); assert.equal(unavailable.results[0].errorMessage,"RPC_UNAVAILABLE");
  assert.ok(unavailable.results[0].rpcObservations.length > 0);
  assert.deepEqual(await h.repository.getRecoverySnapshot(id),snapshot); assert.deepEqual(await h.repository.getAccount(),account);
  h.destination.nodes[1].available = true;
  assert.equal((await h.restart().recoverTransactionsOnce()).reconciled,1);
  sameAttempt(first.attempt,(await h.repository.getTransaction(id)).attempt);
  assert.equal(h.destination.nodes[0].broadcasts.length,1); assert.equal(h.destination.nodes[1].broadcasts.length,0);
});

test("either historical same-nonce candidate can win after replacement result interruption", async () => {
  for (const oldWins of [true,false]) {
    let pause = false; const crash = crashOnce();
    const h = await transactionHarness({ hooks: { beforeBroadcastResult: async () => { if (pause) await crash(); } } });
    const id = h.jobs[0].deliveryJobId; const first = await h.manager.submitDelivery(id);
    h.advance(h.config.replacementAfterMs); const replacement = await h.manager.prepareReplacement(id); const account = await h.repository.getAccount();
    pause = true; await assert.rejects(h.manager.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
    h.mine(id,{ attemptId: (oldWins ? first : replacement).attempt.attemptId,status: oldWins ? 0 : 1 }); h.state.head = 102n;
    assert.equal((await h.restart().recoverTransactionsOnce()).finalized,1);
    const recovered = await h.repository.getTransaction(id);
    assert.equal(recovered.intent.winningAttemptId,(oldWins ? first : replacement).attempt.attemptId);
    assert.equal(recovered.intent.status,oldWins ? "REVERTED" : "CONFIRMED"); assert.equal(recovered.attempts.length,2);
    assert.equal(h.calls.sign,2); assert.deepEqual(await h.repository.getAccount(),account);
    assert.equal((await h.restart().recoverTransactionsOnce()).scanned,0);
  }
});

test("receipt observation can be repeated; insufficient depth and pre-confirmation disappearance remain non-final", async () => {
  const h = await transactionHarness({ hooks: { afterReceiptObserved: crashOnce() } }); const id = h.jobs[0].deliveryJobId;
  await h.manager.submitDelivery(id); h.mine(id);
  await assert.rejects(h.manager.recoverTransactionsOnce(),{ code: "TEST_CHECKPOINT" });
  assert.equal(h.records.get(id).intent.status,"PENDING");
  assert.equal((await h.restart().recoverTransactionsOnce()).results[0].action,"RECEIPT_UNCONFIRMED");
  h.state.receipts.clear(); h.state.blocks.clear();
  Object.assign(h.state.transactions.get(h.records.get(id).attempt.transactionHash),{ blockNumber: null,blockHash: null });
  await h.restart().recoverTransactionsOnce(); assert.equal(h.records.get(id).intent.status,"PENDING");
  h.mine(id); h.state.head = 102n; assert.equal((await h.restart().recoverTransactionsOnce()).finalized,1);
});

test("retry exhaustion preserves policy but does not hide a real canonical revert", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.submitDelivery(id); await h.repository.stopRetry(id,"MAX_ATTEMPTS_REACHED");
  h.state.transactions.clear(); const stopped = await h.repository.getTransaction(id);
  assert.equal((await h.manager.recoverTransactionsOnce()).manualActionRequired,1);
  assert.deepEqual(await h.repository.getTransaction(id),stopped); assert.equal(h.calls.sign,1);
  h.mine(id,{ status: 0 }); h.state.head = 102n;
  assert.equal((await h.manager.recoverTransactionsOnce()).finalized,1); assert.equal(h.records.get(id).intent.status,"REVERTED");
});

test("unknown nonce consumption, corrupt signed bytes and conflicting receipts fail closed", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.prepareDeliveryTransaction(id); h.state.latestNonce = 10n;
  assert.equal((await h.manager.recoverTransactionsOnce()).results[0].reason,"UNKNOWN_NONCE_CONSUMPTION");
  assert.equal(h.calls.broadcast.length,0); assert.equal(h.calls.sign,1); assert.equal(h.records.size,1);
  h.records.get(id).attempt.rawSignedTransaction = "0x0200";
  await assert.rejects(h.manager.recoverTransactionsOnce()); assert.equal(h.calls.broadcast.length,0);
  const pair = await transactionHarness(); const job = pair.jobs[0].deliveryJobId;
  const first = await pair.manager.submitDelivery(job); pair.advance(pair.config.replacementAfterMs);
  const next = await pair.manager.prepareReplacement(job); await pair.manager.broadcastPreparedTransaction(job);
  pair.mine(job,{ attemptId: first.attempt.attemptId }); pair.mine(job,{ attemptId: next.attempt.attemptId }); pair.state.head = 102n;
  const conflict = await pair.manager.recoverTransactionsOnce(); assert.equal(conflict.results[0].reason,"CONFLICTING_CANONICAL_NONCE_WINNERS");
  assert.equal(pair.records.get(job).intent.status,"PENDING");
});

test("a pending hash cannot explain canonical nonce consumption during recovery", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  const signed = await h.manager.submitDelivery(id); h.state.latestNonce = BigInt(signed.intent.nonce) + 1n;
  const result = await h.restart().recoverTransactionsOnce();
  assert.equal(result.results[0].reason,"UNKNOWN_NONCE_CONSUMPTION");
  const stored = await h.repository.getTransaction(id);
  assert.equal(stored.intent.retryStopReason,"UNKNOWN_NONCE_CONSUMPTION");
  sameAttempt(signed.attempt,stored.attempt);
  assert.equal(stored.attempts.length,1); assert.equal(h.calls.broadcast.length,1); assert.equal(h.calls.sign,1);
});

test("concurrent recovery serializes one exact send and state changes after reads invalidate writeback", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId; await h.manager.prepareDeliveryTransaction(id);
  const results = await Promise.all([h.manager.recoverTransactionsOnce(),h.restart().recoverTransactionsOnce()]);
  assert.equal(results.reduce((n,result) => n + result.rebroadcast,0),1); assert.equal(h.calls.broadcast.length,1);
  const snapshot = await h.repository.getRecoverySnapshot(id); await h.repository.scheduleRetry(id);
  await assert.rejects(h.repository.applyRecoveryObservation(snapshot,{ knownAttempts: [snapshot.attempt.attemptId] }),{ code: "RECOVERY_STATE_CHANGED" });
});

test("wrong destination identity during recovery cannot change the persisted attempt", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.prepareDeliveryTransaction(id); const before = await h.repository.getRecoverySnapshot(id);
  h.state.actualChain = 10011n;
  await assert.rejects(h.manager.recoverTransactionsOnce(),{ code: "CHAIN_ID_MISMATCH" });
  assert.deepEqual(await h.repository.getRecoverySnapshot(id),before); assert.equal(h.calls.broadcast.length,0);
});
