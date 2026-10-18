export function formatRelayerSummary(record) {
  const latestAttempt = record.attempt;
  // The repository has already resolved the canonical receipt winner.
  const displayAttempt = record.winningAttempt ?? latestAttempt;
  return {
    deliveryJobId: record.intent?.deliveryJobId ?? record.historicalSubmission?.deliveryJobId ?? record.deliveryJobId,
    transactionHash: displayAttempt?.transactionHash ?? record.historicalSubmission?.transactionHash,
    ...(displayAttempt ? { nonce: displayAttempt.nonce } : {}),
    ...(record.intent ? { intentStatus: record.intent.status } : {}),
    ...(latestAttempt ? { latestAttempt: {
      transactionHash: latestAttempt.transactionHash,
      status: latestAttempt.status,
      attemptNumber: latestAttempt.attemptNumber,
    } } : {}),
    reason: record.reason,
    retryAt: record.retryAt,
    status: record.intent ? record.intent.status : latestAttempt?.status ?? record.action ?? "HISTORICAL",
    workerId: record.workerId,
    fencingToken: record.fencingToken,
    submitted: record.submitted,
  };
}
