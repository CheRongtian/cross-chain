import { normalizeAddress, normalizeBytes32 } from "../canonical-message.mjs";
import { rpcQuantity } from "./transaction.mjs";
import { TransactionError } from "./config.mjs";

export function verifyRpcTransaction(intent, attempt, tx, receipt) {
  if (!tx || normalizeBytes32(tx.hash) !== attempt.transactionHash || normalizeAddress(tx.from) !== intent.senderAddress ||
      normalizeAddress(tx.to) !== intent.destinationGateway || tx.input?.toLowerCase() !== intent.calldata ||
      rpcQuantity(tx.nonce,"transaction nonce").toString() !== intent.nonce || rpcQuantity(tx.value,"transaction value") !== 0n ||
      rpcQuantity(tx.type,"transaction type") !== 2n || rpcQuantity(tx.chainId,"transaction chain").toString() !== intent.chainId ||
      rpcQuantity(tx.gas,"transaction gas").toString() !== attempt.gasLimit ||
      rpcQuantity(tx.maxFeePerGas,"transaction fee").toString() !== attempt.maxFeePerGas ||
      rpcQuantity(tx.maxPriorityFeePerGas,"transaction priority fee").toString() !== attempt.maxPriorityFeePerGas) throw new TransactionError("RECEIPT_TRANSACTION_CONTEXT_MISMATCH");
  if (receipt && (rpcQuantity(tx.blockNumber,"transaction block") !== rpcQuantity(receipt.blockNumber,"receipt block") ||
      normalizeBytes32(tx.blockHash) !== normalizeBytes32(receipt.blockHash))) throw new TransactionError("RECEIPT_TRANSACTION_CONTEXT_MISMATCH");
  return tx;
}

export async function inspectIntentReceipts({ stored, rpc, store, config, head, forceAll = false }) {
  const observations = [];
  for (const attempt of stored.attempts) {
    if (!forceAll && BigInt(attempt.broadcastAttemptCount) === 0n && attempt.broadcastAt === null) continue;
    const receipt = await rpc.receipt(attempt.transactionHash);
    if (receipt === null) continue;
    if (!receipt || normalizeBytes32(receipt.transactionHash) !== attempt.transactionHash) throw new TransactionError("RECEIPT_TRANSACTION_HASH_MISMATCH");
    const blockNumber = rpcQuantity(receipt.blockNumber,"receipt block");
    const blockHash = normalizeBytes32(receipt.blockHash,"receipt block hash");
    const status = rpcQuantity(receipt.status,"receipt status");
    if (status !== 0n && status !== 1n) throw new TransactionError("INVALID_RECEIPT_STATUS");
    const block = await rpc.block(blockNumber);
    if (!block || rpcQuantity(block.number,"canonical block") !== blockNumber || normalizeBytes32(block.hash) !== blockHash) throw new TransactionError("NONCANONICAL_TRANSACTION_RECEIPT");
    verifyRpcTransaction(stored.intent,attempt,await rpc.transaction(attempt.transactionHash),receipt);
    observations.push({ attempt,blockNumber,blockHash,status: Number(status) });
  }
  if (observations.length > 1) throw new TransactionError("CONFLICTING_CANONICAL_NONCE_WINNERS");
  const winner = observations[0];
  if (!winner) return { stored,mined: false,finalized: false };
  if (head < winner.blockNumber || head - winner.blockNumber + 1n < config.destinationConfirmations) return { stored,mined: true,finalized: false };
  const finalized = await store.recordOutcome(stored.intent.deliveryJobId,{ transactionHash: winner.attempt.transactionHash,
    blockNumber: winner.blockNumber,blockHash: winner.blockHash,status: winner.status,head });
  return { stored: finalized,mined: true,finalized: true };
}
