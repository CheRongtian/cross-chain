import { classifyBroadcastError } from "./rpc-errors.mjs";
import { operationTime, replacementDue } from "./retry-policy.mjs";
import { TransactionError } from "./config.mjs";

export async function processTransactionRetriesOnce({ config, store, rpc, verifyChain, inspect, send, replace, recover, clock, limit = config.maxJobs,deliveryJobId,fence }) {
  const now = operationTime(clock);
  const target = deliveryJobId === undefined ? null : await store.getTransaction(deliveryJobId);
  const due = deliveryJobId === undefined ? await store.listDueIntents({ now,limit }) :
    target?.intent.status === "PENDING" && target.intent.retryStoppedAt === null && new Date(target.intent.nextActionAt).getTime() <= now ? [target] : [];
  if (!due.length) return Object.freeze({ processed: 0,replacements: 0,broadcasts: 0,results: [] });
  let view;
  try { await verifyChain(); view = await rpc.readView(); }
  catch (error) {
    const reason = classifyBroadcastError(error,{ operation: "read" });
    if (!["TRANSIENT_RPC_ERROR","AMBIGUOUS_BROADCAST"].includes(reason)) throw error;
    for (const record of due) await store.scheduleRetry(record.intent.deliveryJobId,{ reason,parentAttemptId: record.attempt.attemptId,fence });
    return Object.freeze({ processed: due.length,replacements: 0,broadcasts: 0,results: due.map(record => ({ deliveryJobId: record.intent.deliveryJobId,action: "RETRY_SCHEDULED",errorClass: reason })) });
  }
  const results = [];
  let replacements = 0;
  let broadcasts = 0;
  for (const candidate of due) {
    const id = candidate.intent.deliveryJobId;
    let current = await store.getTransaction(id);
    if (current.intent.status !== "PENDING" || current.intent.retryStoppedAt !== null || new Date(current.intent.nextActionAt).getTime() > now) continue;
    try {
      const snapshot = await store.getRecoverySnapshot(id);
      if ((snapshot.attempt.status === "SIGNED" && BigInt(snapshot.attempt.broadcastAttemptCount) === 0n) ||
          snapshot.broadcastEvents.some(event => event.attemptId === snapshot.attempt.attemptId && event.completedAt === null)) {
        const recovered = await recover(id,fence,view);
        broadcasts += recovered.rebroadcast;
        results.push({ deliveryJobId: id,action: "RECOVERY",recovery: recovered });
        continue;
      }
      const observation = await inspect(current,view,false,fence);
      current = observation.stored;
      if (observation.mined) {
        if (!observation.finalized) await store.scheduleRetry(id,{ parentAttemptId: current.attempt.attemptId,fence });
        results.push({ deliveryJobId: id,action: observation.finalized ? current.intent.status : "AWAITING_CONFIRMATIONS" });
        continue;
      }
      if (!current.intent.reorgRecovery?.rebroadcastRequired && replacementDue(current.attempt,now,config)) {
        const prepared = await replace(id,current.attempt.attemptId,view,fence);
        if (!prepared.created) {
          if (prepared.intent.status === "PENDING" && prepared.intent.retryStoppedAt === null && prepared.attempt.attemptId === current.attempt.attemptId) {
            await store.scheduleRetry(id,{ parentAttemptId: current.attempt.attemptId,expectedVersion: snapshot.version,fence });
          }
          results.push({ deliveryJobId: id,action: prepared.intent.retryStoppedAt ? prepared.intent.retryStopReason : "NO_REPLACEMENT" });
          continue;
        }
        replacements++;
        current = prepared;
      }
      const result = await send(id,{ rebroadcast: true,expectedAttemptId: current.attempt.attemptId,receiptView: view,fence,
        ...(current.intent.reorgRecovery ? { expectedVersion: snapshot.version } : {}) });
      if (result.broadcast) broadcasts++;
      results.push({ deliveryJobId: id,action: result.errorClass ? "RETRY_SCHEDULED" : result.intent.status !== "PENDING" ? result.intent.status : result.broadcast ? "BROADCAST" : "ATTEMPT_CHANGED",
        errorClass: result.errorClass ?? null,attemptId: result.attempt.attemptId,transactionHash: result.attempt.transactionHash });
    } catch (error) {
      if (error.code === "TRANSACTION_RECOVERY_BUSY" || error.code === "RECOVERY_STATE_CHANGED") {
        results.push({ deliveryJobId: id,action: error.code });
        continue;
      }
      if (error.code === "EARLIER_SIGNED_TRANSACTION_BLOCKS_BROADCAST") {
        await store.scheduleRetry(id,{ parentAttemptId: current.attempt.attemptId,fence });
        results.push({ deliveryJobId: id,action: "BLOCKED_BY_EARLIER_NONCE" });
        continue;
      }
      const reason = classifyBroadcastError(error);
      if (["TRANSIENT_RPC_ERROR","AMBIGUOUS_BROADCAST"].includes(reason)) {
        await store.scheduleRetry(id,{ reason,parentAttemptId: current.attempt.attemptId,fence });
        results.push({ deliveryJobId: id,action: "RETRY_SCHEDULED",errorClass: reason });
        continue;
      }
      if (error instanceof TransactionError && ["MAX_ATTEMPTS_REACHED","FEE_CAP_EXCEEDED","REPLACEMENT_FEE_OVERFLOW"].includes(error.code)) {
        await store.stopRetry(id,error.code,{ parentAttemptId: current.attempt.attemptId,fence });
        results.push({ deliveryJobId: id,action: error.code });
        continue;
      }
      throw error;
    }
  }
  return Object.freeze({ processed: results.length,replacements,broadcasts,results: Object.freeze(results) });
}
