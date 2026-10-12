import assert from "node:assert/strict";
import test from "node:test";
import { classifyBroadcastError } from "../src/transaction-manager/rpc-errors.mjs";
import { replacementFees } from "../src/transaction-manager/retry-policy.mjs";
import { publicTransactionConfig } from "../src/transaction-manager/config.mjs";
import { signDeliveryTransaction } from "../src/transaction-manager/transaction.mjs";
import { transactionConfig, transactionHarness, transientSendError } from "./helpers/transaction-fixtures.mjs";
import { fixtureHash } from "./helpers/delivery-fixtures.mjs";

async function pending(options) {
  const h = await transactionHarness(options);
  const id = h.jobs[0].deliveryJobId;
  const first = await h.manager.submitDelivery(id);
  return { h,id,first };
}
async function replacement(h,id) {
  h.advance(h.config.replacementAfterMs);
  const prepared = await h.restart().prepareReplacement(id);
  assert.equal(prepared.created,true);
  return prepared;
}

test("concurrent replacement preparation keeps one child and returns existing evidence to the contender", async () => {
  const { h,id,first } = await pending(); h.advance(h.config.replacementAfterMs);
  const account = await h.repository.getAccount();
  const results = await Promise.all([h.manager.prepareReplacement(id,first.attempt.attemptId),
    h.restart().prepareReplacement(id,first.attempt.attemptId)]);
  assert.equal(results.filter(result => result.created).length,1);
  assert.equal((await h.repository.getTransaction(id)).attempts.length,2);
  assert.deepEqual(await h.repository.getAccount(),account);
  assert.equal(h.calls.sign,2); assert.equal(h.calls.broadcast.length,1);
});

test("retry defaults, exact fee ratios, bounds and public configuration", () => {
  const config = transactionConfig();
  assert.equal(config.rebroadcastIntervalMs,5000);
  assert.equal(config.replacementAfterMs,60000);
  assert.equal(config.maxAttempts,4);
  assert.equal(config.feeBumpNumerator,9n);
  assert.equal(config.feeBumpDenominator,8n);
  for (const overrides of [
    { TX_REBROADCAST_INTERVAL_MS: "0" },{ TX_REPLACEMENT_AFTER_MS: "4999" },
    { TX_FEE_BUMP_NUMERATOR: "8" },{ TX_FEE_BUMP_DENOMINATOR: "0" },
    { TX_MAX_ATTEMPTS: "1001" },{ TX_MAX_ATTEMPTS: "1.5" },
    { TX_MAX_FEE_PER_GAS: "0" },{ TX_MAX_PRIORITY_FEE_PER_GAS: "100000000001" },
    { TX_REBROADCAST_INTERVAL_MS: "9007199254740993" },
  ]) assert.throws(() => transactionConfig(overrides));
  assert.equal(publicTransactionConfig(config).feeBumpNumerator,"9");
  assert.ok(!JSON.stringify(publicTransactionConfig(config)).includes(config.privateKey));
});

test("fee bumps use BigInt ceiling, strict growth, market fees and caps", () => {
  const config = transactionConfig();
  assert.deepEqual(replacementFees({ maxFeePerGas: "17",maxPriorityFeePerGas: "1" },
    { maxFeePerGas: 1n,maxPriorityFeePerGas: 1n },config),{ maxFeePerGas: 20n,maxPriorityFeePerGas: 2n });
  assert.deepEqual(replacementFees({ maxFeePerGas: "0",maxPriorityFeePerGas: "0" },
    { maxFeePerGas: 0n,maxPriorityFeePerGas: 0n },config),{ maxFeePerGas: 1n,maxPriorityFeePerGas: 1n });
  assert.deepEqual(replacementFees({ maxFeePerGas: "17",maxPriorityFeePerGas: "1" },
    { maxFeePerGas: 100n,maxPriorityFeePerGas: 50n },config),{ maxFeePerGas: 100n,maxPriorityFeePerGas: 50n });
  const large = (1n << 100n) + 3n;
  const cap = (1n << 256n) - 1n;
  const exact = replacementFees({ maxFeePerGas: large,maxPriorityFeePerGas: large },
    { maxFeePerGas: 0n,maxPriorityFeePerGas: 0n },{ ...config,maxFeePerGasCap: cap,maxPriorityFeePerGasCap: cap });
  assert.equal(exact.maxFeePerGas,(large * 9n + 7n) / 8n);
  assert.ok(exact.maxFeePerGas >= exact.maxPriorityFeePerGas);
  assert.throws(() => replacementFees({ maxFeePerGas: cap,maxPriorityFeePerGas: 1n },
    { maxFeePerGas: 1n,maxPriorityFeePerGas: 1n },config),{ code: "REPLACEMENT_FEE_OVERFLOW" });
  assert.throws(() => replacementFees({ maxFeePerGas: config.maxFeePerGasCap,maxPriorityFeePerGas: 1n },
    { maxFeePerGas: 1n,maxPriorityFeePerGas: 1n },config),{ code: "FEE_CAP_EXCEEDED" });
  assert.throws(() => replacementFees({ maxFeePerGas: 1n,maxPriorityFeePerGas: 1n },
    { maxFeePerGas: 1n,maxPriorityFeePerGas: 2n },config),{ code: "INVALID_REPLACEMENT_FEES" });
});

test("broadcast classification prefers structured transport errors and controlled node details", () => {
  for (const [error,classification] of [
    [transientSendError(),"TRANSIENT_RPC_ERROR"],
    [Object.assign(new Error("timed out"),{ name: "TimeoutError" }),"AMBIGUOUS_BROADCAST"],
    [{ cause: { code: "ECONNRESET" } },"AMBIGUOUS_BROADCAST"],
    [{ cause: { cause: { code: "UND_ERR_SOCKET" } } },"AMBIGUOUS_BROADCAST"],
    [{ name: "HttpRequestError",status: 503 },"TRANSIENT_RPC_ERROR"],
    [{ code: -32005 },"TRANSIENT_RPC_ERROR"],
    [{ name: "NonceTooLowError",details: "already known" },"ALREADY_KNOWN"],
    [{ code: -32000,data: { message: "replacement transaction underpriced" } },"REPLACEMENT_UNDERPRICED"],
    [{ name: "FeeCapTooLowError" },"REPLACEMENT_UNDERPRICED"],
    [{ name: "NonceTooLowError" },"NONCE_TOO_LOW"],
    [{ code: -32000,message: "nonce too low" },"NONCE_TOO_LOW"],
    [{ code: -32000,message: "insufficient funds" },"DETERMINISTIC_REJECTION"],
    [new Error("unclassified rejection"),"DETERMINISTIC_REJECTION"],
  ]) assert.equal(classifyBroadcastError(error),classification);
});

test("transient failure survives restart and retries exact bytes without new nonce, fee or signature", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  const broadcast = h.rpc.broadcast;
  h.rpc.broadcast = async raw => { h.calls.broadcast.push(raw); throw transientSendError(); };
  await assert.rejects(h.manager.submitDelivery(id),/injected send failure/);
  const failed = await h.repository.getTransaction(id);
  assert.equal(failed.attempt.broadcastAttemptCount,"1");
  assert.equal(failed.attempt.lastErrorClass,"TRANSIENT_RPC_ERROR");
  assert.equal((await h.restart().processTransactionRetriesOnce()).processed,0);
  h.rpc.broadcast = broadcast; h.advance(h.config.replacementAfterMs);
  const result = await h.restart().processTransactionRetriesOnce();
  assert.equal(result.replacements,0); assert.equal(result.broadcasts,1);
  const recovered = await h.repository.getTransaction(id);
  assert.equal(recovered.attempt.broadcastAttemptCount,"2");
  assert.equal(recovered.attempt.rawSignedTransaction,failed.attempt.rawSignedTransaction);
  assert.equal(recovered.attempt.transactionHash,failed.attempt.transactionHash);
  assert.equal(recovered.attempts.length,1); assert.equal(h.calls.sign,1); assert.equal(h.calls.fees,1); assert.equal(h.calls.gas,1);
  assert.equal((await h.repository.getAccount()).nextNonce,"10");
  assert.deepEqual(h.calls.broadcast,[failed.attempt.rawSignedTransaction,failed.attempt.rawSignedTransaction]);
  assert.deepEqual(h.packets,h.original);
});

test("ambiguous accepted send queries its receipt and never immediately replaces", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId; const broadcast = h.rpc.broadcast;
  h.rpc.broadcast = async raw => { await broadcast(raw); throw Object.assign(new Error("accepted but timed out"),{ name: "TimeoutError" }); };
  await assert.rejects(h.manager.submitDelivery(id));
  assert.equal((await h.repository.getTransaction(id)).attempt.lastErrorClass,"AMBIGUOUS_BROADCAST");
  h.mine(id); h.state.head = 102n; h.advance(h.config.replacementAfterMs);
  const result = await h.restart().processTransactionRetriesOnce();
  assert.equal(result.broadcasts,0); assert.equal(result.replacements,0);
  assert.equal((await h.repository.getTransaction(id)).intent.status,"CONFIRMED");
  assert.equal(h.calls.sign,1); assert.equal(h.calls.broadcast.length,1);
});

test("exact already-known transaction is established by its persisted hash and full body", async () => {
  const { h,id,first } = await pending();
  h.rpc.broadcast = async raw => { h.calls.broadcast.push(raw); throw Object.assign(new Error("already known"),{ name: "NonceTooLowError" }); };
  h.advance(h.config.rebroadcastIntervalMs);
  const result = await h.restart().processTransactionRetriesOnce();
  assert.equal(result.broadcasts,1); assert.equal(result.replacements,0);
  assert.equal(h.calls.head,1);
  const record = await h.repository.getTransaction(id);
  assert.equal(record.attempt.lastErrorClass,"ALREADY_KNOWN"); assert.equal(record.attempts.length,1);
  assert.equal(record.attempt.transactionHash,first.attempt.transactionHash);
  h.state.transactions.get(first.attempt.transactionHash).input = "0xffff";
  await assert.rejects(h.manager.rebroadcastTransaction(id),{ code: "RECEIPT_TRANSACTION_CONTEXT_MISMATCH" });
});

test("already-known text alone does not claim acceptance or create a replacement", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  h.rpc.broadcast = async () => { throw new Error("already known"); };
  await assert.rejects(h.manager.submitDelivery(id));
  const record = await h.repository.getTransaction(id);
  assert.equal(record.attempt.status,"SIGNED"); assert.equal(record.attempt.broadcastAt,null);
  h.advance(h.config.replacementAfterMs);
  const result = await h.manager.processTransactionRetriesOnce();
  assert.equal(result.replacements,0); assert.equal(result.broadcasts,0); assert.equal(h.calls.sign,1);
});

test("replacement is append-only, same-nonce and fixed-gas with strictly higher fees", async () => {
  const { h,id,first } = await pending(); const beforeAccount = await h.repository.getAccount();
  await assert.rejects(h.manager.prepareReplacement(id),{ code: "REPLACEMENT_NOT_DUE" });
  const child = await replacement(h,id);
  assert.equal(child.attempts.length,2); assert.equal(child.attempt.attemptNumber,1);
  assert.equal(child.attempt.replacementOfAttemptId,first.attempt.attemptId);
  assert.equal(child.attempts[0].status,"REPLACED");
  for (const field of ["nonce","gasLimit","transactionType"]) assert.equal(child.attempt[field],first.attempt[field]);
  for (const field of ["calldata","packageDigest","chainId","senderAddress","destinationGateway","value","nonce"]) assert.equal(child.intent[field],first.intent[field]);
  for (const field of ["rawSignedTransaction","transactionHash","nonce","gasLimit","maxFeePerGas","maxPriorityFeePerGas"]) assert.equal(child.attempts[0][field],first.attempt[field]);
  assert.ok(BigInt(child.attempt.maxFeePerGas) > BigInt(first.attempt.maxFeePerGas));
  assert.ok(BigInt(child.attempt.maxPriorityFeePerGas) > BigInt(first.attempt.maxPriorityFeePerGas));
  assert.notEqual(child.attempt.rawSignedTransaction,first.attempt.rawSignedTransaction); assert.notEqual(child.attempt.transactionHash,first.attempt.transactionHash);
  assert.deepEqual(await h.repository.getAccount(),beforeAccount);
  assert.equal(h.calls.gas,1); assert.equal(h.calls.sign,2);
  const recovered = await h.restart().prepareDeliveryTransaction(id);
  assert.deepEqual(recovered.attempts,child.attempts);
  const sent = await h.restart().broadcastPreparedTransaction(id);
  assert.equal(sent.attempt.rawSignedTransaction,child.attempt.rawSignedTransaction);
  assert.equal(sent.attempt.broadcastAttemptCount,"1");
});

test("underpriced replacement schedules a further bounded fee increase", async () => {
  const { h,id } = await pending(); await replacement(h,id);
  const broadcast = h.rpc.broadcast;
  h.rpc.broadcast = async () => { throw Object.assign(new Error("replacement transaction underpriced"),{ code: -32000 }); };
  await assert.rejects(h.manager.broadcastPreparedTransaction(id));
  const rejected = await h.repository.getTransaction(id);
  assert.equal(rejected.attempt.lastErrorClass,"REPLACEMENT_UNDERPRICED");
  assert.equal(rejected.attempt.status,"SIGNED");
  h.rpc.broadcast = broadcast; h.advance(h.config.rebroadcastIntervalMs);
  const result = await h.restart().processTransactionRetriesOnce();
  assert.equal(result.replacements,1); assert.equal(result.broadcasts,1);
  const latest = await h.repository.getTransaction(id);
  assert.equal(latest.attempt.attemptNumber,2); assert.equal(latest.attempt.replacementOfAttemptId,rejected.attempt.attemptId);
  assert.equal(latest.attempt.nonce,"9"); assert.equal((await h.repository.getAccount()).nextNonce,"10");
});

test("a replacement cannot change nonce, calldata, chain, target, sender, value or gas", async () => {
  for (const field of ["nonce","calldata","chainId","destinationGateway","senderAddress","value","gasLimit"]) {
    const { h,id,first } = await pending(); h.advance(h.config.replacementAfterMs);
    const fees = replacementFees(first.attempt,h.state.fees,h.config);
    await assert.rejects(h.repository.persistReplacement({ id,parentAttemptId: first.attempt.attemptId,fees,
      sign: (intent,fields) => {
        const changedIntent = { ...intent }; const changedFields = { ...fields };
        if (field === "nonce") changedFields.nonce++;
        else if (field === "gasLimit") changedFields.gasLimit++;
        else changedIntent[field] = field === "value" ? "1" : field === "chainId" ? "3001" :
          field === "calldata" ? "0xffff" : h.packets[0].message.destinationReceiver;
        return signDeliveryTransaction(changedIntent,changedFields,h.options.account);
      } }));
    assert.equal((await h.repository.getTransaction(id)).attempts.length,1);
    assert.equal((await h.repository.getAccount()).nextNonce,"10");
  }
});

test("a newer exact-retry schedule suppresses a stale replacement request", async () => {
  const { h,id } = await pending(); h.advance(h.config.replacementAfterMs);
  const fees = h.rpc.fees;
  h.rpc.fees = async () => {
    await h.repository.scheduleRetry(id,{ reason: "TRANSIENT_RPC_ERROR" });
    return fees();
  };
  assert.equal((await h.manager.prepareReplacement(id)).created,false);
  assert.equal((await h.repository.getTransaction(id)).attempts.length,1);
});

test("market-fee overflow stops automatic replacement without altering signed history", async () => {
  const { h,id,first } = await pending(); h.advance(h.config.replacementAfterMs);
  h.rpc.fees = async () => { throw Object.assign(new Error("INVALID_MAX_FEE"),{ code: "INVALID_MAX_FEE" }); };
  const result = await h.manager.processTransactionRetriesOnce();
  assert.equal(result.results[0].action,"REPLACEMENT_FEE_OVERFLOW");
  const record = await h.repository.getTransaction(id);
  assert.equal(record.intent.retryStopReason,"REPLACEMENT_FEE_OVERFLOW");
  assert.equal(record.attempt.rawSignedTransaction,first.attempt.rawSignedTransaction);
  assert.equal(record.attempts.length,1);
});

test("receipt arrival during fee RPC prevents replacement insertion", async () => {
  const { h,id } = await pending(); h.advance(h.config.replacementAfterMs);
  const fees = h.rpc.fees;
  h.rpc.fees = async () => { h.mine(id); return fees(); };
  const result = await h.manager.prepareReplacement(id);
  assert.equal(result.created,false); assert.equal(result.attempts.length,1); assert.equal(h.calls.sign,1);
});

test("a stale replacement worker cannot target a newer parent", async () => {
  const { h,id,first } = await pending(); h.advance(h.config.replacementAfterMs);
  h.rpc.fees = async () => {
    const fees = replacementFees(first.attempt,h.state.fees,h.config);
    await h.repository.persistReplacement({ id,parentAttemptId: first.attempt.attemptId,fees,
      sign: (intent,fields) => signDeliveryTransaction(intent,fields,h.options.account) });
    return h.state.fees;
  };
  const result = await h.manager.prepareReplacement(id);
  assert.equal(result.created,false); assert.equal(result.attempts.length,2);
  const staleSend = await h.repository.broadcastPrepared(id,() => assert.fail("stale attempt must not send"),{ rebroadcast: true,expectedAttemptId: first.attempt.attemptId });
  assert.equal(staleSend.broadcast,false);
});

test("any historical attempt may win; every sibling and future retry stops", async () => {
  for (const oldWins of [true,false]) {
    const { h,id,first } = await pending(); const child = await replacement(h,id); await h.manager.broadcastPreparedTransaction(id);
    const winner = oldWins ? first.attempt : child.attempt;
    h.mine(id,{ attemptId: winner.attemptId }); h.state.head = 102n;
    assert.equal((await h.restart().checkReceiptsOnce()).confirmed,1);
    const record = await h.repository.getTransaction(id);
    assert.equal(record.intent.status,"CONFIRMED"); assert.equal(record.intent.winningAttemptId,winner.attemptId);
    assert.equal(record.winningAttempt.transactionHash,winner.transactionHash);
    assert.equal(record.attempts.find(a => a.attemptId !== winner.attemptId).status,"REPLACED");
    h.advance(h.config.replacementAfterMs);
    assert.equal((await h.restart().processTransactionRetriesOnce()).processed,0);
    assert.equal((await h.manager.prepareReplacement(id)).created,false);
    assert.equal((await h.manager.rebroadcastTransaction(id)).broadcast,false);
    assert.equal((await h.manager.submitDelivery(id)).submitted,false);
    assert.equal(h.calls.sign,2); assert.equal(h.calls.broadcast.length,2);
  }
});

test("old canonical EVM revert finalizes the intent and blocks all replacements", async () => {
  const { h,id,first } = await pending(); await replacement(h,id); await h.manager.broadcastPreparedTransaction(id);
  h.mine(id,{ attemptId: first.attempt.attemptId,status: 0 }); h.state.head = 102n;
  assert.equal((await h.manager.checkReceiptsOnce()).reverted,1);
  assert.equal((await h.repository.getTransaction(id)).intent.status,"REVERTED");
  assert.equal((await h.manager.prepareReplacement(id)).created,false);
  h.advance(h.config.replacementAfterMs);
  assert.equal((await h.manager.processTransactionRetriesOnce()).processed,0);
});

test("two conflicting canonical receipts fail closed before recording either winner", async () => {
  const { h,id,first } = await pending(); const child = await replacement(h,id); await h.manager.broadcastPreparedTransaction(id);
  h.mine(id,{ attemptId: first.attempt.attemptId }); h.mine(id,{ attemptId: child.attempt.attemptId }); h.state.head = 102n;
  await assert.rejects(h.manager.checkReceiptsOnce(),{ code: "CONFLICTING_CANONICAL_NONCE_WINNERS" });
  assert.equal((await h.repository.getTransaction(id)).intent.status,"PENDING");
});

test("nonce-too-low accepts a known canonical winner and stops unknown nonce consumption", async () => {
  for (const known of [true,false]) {
    const { h,id } = await pending();
    if (known) { h.mine(id); h.state.head = 102n; }
    else { h.state.transactions.clear(); h.state.latestNonce = 10n; }
    h.rpc.broadcast = async () => { throw Object.assign(new Error("nonce too low"),{ code: -32000 }); };
    if (known) assert.equal((await h.manager.rebroadcastTransaction(id)).intent.status,"CONFIRMED");
    else {
      await assert.rejects(h.manager.rebroadcastTransaction(id),{ code: "UNKNOWN_NONCE_CONSUMPTION" });
      const record = await h.repository.getTransaction(id);
      assert.equal(record.intent.retryStopReason,"UNKNOWN_NONCE_CONSUMPTION"); assert.equal(record.intent.status,"PENDING");
      h.advance(h.config.replacementAfterMs);
      assert.equal((await h.restart().processTransactionRetriesOnce()).processed,0);
    }
    assert.equal(h.calls.sign,1);
  }
});

test("a pending known body cannot explain nonce consumption without canonical inclusion evidence", async () => {
  const { h,id } = await pending();
  h.state.latestNonce = 10n;
  h.rpc.broadcast = async () => { throw new Error("nonce too low"); };
  await assert.rejects(h.manager.rebroadcastTransaction(id),{ code: "UNKNOWN_NONCE_CONSUMPTION" });
  const record = await h.repository.getTransaction(id);
  assert.equal(record.intent.retryStopReason,"UNKNOWN_NONCE_CONSUMPTION");
  assert.equal(record.attempts.length,1);
  assert.ok(h.calls.latest > 0 && h.calls.pending > 1);
});

test("max-attempt and fee-cap stops preserve full state and continue observing receipts", async () => {
  for (const cap of [false,true]) {
    const config = transactionConfig(cap ? { TX_MAX_FEE_PER_GAS: "3000000000",TX_MAX_PRIORITY_FEE_PER_GAS: "2000000000" } : { TX_MAX_ATTEMPTS: "2" });
    const { h,id,first } = await pending({ config });
    if (!cap) { await replacement(h,id); await h.manager.broadcastPreparedTransaction(id); }
    h.advance(h.config.replacementAfterMs);
    const result = await h.restart().processTransactionRetriesOnce();
    assert.equal(result.broadcasts,0);
    const stopped = await h.repository.getTransaction(id);
    assert.equal(stopped.intent.retryStopReason,cap ? "FEE_CAP_EXCEEDED" : "MAX_ATTEMPTS_REACHED");
    assert.equal(stopped.intent.nextActionAt,null);
    assert.equal(stopped.attempts.length,cap ? 1 : 2);
    assert.equal(stopped.attempts[0].rawSignedTransaction,first.attempt.rawSignedTransaction);
    assert.equal((await h.restart().processTransactionRetriesOnce()).processed,0);
    h.mine(id,{ attemptId: first.attempt.attemptId }); h.state.head = 102n;
    assert.equal((await h.restart().checkReceiptsOnce()).confirmed,1);
  }
});

test("deterministic rejection retains signed evidence and disables automatic action", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  h.rpc.broadcast = async () => { throw new Error("insufficient funds"); };
  await assert.rejects(h.manager.submitDelivery(id));
  const record = await h.repository.getTransaction(id);
  assert.equal(record.intent.retryStopReason,"DETERMINISTIC_REJECTION");
  assert.equal(record.attempt.broadcastAttemptCount,"1");
  h.advance(h.config.replacementAfterMs);
  assert.equal((await h.restart().processTransactionRetriesOnce()).processed,0);
});

test("receipt-RPC failure schedules exact retry without signing and bounded empty passes are valid", async () => {
  const { h,id } = await pending();
  h.advance(h.config.replacementAfterMs); const receipt = h.rpc.receipt;
  h.rpc.receipt = async () => { throw transientSendError("receipt RPC unavailable"); };
  assert.equal((await h.manager.processTransactionRetriesOnce({ limit: 1 })).results[0].errorClass,"TRANSIENT_RPC_ERROR");
  assert.equal(h.calls.sign,1);
  h.rpc.receipt = receipt; h.advance(h.config.rebroadcastIntervalMs);
  const result = await h.restart().processTransactionRetriesOnce({ limit: 1 });
  assert.equal(result.replacements,0); assert.equal(result.broadcasts,1);
  assert.equal((await h.repository.getTransaction(id)).attempts.length,1);
  const empty = await transactionHarness();
  assert.equal((await empty.manager.processTransactionRetriesOnce()).processed,0);
});

test("insufficient-depth old receipt suppresses replacement without refreshing the fixed head", async () => {
  const { h,id,first } = await pending(); await replacement(h,id); await h.manager.broadcastPreparedTransaction(id);
  h.mine(id,{ attemptId: first.attempt.attemptId }); h.state.head = 101n; h.advance(h.config.replacementAfterMs);
  const result = await h.manager.processTransactionRetriesOnce();
  assert.equal(result.results[0].action,"AWAITING_CONFIRMATIONS"); assert.equal(result.broadcasts,0); assert.equal(result.replacements,0);
  assert.equal((await h.repository.getTransaction(id)).intent.status,"PENDING");
  assert.equal(h.calls.sign,2);
  h.state.receipts.get(first.attempt.transactionHash).blockHash = fixtureHash(99);
  await assert.rejects(h.manager.checkReceiptsOnce(),{ code: "NONCANONICAL_TRANSACTION_RECEIPT" });
});

test("replacement retains its reserved nonce while a later intent uses a distinct nonce", async () => {
  const { h,id,first } = await pending();
  const laterId = h.jobs[1].deliveryJobId;
  const later = await h.manager.prepareDeliveryTransaction(laterId);
  assert.equal(later.intent.nonce,"10");
  const account = await h.repository.getAccount();
  const child = await replacement(h,id);
  assert.equal(child.intent.nonce,first.intent.nonce);
  assert.equal(child.attempt.nonce,"9");
  assert.deepEqual(await h.repository.getAccount(),account);
  await assert.rejects(h.manager.broadcastPreparedTransaction(laterId),{ code: "EARLIER_SIGNED_TRANSACTION_BLOCKS_BROADCAST" });
  await h.manager.broadcastPreparedTransaction(id);
  assert.equal((await h.manager.broadcastPreparedTransaction(laterId)).attempt.nonce,"10");
});

test("an old winner observed before an unbroadcast child suppresses that send", async () => {
  const { h,id,first } = await pending(); const child = await replacement(h,id);
  assert.equal(child.attempt.broadcastAttemptCount,"0");
  h.mine(id,{ attemptId: first.attempt.attemptId }); h.state.head = 102n;
  h.advance(h.config.rebroadcastIntervalMs);
  const result = await h.restart().processTransactionRetriesOnce();
  assert.equal(result.broadcasts,0);
  assert.equal((await h.repository.getTransaction(id)).intent.winningAttemptId,first.attempt.attemptId);
  assert.equal(h.calls.broadcast.length,1);
});
