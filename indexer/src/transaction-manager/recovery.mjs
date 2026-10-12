import { observeIntentReceipts, verifyRpcTransaction } from "./receipts.mjs";
import { rpcQuantity } from "./transaction.mjs";
import { TransactionError } from "./config.mjs";
import { safeRelayerMessage } from "../relayer/config.mjs";

export function classifyRecovery(snapshot) {
  if (!snapshot) return "NO_INTENT";
  if (snapshot.intent.status === "CONFIRMED") return "FINAL_CONFIRMED";
  if (snapshot.intent.status === "REVERTED") return "FINAL_REVERTED";
  if (snapshot.intent.retryStoppedAt !== null) return "RETRY_EXHAUSTED";
  if (snapshot.broadcastEvents.some(event => event.completedAt === null)) return "AMBIGUOUS_BROADCAST";
  if (snapshot.attempt.status === "SIGNED") return "SIGNED_NOT_STARTED";
  return snapshot.attempt.attemptNumber ? "REPLACEMENT_PENDING" : "BROADCAST_PENDING";
}

export async function recoverTransaction({ id,store,rpc,config,send,hooks = {},fence,context }) {
  const snapshot = await store.getRecoverySnapshot(id);
  const classification = classifyRecovery(snapshot);
  if (!snapshot || snapshot.intent.status !== "PENDING") return { deliveryJobId: id,action: "UNCHANGED",classification };
  context.assertHeld();
  // All remote reads precede recovery mutation. A missing response is not proof
  // of non-submission, and an unavailable/conflicting view writes nothing.
  if (await rpc.verifyChain() !== config.destinationDomain) throw new TransactionError("CHAIN_ID_MISMATCH");
  const view = await rpc.readView();
  const observation = await observeIntentReceipts({ stored: snapshot,rpc,config,view,forceAll: true,hooks });
  context.assertHeld();
  if (observation.winner) {
    const winner = observation.winner;
    const stored = await store.applyRecoveryObservation(snapshot,observation.finalizable ? {
      fence,receipt: { transactionHash: winner.attempt.transactionHash,blockNumber: winner.blockNumber,
        blockHash: winner.blockHash,status: winner.status,head: view.head },
    } : { fence,knownAttempts: [winner.attempt.attemptId] });
    return { deliveryJobId: id,action: observation.finalizable ? "FINALIZED" : "RECEIPT_UNCONFIRMED",classification,
      transactionHash: winner.attempt.transactionHash,status: stored.intent.status };
  }
  const known = []; let knownMined = false;
  for (const attempt of snapshot.attempts) {
    const tx = await rpc.transaction(attempt.transactionHash);
    if (tx === null) continue;
    verifyRpcTransaction(snapshot.intent,attempt,tx);
    if (tx.blockNumber != null) {
      const number = rpcQuantity(tx.blockNumber);
      const block = await rpc.block(number);
      if (!block || rpcQuantity(block.number) !== number || block.hash?.toLowerCase() !== tx.blockHash?.toLowerCase()) throw new TransactionError("NONCANONICAL_TRANSACTION_RECEIPT");
      knownMined = true;
    }
    known.push(attempt.attemptId);
  }
  const latest = await rpc.latestNonce(view);
  context.assertHeld();
  if (latest > BigInt(snapshot.intent.nonce) && !knownMined) {
    // A stale pending body cannot explain nonce consumption in the canonical
    // snapshot. Keep the signed identity and stop for operator investigation.
    await store.stopRetry(id,"UNKNOWN_NONCE_CONSUMPTION",{ fence,parentAttemptId: snapshot.attempt.attemptId,expectedVersion: snapshot.version });
    return { deliveryJobId: id,action: "MANUAL_ACTION_REQUIRED",reason: "UNKNOWN_NONCE_CONSUMPTION",classification };
  }
  if (known.length) {
    const needsMutation = snapshot.broadcastEvents.some(event => event.completedAt === null && known.includes(event.attemptId)) ||
      snapshot.attempts.some(attempt => known.includes(attempt.attemptId) && attempt.broadcastAt === null);
    if (needsMutation) await store.applyRecoveryObservation(snapshot,{ fence,knownAttempts: known });
    return { deliveryJobId: id,action: needsMutation ? "RECONCILED" : "UNCHANGED",classification };
  }
  await store.assertRecoverySnapshot(snapshot,{ fence });
  if (snapshot.intent.retryStoppedAt !== null) return { deliveryJobId: id,action: "MANUAL_ACTION_REQUIRED",reason: snapshot.intent.retryStopReason,classification };
  // A crash never creates a new candidate. Once a started send has completed
  // and its due time is in the future, leave ordinary retry policy in control.
  const unresolved = snapshot.broadcastEvents.some(event => event.completedAt === null);
  if (!unresolved && BigInt(snapshot.attempt.broadcastAttemptCount) > 0n) return { deliveryJobId: id,action: "UNCHANGED",classification };
  const sent = await send(id,{ fence,recoveryContext: context,rebroadcast: true,expectedAttemptId: snapshot.attempt.attemptId,expectedVersion: snapshot.version });
  if (sent.errorClass) return { deliveryJobId: id,action: "UNCHANGED",classification,errorClass: sent.errorClass,
    errorCode: sent.errorCode ?? sent.errorClass,
    errorMessage: safeRelayerMessage({ message: sent.errorMessage ?? sent.errorCode ?? sent.errorClass },config),
    rpcObservations: sent.rpcObservations ?? [] };
  const fresh = await store.getRecoverySnapshot(id);
  context.assertHeld();
  // The new accepted send resolves knowledge of this hash, without claiming
  // that any old incomplete endpoint request itself returned success.
  await store.applyRecoveryObservation(fresh,{ fence,knownAttempts: [snapshot.attempt.attemptId] });
  return { deliveryJobId: id,action: sent.intent.status === "PENDING" ? "REBROADCAST" : "FINALIZED",classification,transactionHash: sent.attempt.transactionHash,
    acceptedEndpointLabel: sent.acceptedEndpointLabel ?? null,rpcObservations: sent.rpcObservations ?? [] };
}

export async function recoverTransactionsOnce({ store,rpc,config,send,hooks,limit = config.maxJobs,deliveryJobId,fence }) {
  const ids = deliveryJobId === undefined ? await store.listRecoveryIntents({ limit }) : [deliveryJobId];
  const results = [];
  for (const id of ids) {
    try {
      results.push(await store.withRecoveryLock(id,context => recoverTransaction({ id,store,rpc,config,send,hooks,fence,context })));
    } catch (error) {
      if (["TRANSACTION_RECOVERY_BUSY","RECOVERY_STATE_CHANGED"].includes(error.code)) results.push({ deliveryJobId: id,action: "UNCHANGED",reason: error.code });
      else if (["RPC_UNAVAILABLE","INCONSISTENT_RPC_VIEW","RPC_VIEW_INCOMPLETE","NONCANONICAL_TRANSACTION_RECEIPT","CONFLICTING_CANONICAL_NONCE_WINNERS"].includes(error.code)) {
        results.push({ deliveryJobId: id,action: "UNCHANGED",reason: error.code,errorCode: error.code,
          errorMessage: safeRelayerMessage(error,config),rpcObservations: error.observations ?? [] });
      } else throw error;
    }
  }
  return Object.freeze({ scanned: ids.length,reconciled: results.filter(r => ["RECONCILED","RECEIPT_UNCONFIRMED"].includes(r.action)).length,
    rebroadcast: results.filter(r => r.action === "REBROADCAST").length,finalized: results.filter(r => r.action === "FINALIZED").length,
    unchanged: results.filter(r => r.action === "UNCHANGED").length,manualActionRequired: results.filter(r => r.action === "MANUAL_ACTION_REQUIRED").length,
    results: Object.freeze(results) });
}
