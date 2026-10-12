import assert from "node:assert/strict";
import { toHex } from "viem";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";

// Invoked by the existing real-chain integration; never by production workers.
export async function verifyPendingReplacement({ config,pool,queue,legacy,destination,jobId,run,onReplacementPrepared = async () => {},prepareAndBroadcast }) {
  let now = Date.now();
  const clock = { now: () => now };
  const manager = createTransactionManager({ config,pool,queue,legacy,clock });
  const automine = await destination.request({ method: "anvil_getAutomine",params: [] });
  assert.equal(typeof automine,"boolean");
  let failure;
  try {
    await destination.request({ method: "evm_setAutomine",params: [false] });
    let first;
    if (prepareAndBroadcast) first = await prepareAndBroadcast();
    else {
      const prepared = await manager.prepareDeliveryTransaction(jobId);
      assert.equal(prepared.created,true);
      first = await manager.broadcastPreparedTransaction(jobId);
    }
    assert.equal(first.attempt.status,"BROADCAST");
    assert.equal(await destination.request({ method: "eth_getTransactionReceipt",params: [first.attempt.transactionHash] }),null);
    now = Math.max(now,Date.parse(first.attempt.broadcastAt)) + config.replacementAfterMs;
    const replacement = await manager.prepareReplacement(jobId,first.attempt.attemptId);
    assert.equal(replacement.created,true);
    assert.equal(replacement.attempt.status,"SIGNED");
    assert.equal(replacement.attempts.length,2);
    assert.deepEqual(await run(["read",jobId]),{ intent: replacement.intent,attempt: replacement.attempt,attempts: replacement.attempts,winningAttempt: null });
    const account = await manager.repository.getAccount();
    for (const field of ["nonce","gasLimit","transactionType"]) assert.equal(replacement.attempt[field],first.attempt[field]);
    for (const field of ["nonce","chainId","senderAddress","destinationGateway","value","calldata","packageDigest"]) assert.equal(replacement.intent[field],first.intent[field]);
    assert.equal(replacement.attempt.replacementOfAttemptId,first.attempt.attemptId);
    assert.notEqual(replacement.attempt.transactionHash,first.attempt.transactionHash);
    assert.ok(BigInt(replacement.attempt.maxFeePerGas) > BigInt(first.attempt.maxFeePerGas));
    assert.ok(BigInt(replacement.attempt.maxPriorityFeePerGas) > BigInt(first.attempt.maxPriorityFeePerGas));
    await onReplacementPrepared(replacement);
    now += config.rebroadcastIntervalMs;
    const result = await manager.processTransactionRetriesOnce();
    assert.equal(result.replacements,0);
    assert.ok(result.results.some(r => r.deliveryJobId === jobId && r.action === "BROADCAST"));
    const sent = await manager.repository.getTransaction(jobId);
    assert.equal(sent.attempt.rawSignedTransaction,replacement.attempt.rawSignedTransaction);
    assert.equal(sent.attempt.transactionHash,replacement.attempt.transactionHash);
    assert.equal(sent.attempt.broadcastAttemptCount,"1");
    assert.deepEqual(await manager.repository.getAccount(),account);
    assert.equal(await destination.request({ method: "eth_getTransactionReceipt",params: [sent.attempt.transactionHash] }),null);
    await destination.request({ method: "anvil_mine",params: ["0x1"] });
    const receipt = await destination.request({ method: "eth_getTransactionReceipt",params: [sent.attempt.transactionHash] });
    assert.ok(receipt,"real replacement must be mined after the controlled pending window");
    assert.equal(BigInt(receipt.status),1n);
    assert.equal(await destination.request({ method: "eth_getTransactionReceipt",params: [first.attempt.transactionHash] }),null);
    if (config.destinationConfirmations > 1n) await destination.request({ method: "anvil_mine",params: [toHex(config.destinationConfirmations - 1n)] });
    await manager.checkReceiptsOnce();
    const finalized = await manager.repository.getTransaction(jobId);
    assert.equal(finalized.intent.status,"CONFIRMED");
    assert.equal(finalized.intent.winningAttemptId,sent.attempt.attemptId);
    assert.equal(finalized.attempts[0].status,"REPLACED");
    for (const field of ["rawSignedTransaction","transactionHash","maxFeePerGas","maxPriorityFeePerGas"]) assert.equal(finalized.attempts[0][field],first.attempt[field]);
    assert.deepEqual(await run(["read",jobId]),finalized);
    assert.equal((await manager.prepareReplacement(jobId)).created,false);
    console.log("VALID: real pending Chain B transaction was replaced at the same nonce with higher fees; fresh processes recovered exact history and its canonical winner");
    return finalized;
  } catch (error) { failure = error; throw error; }
  finally {
    try { await destination.request({ method: "evm_setAutomine",params: [automine] }); }
    catch (error) {
      if (!failure) throw error;
      console.error(`Restoring Chain B automine also failed: ${error.message}`);
    }
  }
}
