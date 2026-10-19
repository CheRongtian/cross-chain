import assert from "node:assert/strict";
import test from "node:test";
import { classifyRecovery } from "../src/transaction-manager/recovery.mjs";
import { transactionConfig,transactionHarness,transientSendError } from "./helpers/transaction-fixtures.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { transactionFailoverHarness, rpcTimeout,transactionBody } from "./helpers/destination-rpc-fixtures.mjs";
import { fixtureHash } from "./helpers/delivery-fixtures.mjs";

function crashOnce() {
  let active = true;
  return async () => { if (active) { active = false; throw Object.assign(new Error("controlled crash checkpoint"),{ code: "TEST_CHECKPOINT" }); } };
}
const rawFields = ["nonce","rawSignedTransaction","transactionHash","gasLimit","maxFeePerGas","maxPriorityFeePerGas"];
function sameAttempt(first,second) { for (const field of rawFields) assert.equal(second[field],first[field]); }

async function reorgHarness() {
  const h = await transactionFailoverHarness();
  // These scenarios keep the primary healthy during every actual broadcast.
  h.calls.broadcast = h.destination.nodes[0].broadcasts;
  return h;
}
const reorgPreparationCalls = h => ({ sign: h.calls.sign,
  rpc: h.destination.nodes.flatMap(node => node.calls).filter(call =>
    ["eth_estimateGas","eth_maxPriorityFeePerGas"].includes(call.method)).map(call => call.method) });
async function confirmedReorgFixture(status = 1) {
  const h = await reorgHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.submitDelivery(id); h.mine(id,{ status });
  await h.manager.checkReceiptsOnce();
  const original = await h.repository.getTransaction(id);
  assert.equal(original.intent.status,status === 1 ? "CONFIRMED" : "REVERTED");
  return { h,id,original,account: await h.repository.getAccount(),preparation: reorgPreparationCalls(h) };
}
function replaceTerminalBranch({ h,original },{ replay = false } = {}) {
  h.destination.receipts.clear(); h.destination.transactions.clear();
  for (const node of h.destination.nodes) {
    node.blocks.set(original.winningAttempt.receiptBlockNumber,{ number: "0x64",hash: fixtureHash(5000) });
    node.latestNonce = BigInt(original.intent.nonce); node.pendingNonce = BigInt(original.intent.nonce); node.replay = replay;
  }
}

test("terminal receipt revalidation is a bounded canonical no-op and preserves receipt history", async () => {
  const { h,id,original } = await confirmedReorgFixture();
  const history = await h.repository.getReceiptObservations(id);
  const result = await h.restart().checkReceiptsOnce({ limit: 1 });
  assert.equal(result.checked,0); assert.equal(result.terminal.checked,1);
  assert.equal(result.terminal.results[0].action,"CANONICAL");
  assert.deepEqual(await h.repository.getTransaction(id),original);
  assert.deepEqual(await h.repository.getReceiptObservations(id),history); assert.equal(h.calls.broadcast.length,1);
});

for (const status of [1,0]) test(`positive orphan evidence reopens ${status ? "CONFIRMED" : "REVERTED"} and reuses the exact same candidate`, async () => {
  const f = await confirmedReorgFixture(status); const { h,id,original,account,preparation } = f;
  replaceTerminalBranch(f);
  const result = await h.restart().checkReceiptsOnce();
  assert.equal(result.terminal.results[0].action,"REORG_RECOVERY");
  const recovering = await h.repository.getTransaction(id);
  assert.equal(recovering.intent.status,"PENDING"); assert.equal(recovering.winningAttempt,null);
  assert.equal(recovering.intent.reorgRecovery.rebroadcastRequired,true); sameAttempt(original.attempt,recovering.attempt);
  const [old] = await h.repository.getReceiptObservations(id);
  assert.equal(old.orphaned,true); assert.equal(old.blockHash,original.attempt.receiptBlockHash);
  assert.equal(old.confirmedAt,original.attempt.confirmedAt); assert.equal(old.status,status);
  assert.equal((await h.restart().processTransactionRetriesOnce()).broadcasts,1);
  assert.ok(h.calls.broadcast.every(raw => raw === original.attempt.rawSignedTransaction));
  assert.deepEqual(reorgPreparationCalls(h),preparation); assert.deepEqual(await h.repository.getAccount(),account);
  assert.equal((await h.repository.getTransaction(id)).attempts.length,1);
});

test("same signed hash re-included below confirmation depth is tracked without sending, then reconfirmed", async () => {
  const f = await confirmedReorgFixture(); const { h,id,original,preparation } = f; replaceTerminalBranch(f);
  const hash = fixtureHash(5101);
  for (const node of h.destination.nodes) node.blocks.set("101",{ number: "0x65",hash });
  h.destination.receipts.set(original.attempt.transactionHash,{ transactionHash: original.attempt.transactionHash,blockNumber: "0x65",blockHash: hash,status: "0x1" });
  h.destination.transactions.set(original.attempt.transactionHash,transactionBody(original.intent,original.attempt,101n,hash));
  assert.equal((await h.manager.checkReceiptsOnce()).terminal.results[0].action,"AWAITING_CONFIRMATIONS");
  assert.equal((await h.repository.getTransaction(id)).intent.status,"PENDING");
  assert.equal((await h.manager.processTransactionRetriesOnce()).broadcasts,0);
  h.destination.nodes.forEach(node => { node.head = 103n; });
  await h.restart().checkReceiptsOnce();
  const final = await h.repository.getTransaction(id); assert.equal(final.intent.status,"CONFIRMED");
  assert.equal(final.winningAttempt.receiptBlockHash,hash); sameAttempt(original.attempt,final.attempt);
  const history = await h.repository.getReceiptObservations(id);
  assert.equal(history.length,2); assert.equal(history[0].orphaned,true); assert.equal(history[1].orphaned,false);
  assert.equal(h.calls.broadcast.length,1); assert.deepEqual(reorgPreparationCalls(h),preparation);
});

test("a persisted sibling can become the canonical winner without a third candidate or another broadcast", async () => {
  const h = await reorgHarness(); const id = h.jobs[0].deliveryJobId;
  const parent = await h.manager.submitDelivery(id); h.advance(h.config.replacementAfterMs);
  const child = await h.manager.prepareReplacement(id);
  h.mine(id,{ attemptId: parent.attempt.attemptId }); await h.manager.checkReceiptsOnce();
  const original = await h.repository.getTransaction(id); replaceTerminalBranch({ h,original });
  const hash = fixtureHash(5101); h.destination.nodes.forEach(node => {
    node.head = 103n; node.blocks.set("101",{ number: "0x65",hash });
  });
  h.destination.receipts.set(child.attempt.transactionHash,{ transactionHash: child.attempt.transactionHash,blockNumber: "0x65",blockHash: hash,status: "0x1" });
  h.destination.transactions.set(child.attempt.transactionHash,transactionBody(original.intent,child.attempt,101n,hash));
  const result = await h.restart().checkReceiptsOnce();
  assert.equal(result.terminal.results[0].action,"REINCLUDED"); assert.equal(result.terminal.results[0].candidatesChecked,2);
  const stored = await h.repository.getTransaction(id);
  assert.equal(stored.winningAttempt.attemptId,child.attempt.attemptId); assert.equal(stored.attempts.length,2);
  assert.equal(h.calls.broadcast.length,1); assert.equal(h.calls.sign,2);
});

test("a missing terminal receipt alone leaves the recorded outcome and history untouched", async () => {
  const { h,id,original } = await confirmedReorgFixture(); h.destination.receipts.clear();
  assert.equal((await h.restart().checkReceiptsOnce()).terminal.results[0].action,"UNRESOLVED");
  assert.deepEqual(await h.repository.getTransaction(id),original);
  assert.equal((await h.repository.getReceiptObservations(id))[0].orphaned,false); assert.equal(h.calls.broadcast.length,1);
});

test("a changed fixed-head anchor during terminal evidence collection cannot authorize orphaning", async () => {
  const f = await confirmedReorgFixture(); const { h,id,original } = f; replaceTerminalBranch(f);
  h.destination.nodes[0].faults.set("eth_getTransactionReceipt",({ forward }) => {
    h.destination.nodes.forEach(node => node.blocks.set("102",{ number: "0x66",hash: fixtureHash(9000) }));
    return forward();
  });
  const result = await h.manager.checkReceiptsOnce();
  assert.equal(result.terminal.results[0].action,"UNRESOLVED");
  assert.deepEqual(await h.repository.getTransaction(id),original);
  assert.equal((await h.repository.getReceiptObservations(id))[0].orphaned,false); assert.equal(h.calls.broadcast.length,1);
});

for (const fault of ["unavailable","timeout","behind","conflict","identity"]) test(`terminal ${fault} evidence cannot declare a reorg or authorize a send`, async () => {
  const f = await confirmedReorgFixture(); const { h,id,original } = f;
  if (fault === "unavailable") h.destination.nodes.forEach(node => { node.available = false; });
  if (fault === "identity") h.destination.nodes.forEach(node => { node.genesisHash = fixtureHash(9000); });
  if (fault === "timeout") h.destination.nodes.forEach(node => node.faults.set("eth_getBlockByNumber",({ params,forward }) => {
    if (params[0] === "0x0") return forward(); throw rpcTimeout();
  }));
  if (fault === "behind") { replaceTerminalBranch(f); h.destination.nodes[1].head = 99n; }
  if (fault === "conflict") h.destination.nodes[0].blocks.set("100",{ number: "0x64",hash: fixtureHash(5000) });
  if (["unavailable","timeout","identity"].includes(fault)) await assert.rejects(h.restart().checkReceiptsOnce());
  else assert.equal((await h.restart().checkReceiptsOnce()).terminal.results[0].action,"UNRESOLVED");
  assert.deepEqual(await h.repository.getTransaction(id),original);
  assert.equal((await h.repository.getReceiptObservations(id))[0].orphaned,false); assert.equal(h.calls.broadcast.length,1);
});

test("Gateway replay already consumed on the replacement branch prevents resubmission without preserving stale success", async () => {
  const f = await confirmedReorgFixture(); const { h,id } = f; replaceTerminalBranch(f,{ replay: true });
  assert.equal((await h.manager.checkReceiptsOnce()).terminal.results[0].action,"GATEWAY_ALREADY_EXECUTED");
  const stored = await h.repository.getTransaction(id);
  assert.equal(stored.intent.status,"PENDING"); assert.equal(stored.intent.retryStopReason,"GATEWAY_ALREADY_EXECUTED");
  assert.equal(stored.winningAttempt,null); assert.equal((await h.manager.processTransactionRetriesOnce()).broadcasts,0);
  assert.equal(h.calls.broadcast.length,1);
});

test("replay is checked again at the actual endpoint send boundary", async () => {
  const f = await confirmedReorgFixture(); const { h,id } = f; replaceTerminalBranch(f);
  await h.manager.checkReceiptsOnce();
  const replay = h.options.rpc.gatewayReplay; let reads = 0;
  h.options.rpc.gatewayReplay = async (...args) => {
    if (++reads === 2) h.destination.nodes.forEach(node => { node.replay = true; });
    return replay(...args);
  };
  await assert.rejects(h.manager.processTransactionRetriesOnce(),{ code: "GATEWAY_ALREADY_EXECUTED" });
  assert.equal(h.calls.broadcast.length,1);
  assert.equal((await h.repository.getTransaction(id)).intent.retryStopReason,"GATEWAY_ALREADY_EXECUTED");
});

test("a replay-read timeout after positive orphan proof cannot retain stale success or authorize a send", async () => {
  const f = await confirmedReorgFixture(); const { h,id } = f; replaceTerminalBranch(f);
  h.destination.nodes.forEach(node => node.faults.set("eth_call",() => { throw rpcTimeout(); }));
  assert.equal((await h.manager.checkReceiptsOnce()).terminal.results[0].action,"UNRESOLVED");
  assert.equal((await h.repository.getTransaction(id)).intent.status,"PENDING");
  assert.equal((await h.repository.getReceiptObservations(id))[0].orphaned,true);
  await h.manager.processTransactionRetriesOnce(); assert.equal(h.calls.broadcast.length,1);
  h.destination.nodes.forEach(node => node.faults.clear()); h.advance(h.config.rebroadcastIntervalMs);
  assert.equal((await h.restart().processTransactionRetriesOnce()).broadcasts,1);
});

test("concurrent reorg observations and retries serialize without branching or another nonce", async () => {
  const f = await confirmedReorgFixture(); const { h,id,account,preparation } = f; replaceTerminalBranch(f);
  await Promise.all([h.manager.checkReceiptsOnce(),h.restart().checkReceiptsOnce()]);
  assert.equal((await h.repository.getReceiptObservations(id)).filter(row => row.orphaned).length,1);
  await Promise.all([h.manager.processTransactionRetriesOnce(),h.restart().processTransactionRetriesOnce()]);
  assert.equal(h.calls.broadcast.length,2); assert.deepEqual(await h.repository.getAccount(),account);
  assert.deepEqual(reorgPreparationCalls(h),preparation); assert.equal((await h.repository.getTransaction(id)).attempts.length,1);
});

test("reorg does not reset exhausted retry history and unexplained canonical nonce consumption stops a send", async () => {
  const f = await confirmedReorgFixture(); const { h,id,original } = f;
  replaceTerminalBranch(f); await h.manager.checkReceiptsOnce();
  h.destination.nodes.forEach(node => { node.latestNonce = BigInt(original.intent.nonce) + 1n; });
  await assert.rejects(h.manager.processTransactionRetriesOnce(),{ code: "UNKNOWN_NONCE_CONSUMPTION" });
  assert.equal((await h.repository.getTransaction(id)).intent.retryStopReason,"UNKNOWN_NONCE_CONSUMPTION");
  assert.equal(h.calls.broadcast.length,1);
  const g = await reorgHarness(); const stoppedId = g.jobs[0].deliveryJobId;
  await g.manager.submitDelivery(stoppedId); await g.repository.stopRetry(stoppedId,"MAX_ATTEMPTS_REACHED");
  g.mine(stoppedId); await g.manager.checkReceiptsOnce();
  const confirmed = await g.repository.getTransaction(stoppedId); replaceTerminalBranch({ h: g,original: confirmed });
  await g.manager.checkReceiptsOnce();
  const stopped = await g.repository.getTransaction(stoppedId);
  assert.equal(stopped.intent.retryStopReason,"MAX_ATTEMPTS_REACHED"); assert.equal(stopped.intent.retryStoppedAt,confirmed.intent.retryStoppedAt);
  assert.equal((await g.manager.processTransactionRetriesOnce()).broadcasts,0);
});

test("recovery limit=1 rotates past unproductive mined bodies to a later canonical receipt without authorizing a send", async () => {
  const h = await transactionHarness();
  for (const job of h.jobs) { await h.manager.submitDelivery(job.deliveryJobId); h.mine(job.deliveryJobId); }
  for (const job of h.jobs.slice(0,2)) h.state.receipts.delete(h.records.get(job.deliveryJobId).attempt.transactionHash);
  h.state.head = 102n;
  const before = preparationCalls(h); const account = await h.repository.getAccount();
  for (let round = 0; round < 3; round++) {
    const result = await createTransactionManager({ ...h.options,repository: { ...h.repository } }).recoverTransactionsOnce({ limit: 1 });
    assert.equal(result.scanned,1); assert.equal(result.results[0].deliveryJobId,h.jobs[round].deliveryJobId);
    assert.equal(result.finalized,round === 2 ? 1 : 0);
  }
  assert.equal(h.records.get(h.jobs[0].deliveryJobId).intent.retryStoppedAt,null);
  assert.equal(h.records.get(h.jobs[2].deliveryJobId).intent.status,"CONFIRMED");
  assert.equal(h.scanCursors.receipt,null); assert.deepEqual(preparationCalls(h),before);
  assert.deepEqual(await h.repository.getAccount(),account); assert.equal(h.calls.broadcast.length,3);
  const cursor = h.scanCursors.recovery;
  await h.restart().recoverTransactionsOnce({ deliveryJobId: h.jobs[1].deliveryJobId });
  assert.equal(h.scanCursors.recovery,cursor); assert.equal(h.scanCursors.receipt,null);
});

test("bulk recovery shares one fixed conservative view while later fresh passes may confirm", async () => {
  const heads = []; let h;
  h = await transactionHarness({ hooks: { afterReceiptObserved: async ({ head }) => { heads.push(head); h.state.head = 102n; } } });
  for (const job of h.jobs) { await h.manager.submitDelivery(job.deliveryJobId); h.mine(job.deliveryJobId); }
  const first = await h.manager.recoverTransactionsOnce({ limit: 3 });
  assert.equal(first.scanned,3); assert.equal(first.finalized,0); assert.equal(h.calls.head,1);
  assert.deepEqual(heads,[100n,100n,100n]);
  assert.equal((await h.restart().recoverTransactionsOnce({ limit: 3 })).finalized,3); assert.equal(h.calls.head,2);
});

test("recovery selection interruption and independent receipt progress cannot lose the skipped intent", async () => {
  let armed = true;
  const h = await transactionHarness({ hooks: { afterObservationSelected: async ({ kind }) => {
    if (kind === "recovery" && armed) { armed = false; throw Object.assign(new Error("selected recovery interruption"),{ code: "TEST_CHECKPOINT" }); }
  } } });
  for (const job of h.jobs) await h.manager.submitDelivery(job.deliveryJobId);
  await assert.rejects(h.manager.recoverTransactionsOnce({ limit: 1 }),{ code: "TEST_CHECKPOINT" });
  assert.equal(h.calls.head,0);
  await h.manager.checkReceiptsOnce({ limit: 2 });
  assert.equal(h.scanCursors.recovery,h.records.get(h.jobs[0].deliveryJobId).intent.nonce);
  const seen = [];
  for (let round = 0; round < 3; round++) seen.push((await h.restart().recoverTransactionsOnce({ limit: 1 })).results[0].deliveryJobId);
  assert.deepEqual(seen,[h.jobs[1].deliveryJobId,h.jobs[2].deliveryJobId,h.jobs[0].deliveryJobId]);
  assert.equal(h.scanCursors.receipt,h.records.get(h.jobs[1].deliveryJobId).intent.nonce);
});

const preparationCalls = h => ({ gas: h.calls.gas,fees: h.calls.fees,sign: h.calls.sign,pendingNonce: h.calls.pending });
async function persistedReplacement(h) {
  const id = h.jobs[0].deliveryJobId;
  const parent = await h.manager.submitDelivery(id);
  h.advance(h.config.replacementAfterMs);
  const replacement = await h.manager.prepareReplacement(id);
  assert.equal(replacement.created,true);
  assert.equal(replacement.attempt.status,"SIGNED");
  assert.equal(replacement.attempt.broadcastAttemptCount,"0");
  assert.equal(await h.options.rpc.receiptEvidence(parent.attempt.transactionHash,await h.options.rpc.readView()),null);
  assert.ok(await h.options.rpc.transaction(parent.attempt.transactionHash));
  return { id,parent,replacement,account: await h.repository.getAccount(),preparation: preparationCalls(h) };
}

test("persisted replacement is recovered immediately despite a pending parent and a future retry time", async () => {
  const h = await transactionHarness();
  const { id,parent,replacement,account,preparation } = await persistedReplacement(h);
  assert.ok(Date.parse(replacement.intent.nextActionAt) > h.clock.now());
  assert.equal(h.journal.filter(event => event.attemptId === replacement.attempt.attemptId).length,0);
  const result = await h.restart().recoverTransactionsOnce();
  assert.equal(result.rebroadcast,1);
  assert.deepEqual(h.calls.broadcast,[parent.attempt.rawSignedTransaction,replacement.attempt.rawSignedTransaction]);
  const stored = await h.repository.getTransaction(id);
  assert.equal(stored.attempt.status,"BROADCAST");
  assert.deepEqual(stored.attempts.map(attempt => attempt.attemptNumber),[0,1]);
  assert.equal(stored.attempt.replacementOfAttemptId,parent.attempt.attemptId);
  sameAttempt(replacement.attempt,stored.attempt);
  sameAttempt(parent.attempt,stored.attempts[0]);
  assert.deepEqual(await h.repository.getAccount(),account);
  assert.deepEqual(preparationCalls(h),preparation);
  assert.equal((await h.restart().recoverTransactionsOnce()).rebroadcast,0);
  assert.equal(h.calls.broadcast.length,2);
});

test("an unresolved replacement marker is recovered even while the parent hash remains visible", async () => {
  const crash = crashOnce();
  const h = await transactionHarness({ hooks: { afterBroadcastStart: async ({ stored }) => {
    if (stored.attempt.attemptNumber === 1) await crash();
  } } });
  const { id,parent,replacement,account,preparation } = await persistedReplacement(h);
  await assert.rejects(h.manager.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
  assert.equal(h.calls.broadcast.length,1);
  assert.ok(h.state.transactions.has(parent.attempt.transactionHash));
  const marker = h.journal.find(event => event.attemptId === replacement.attempt.attemptId);
  assert.equal(marker.completedAt,null);
  assert.equal((await h.restart().recoverTransactionsOnce()).rebroadcast,1);
  const stored = await h.repository.getTransaction(id);
  sameAttempt(replacement.attempt,stored.attempt);
  assert.equal(stored.attempts.length,2);
  assert.equal(marker.resultClass,"RECONCILED");
  assert.deepEqual(preparationCalls(h),preparation);
  assert.deepEqual(await h.repository.getAccount(),account);
});

test("replacement recovery reconciles a parent's unresolved journal then uses the fresh version", async () => {
  let interrupt = false; const crash = crashOnce();
  const h = await transactionHarness({ hooks: { afterBroadcastStart: async () => { if (interrupt) await crash(); } } });
  const id = h.jobs[0].deliveryJobId; const parent = await h.manager.submitDelivery(id);
  h.advance(h.config.replacementAfterMs); interrupt = true;
  await assert.rejects(h.manager.rebroadcastTransaction(id),{ code: "TEST_CHECKPOINT" });
  interrupt = false; h.advance(h.config.rebroadcastIntervalMs);
  const replacement = await h.manager.prepareReplacement(id);
  const before = preparationCalls(h); const account = await h.repository.getAccount();
  assert.equal((await h.restart().recoverTransactionsOnce()).rebroadcast,1);
  assert.equal(h.journal.find(event => event.attemptId === parent.attempt.attemptId && event.broadcastSequence === "2").resultClass,"RECONCILED");
  sameAttempt(replacement.attempt,(await h.repository.getTransaction(id)).attempt);
  assert.deepEqual(preparationCalls(h),before); assert.deepEqual(await h.repository.getAccount(),account);
});

for (const confirmed of [false,true]) {
  test(`an old canonical ${confirmed ? "confirmed" : "unconfirmed"} receipt suppresses the unbroadcast replacement`, async () => {
    const h = await transactionHarness();
    const { id,parent,replacement,account,preparation } = await persistedReplacement(h);
    h.mine(id,{ attemptId: parent.attempt.attemptId });
    h.state.head = confirmed ? 102n : 100n;
    const result = await h.restart().recoverTransactionsOnce();
    assert.equal(result.results[0].action,confirmed ? "FINALIZED" : "RECEIPT_UNCONFIRMED");
    const stored = await h.repository.getTransaction(id);
    assert.equal(stored.intent.status,confirmed ? "CONFIRMED" : "PENDING");
    if (confirmed) assert.equal(stored.intent.winningAttemptId,parent.attempt.attemptId);
    sameAttempt(replacement.attempt,stored.attempt);
    assert.equal(stored.attempt.broadcastAttemptCount,"0");
    assert.equal(h.journal.filter(event => event.attemptId === replacement.attempt.attemptId).length,0);
    assert.equal(h.calls.broadcast.length,1); assert.deepEqual(preparationCalls(h),preparation);
    assert.deepEqual(await h.repository.getAccount(),account);
  });
}

test("a canonical parent body without available receipt evidence still suppresses replacement send", async () => {
  const h = await transactionHarness(); const { id,parent } = await persistedReplacement(h);
  h.mine(id,{ attemptId: parent.attempt.attemptId }); h.state.receipts.clear();
  const result = await h.restart().recoverTransactionsOnce();
  assert.equal(result.rebroadcast,0); assert.equal(h.calls.broadcast.length,1);
  h.advance(h.config.rebroadcastIntervalMs);
  assert.equal((await h.manager.processTransactionRetriesOnce()).broadcasts,0);
  assert.equal(h.calls.broadcast.length,1); assert.equal((await h.repository.getTransaction(id)).attempts.length,2);
});

test("a parent mined during visibility reads is checked again before replacement send", async () => {
  const h = await transactionHarness(); const { id,parent } = await persistedReplacement(h);
  const transaction = h.rpc.transaction;
  h.rpc.transaction = async hash => {
    const tx = await transaction(hash);
    if (hash === parent.attempt.transactionHash) { h.mine(id,{ attemptId: parent.attempt.attemptId }); h.state.head = 102n; }
    return tx;
  };
  const observed = await h.restart().recoverTransactionsOnce();
  assert.equal(observed.results[0].action,"RECEIPT_UNCONFIRMED","receipt recheck must retain the original confirmation head");
  assert.equal(h.calls.broadcast.length,1);
  assert.equal((await h.restart().recoverTransactionsOnce()).finalized,1);
  assert.equal((await h.repository.getTransaction(id)).intent.winningAttemptId,parent.attempt.attemptId);
});

test("an accepted replacement with missing result is recovered by its own hash without another send", async () => {
  const crash = crashOnce();
  const h = await transactionHarness({ hooks: { beforeBroadcastResult: async ({ stored }) => {
    if (stored.attempt.attemptNumber === 1) await crash();
  } } });
  const { id,replacement,account,preparation } = await persistedReplacement(h);
  await assert.rejects(h.manager.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
  assert.equal((await h.repository.getTransaction(id)).attempt.status,"SIGNED");
  assert.equal((await h.restart().recoverTransactionsOnce()).reconciled,1);
  const stored = await h.repository.getTransaction(id);
  assert.equal(stored.attempt.status,"BROADCAST"); sameAttempt(replacement.attempt,stored.attempt);
  assert.equal(h.calls.broadcast.length,2); assert.equal(stored.attempts.length,2);
  assert.deepEqual(preparationCalls(h),preparation); assert.deepEqual(await h.repository.getAccount(),account);
  assert.equal((await h.restart().recoverTransactionsOnce()).rebroadcast,0);
});

test("a replacement receipt restores the outcome even while its local state is SIGNED", async () => {
  const h = await transactionHarness(); const { id,replacement } = await persistedReplacement(h);
  h.mine(id,{ attemptId: replacement.attempt.attemptId }); h.state.head = 102n;
  assert.equal((await h.restart().recoverTransactionsOnce()).finalized,1);
  assert.equal((await h.repository.getTransaction(id)).intent.winningAttemptId,replacement.attempt.attemptId);
  assert.equal(h.calls.broadcast.length,1); assert.equal(h.calls.sign,2);
});

test("an existing replacement at the attempt limit recovers without repricing under new market or cap settings", async () => {
  const h = await transactionHarness({ config: transactionConfig({ TX_MAX_ATTEMPTS: "2" }) });
  const { id,replacement,account,preparation } = await persistedReplacement(h);
  h.rpc.fees = async () => assert.fail("recovery must not estimate replacement fees");
  h.rpc.estimateGas = async () => assert.fail("recovery must not estimate gas");
  const manager = createTransactionManager({ ...h.options,config: { ...h.config,maxFeePerGasCap: 1n,maxPriorityFeePerGasCap: 1n },
    account: { address: h.config.relayerAddress,async signTransaction() { assert.fail("recovery must not re-sign"); } } });
  assert.equal((await manager.recoverTransactionsOnce()).rebroadcast,1);
  sameAttempt(replacement.attempt,(await h.repository.getTransaction(id)).attempt);
  assert.deepEqual(preparationCalls(h),preparation); assert.deepEqual(await h.repository.getAccount(),account);
});

test("retry-stopped replacement stays unsent but historical canonical outcomes remain recoverable", async () => {
  const h = await transactionHarness(); const { id,parent,account } = await persistedReplacement(h);
  await h.repository.stopRetry(id,"MAX_ATTEMPTS_REACHED"); const stopped = await h.repository.getTransaction(id);
  assert.equal((await h.restart().recoverTransactionsOnce()).manualActionRequired,1);
  assert.deepEqual(await h.repository.getTransaction(id),stopped); assert.equal(h.calls.broadcast.length,1);
  h.mine(id,{ attemptId: parent.attempt.attemptId,status: 0 }); h.state.head = 102n;
  assert.equal((await h.restart().recoverTransactionsOnce()).finalized,1);
  const final = await h.repository.getTransaction(id);
  assert.equal(final.intent.retryStopReason,"MAX_ATTEMPTS_REACHED"); assert.equal(final.intent.status,"REVERTED");
  assert.equal(final.attempts.length,2); assert.equal(h.calls.sign,2); assert.deepEqual(await h.repository.getAccount(),account);
});

test("concurrent replacement recovery holds one decision and sends no new candidate or nonce", async () => {
  const h = await transactionHarness(); const { id,replacement,account } = await persistedReplacement(h);
  const reached = Promise.withResolvers(); const resume = Promise.withResolvers();
  const broadcast = h.rpc.broadcast; h.rpc.broadcast = async raw => { reached.resolve(); await resume.promise; return broadcast(raw); };
  const active = h.manager.recoverTransactionsOnce();
  try {
    await Promise.race([reached.promise,active.then(() => assert.fail("recovery did not reach the send barrier"))]);
    const other = await h.restart().recoverTransactionsOnce();
    assert.equal(other.results[0].reason,"TRANSACTION_RECOVERY_BUSY");
    resume.resolve(); assert.equal((await active).rebroadcast,1);
    assert.equal(h.calls.broadcast.length,2); assert.equal((await h.repository.getTransaction(id)).attempts.length,2);
    sameAttempt(replacement.attempt,(await h.repository.getTransaction(id)).attempt);
    assert.deepEqual(await h.repository.getAccount(),account);
  } finally { resume.resolve(); await active.catch(() => {}); }
});

test("an unbroadcast replacement fails over using the same bytes while its parent is pending", async () => {
  const h = await transactionFailoverHarness(); const { id,parent,replacement,account } = await persistedReplacement(h);
  const preparationRequests = () => h.destination.nodes.flatMap(node => node.calls)
    .filter(call => ["eth_estimateGas","eth_maxPriorityFeePerGas"].includes(call.method)).length;
  const before = preparationRequests(); h.destination.nodes[0].available = false;
  const result = await h.restart().recoverTransactionsOnce();
  assert.equal(result.rebroadcast,1); assert.equal(result.results[0].acceptedEndpointLabel,"rpc-1");
  assert.deepEqual(h.destination.nodes[0].broadcasts,[parent.attempt.rawSignedTransaction]);
  assert.deepEqual(h.destination.nodes[1].broadcasts,[replacement.attempt.rawSignedTransaction]);
  sameAttempt(replacement.attempt,(await h.repository.getTransaction(id)).attempt);
  assert.equal(preparationRequests(),before); assert.equal(h.calls.sign,2);
  assert.deepEqual(await h.repository.getAccount(),account);
});

test("retry delegation retains its view when a pending parent mines after head capture", async () => {
  const heads = [];
  const h = await transactionFailoverHarness({ hooks: { afterReceiptObserved: ({ head }) => { heads.push(head); } } });
  const { id,parent,replacement,account,preparation } = await persistedReplacement(h);
  h.advance(h.config.rebroadcastIntervalMs);
  const readView = h.options.rpc.readView; let viewReads = 0;
  h.options.rpc.readView = async () => {
    const view = await readView();
    if (++viewReads === 1) h.mine(id,{ attemptId: parent.attempt.attemptId,blockNumber: 101n });
    return view;
  };
  const result = await h.manager.processTransactionRetriesOnce();
  assert.equal(result.broadcasts,0); assert.equal(result.replacements,0);
  assert.equal(result.results[0].recovery.results[0].action,"RECEIPT_UNCONFIRMED");
  assert.equal(viewReads,1); assert.deepEqual(heads,[100n]);
  const observed = await h.repository.getTransaction(id);
  assert.equal(observed.intent.status,"PENDING"); assert.equal(observed.intent.winningAttemptId,null);
  assert.equal(observed.intent.retryStoppedAt,null); assert.equal(observed.attempts.length,2);
  sameAttempt(replacement.attempt,observed.attempt);
  assert.equal(observed.attempt.broadcastAttemptCount,"0");
  assert.equal(h.journal.some(event => event.attemptId === replacement.attempt.attemptId),false);
  assert.equal(h.destination.nodes.flatMap(node => node.broadcasts).length,1);
  assert.deepEqual(preparationCalls(h),preparation); assert.deepEqual(await h.repository.getAccount(),account);
  assert.equal((await h.manager.recoverTransactionsOnce({ deliveryJobId: id })).finalized,1);
  assert.equal(viewReads,2); assert.deepEqual(heads,[100n,103n]);
  assert.equal((await h.repository.getTransaction(id)).intent.winningAttemptId,parent.attempt.attemptId);
  assert.equal(h.destination.nodes.flatMap(node => node.broadcasts).length,1);
});

test("replacement response-loss reconciliation preserves the recovery head until a fresh receipt pass", async () => {
  const heads = [];
  const h = await transactionFailoverHarness({ hooks: { afterReceiptObserved: ({ head }) => { heads.push(head); } } });
  const { id,parent,replacement,account,preparation } = await persistedReplacement(h);
  h.destination.nodes[0].faults.set("eth_sendRawTransaction",async ({ forward }) => {
    await forward(); h.mine(id,{ attemptId: replacement.attempt.attemptId,blockNumber: 101n }); throw rpcTimeout();
  });
  h.destination.nodes[1].alreadyKnown = true;
  const readView = h.options.rpc.readView; let viewReads = 0;
  h.options.rpc.readView = async () => { viewReads++; return readView(); };
  const result = await h.manager.recoverTransactionsOnce({ deliveryJobId: id });
  assert.equal(result.rebroadcast,1); assert.equal(result.finalized,0);
  assert.equal(viewReads,1); assert.deepEqual(heads,[100n]);
  const observed = await h.repository.getTransaction(id);
  assert.equal(observed.intent.status,"PENDING"); assert.equal(observed.intent.winningAttemptId,null);
  assert.equal(observed.attempt.status,"BROADCAST"); assert.equal(observed.attempt.receiptBlockNumber,null);
  assert.equal(observed.attempts.length,2); sameAttempt(replacement.attempt,observed.attempt);
  assert.deepEqual(h.destination.nodes[0].broadcasts,[parent.attempt.rawSignedTransaction,replacement.attempt.rawSignedTransaction]);
  assert.deepEqual(h.destination.nodes[1].broadcasts,[replacement.attempt.rawSignedTransaction]);
  assert.deepEqual(preparationCalls(h),preparation); assert.deepEqual(await h.repository.getAccount(),account);
  assert.equal((await h.manager.checkReceiptsOnce()).confirmed,1);
  assert.equal(viewReads,2); assert.deepEqual(heads,[100n,103n]);
  assert.equal((await h.repository.getTransaction(id)).intent.winningAttemptId,replacement.attempt.attemptId);
  assert.equal(h.destination.nodes.flatMap(node => node.broadcasts).length,3);
});

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
