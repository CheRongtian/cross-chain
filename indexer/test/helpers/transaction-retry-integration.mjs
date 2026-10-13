import assert from "node:assert/strict";
import { toHex } from "viem";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { verifyRpcTransaction } from "../../src/transaction-manager/receipts.mjs";

// Invoked by the existing real-chain integration; never by production workers.
export async function verifyPendingReplacement({ config,pool,queue,legacy,destination,jobId,run,onReplacementPrepared = async () => {},prepareAndBroadcast }) {
  let now = Date.now();
  const clock = { now: () => now };
  const manager = createTransactionManager({ config,pool,queue,legacy,clock });
  const signedFields = ["attemptId","attemptNumber","replacementOfAttemptId","nonce","gasLimit","transactionType",
    "maxFeePerGas","maxPriorityFeePerGas","rawSignedTransaction","transactionHash","createdAt"];
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
    const parentTransaction = await destination.request({ method: "eth_getTransactionByHash",params: [first.attempt.transactionHash] });
    assert.ok(parentTransaction,"the real parent must be present and pending before replacement preparation");
    verifyRpcTransaction(first.intent,first.attempt,parentTransaction);
    assert.equal(parentTransaction.blockNumber,null);
    assert.equal(await destination.request({ method: "eth_getTransactionReceipt",params: [first.attempt.transactionHash] }),null);
    now = Math.max(now,Date.parse(first.attempt.broadcastAt)) + config.replacementAfterMs;
    const replacement = await manager.prepareReplacement(jobId,first.attempt.attemptId);
    assert.equal(replacement.created,true);
    assert.equal(replacement.attempt.status,"SIGNED");
    assert.equal(replacement.attempt.broadcastAttemptCount,"0");
    assert.equal(replacement.attempts.length,2);
    assert.equal((await manager.repository.getBroadcastEvents(jobId)).some(event => event.attemptId === replacement.attempt.attemptId),false);
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
    const jobResult = result.results.find(record => record.deliveryJobId === jobId);
    const recoveryResult = jobResult?.recovery?.results.find(record => record.deliveryJobId === jobId);
    console.log(`Replacement retry recovery: ${JSON.stringify({ deliveryJobId: jobId,action: jobResult?.action ?? null,
      broadcasts: result.broadcasts,replacements: result.replacements,recoveryAction: recoveryResult?.action ?? null,
      transactionHash: recoveryResult?.transactionHash ?? null,expectedTransactionHash: replacement.attempt.transactionHash,
      errorCode: recoveryResult?.errorCode ?? recoveryResult?.reason ?? recoveryResult?.errorClass ?? null })}`);
    assert.equal(result.replacements,0);
    assert.equal(result.broadcasts,1);
    assert.ok(jobResult,"the retry pass must report the target job");
    assert.equal(jobResult.action,"RECOVERY");
    assert.equal(jobResult.recovery.rebroadcast,1);
    assert.ok(recoveryResult,"delegated recovery must report the target job");
    assert.equal(recoveryResult.action,"REBROADCAST");
    assert.equal(recoveryResult.transactionHash,replacement.attempt.transactionHash);
    const sent = await manager.repository.getTransaction(jobId);
    assert.equal(sent.intent.status,"PENDING"); assert.equal(sent.intent.winningAttemptId,null);
    assert.equal(sent.intent.retryStoppedAt,null); assert.equal(sent.attempt.status,"BROADCAST");
    assert.equal(sent.attempts.length,2); assert.deepEqual(sent.attempts.map(attempt => attempt.attemptNumber),[0,1]);
    for (const field of signedFields) {
      assert.equal(sent.attempt[field],replacement.attempt[field]);
      assert.equal(sent.attempts[0][field],first.attempt[field]);
    }
    for (const field of ["intentId","nonce","chainId","senderAddress","destinationGateway","value","calldata","packageDigest"]) {
      assert.equal(sent.intent[field],replacement.intent[field]);
    }
    assert.equal(sent.attempt.broadcastAttemptCount,"1");
    const journal = (await manager.repository.getBroadcastEvents(jobId)).filter(event => event.attemptId === sent.attempt.attemptId);
    assert.ok(journal.some(event => event.endpointLabel !== null),"actual replacement send must have a durable endpoint marker");
    assert.ok(journal.every(event => event.completedAt !== null),"successful recovery must complete its started broadcast journal");
    for (const event of journal) if (event.returnedTransactionHash !== null) assert.equal(event.returnedTransactionHash,sent.attempt.transactionHash);
    assert.deepEqual(await manager.repository.getAccount(),account);
    const pendingTransaction = await destination.request({ method: "eth_getTransactionByHash",params: [sent.attempt.transactionHash] });
    assert.ok(pendingTransaction,"Chain B must expose the exact persisted replacement before controlled mining");
    verifyRpcTransaction(sent.intent,sent.attempt,pendingTransaction);
    assert.equal(pendingTransaction.blockNumber,null);
    assert.equal(await destination.request({ method: "eth_getTransactionReceipt",params: [sent.attempt.transactionHash] }),null);
    console.log(`VALID: delegated RECOVERY reported REBROADCAST for exact persisted replacement ${sent.attempt.transactionHash}; real Chain B transaction pending; same nonce, bytes, gas, fees and two-attempt lineage`);
    await destination.request({ method: "anvil_mine",params: ["0x1"] });
    const receipt = await destination.request({ method: "eth_getTransactionReceipt",params: [sent.attempt.transactionHash] });
    assert.ok(receipt,"real replacement must be mined after the controlled pending window");
    assert.equal(BigInt(receipt.status),1n);
    const minedTransaction = await destination.request({ method: "eth_getTransactionByHash",params: [sent.attempt.transactionHash] });
    verifyRpcTransaction(sent.intent,sent.attempt,minedTransaction,receipt);
    const receiptBlock = await destination.request({ method: "eth_getBlockByNumber",params: [receipt.blockNumber,false] });
    assert.ok(receiptBlock); assert.equal(BigInt(receiptBlock.number),BigInt(receipt.blockNumber));
    assert.equal(receiptBlock.hash.toLowerCase(),receipt.blockHash.toLowerCase());
    assert.equal(await destination.request({ method: "eth_getTransactionReceipt",params: [first.attempt.transactionHash] }),null);
    if (config.destinationConfirmations > 1n) await destination.request({ method: "anvil_mine",params: [toHex(config.destinationConfirmations - 1n)] });
    await manager.checkReceiptsOnce();
    const finalized = await manager.repository.getTransaction(jobId);
    assert.equal(finalized.intent.status,"CONFIRMED");
    assert.equal(finalized.intent.winningAttemptId,sent.attempt.attemptId);
    assert.equal(finalized.winningAttempt.transactionHash,sent.attempt.transactionHash);
    assert.equal(finalized.winningAttempt.receiptBlockNumber,BigInt(receipt.blockNumber).toString());
    assert.equal(finalized.winningAttempt.receiptBlockHash,receipt.blockHash.toLowerCase());
    assert.equal(finalized.winningAttempt.receiptStatus,1);
    assert.equal(finalized.attempts.length,2);
    assert.equal(finalized.attempts[0].status,"REPLACED");
    for (const field of signedFields) {
      assert.equal(finalized.attempt[field],replacement.attempt[field]);
      assert.equal(finalized.attempts[0][field],first.attempt[field]);
    }
    assert.deepEqual(await manager.repository.getAccount(),account);
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
