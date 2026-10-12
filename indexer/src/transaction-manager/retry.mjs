import { classifyBroadcastError } from "./rpc-errors.mjs";
import { operationTime, replacementDue } from "./retry-policy.mjs";
import { TransactionError } from "./config.mjs";

export async function processTransactionRetriesOnce({ config, store, rpc, verifyChain, inspect, send, replace, clock, limit = config.maxJobs }) {
  const now = operationTime(clock);
  const due = await store.listDueIntents({ now,limit });
  if (!due.length) return Object.freeze({ processed: 0,replacements: 0,broadcasts: 0,results: [] });
  let head;
  try { await verifyChain(); head = await rpc.head(); }
  catch (error) {
    const reason = classifyBroadcastError(error);
    if (!["TRANSIENT_RPC_ERROR","AMBIGUOUS_BROADCAST"].includes(reason)) throw error;
    for (const record of due) await store.scheduleRetry(record.intent.deliveryJobId,{ reason,parentAttemptId: record.attempt.attemptId });
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
      const observation = await inspect(current,head);
      current = observation.stored;
      if (observation.mined) {
        if (!observation.finalized) await store.scheduleRetry(id,{ parentAttemptId: current.attempt.attemptId });
        results.push({ deliveryJobId: id,action: observation.finalized ? current.intent.status : "AWAITING_CONFIRMATIONS" });
        continue;
      }
      if (replacementDue(current.attempt,now,config)) {
        const prepared = await replace(id,current.attempt.attemptId,head);
        if (!prepared.created) { results.push({ deliveryJobId: id,action: prepared.intent.retryStoppedAt ? prepared.intent.retryStopReason : "NO_REPLACEMENT" }); continue; }
        replacements++;
        current = prepared;
      }
      const result = await send(id,{ rebroadcast: true,expectedAttemptId: current.attempt.attemptId,receiptHead: head });
      if (result.broadcast) broadcasts++;
      results.push({ deliveryJobId: id,action: result.errorClass ? "RETRY_SCHEDULED" : result.intent.status !== "PENDING" ? result.intent.status : result.broadcast ? "BROADCAST" : "ATTEMPT_CHANGED",
        errorClass: result.errorClass ?? null,attemptId: result.attempt.attemptId,transactionHash: result.attempt.transactionHash });
    } catch (error) {
      if (error.code === "EARLIER_SIGNED_TRANSACTION_BLOCKS_BROADCAST") {
        await store.scheduleRetry(id,{ parentAttemptId: current.attempt.attemptId });
        results.push({ deliveryJobId: id,action: "BLOCKED_BY_EARLIER_NONCE" });
        continue;
      }
      const reason = classifyBroadcastError(error);
      if (["TRANSIENT_RPC_ERROR","AMBIGUOUS_BROADCAST"].includes(reason)) {
        await store.scheduleRetry(id,{ reason,parentAttemptId: current.attempt.attemptId });
        results.push({ deliveryJobId: id,action: "RETRY_SCHEDULED",errorClass: reason });
        continue;
      }
      if (error instanceof TransactionError && ["MAX_ATTEMPTS_REACHED","FEE_CAP_EXCEEDED","REPLACEMENT_FEE_OVERFLOW"].includes(error.code)) {
        await store.stopRetry(id,error.code,{ parentAttemptId: current.attempt.attemptId });
        results.push({ deliveryJobId: id,action: error.code });
        continue;
      }
      throw error;
    }
  }
  return Object.freeze({ processed: results.length,replacements,broadcasts,results: Object.freeze(results) });
}
