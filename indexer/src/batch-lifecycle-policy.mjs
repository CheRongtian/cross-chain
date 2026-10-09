import { toUint256 } from "./canonical-message.mjs";

export const BATCH_STATUS = Object.freeze({
  BUILDING: "BUILDING",
  SEALED: "SEALED",
  CONSENSUS_PENDING: "CONSENSUS_PENDING",
  COMMITTED: "COMMITTED",
});

const NEXT_STATUS = Object.freeze({
  BUILDING: BATCH_STATUS.SEALED,
  SEALED: BATCH_STATUS.CONSENSUS_PENDING,
  CONSENSUS_PENDING: BATCH_STATUS.COMMITTED,
  COMMITTED: null,
});

export function nextBatchStatus(status) {
  if (!Object.hasOwn(NEXT_STATUS, status)) {
    throw new Error("unknown batch lifecycle status");
  }
  return NEXT_STATUS[status];
}

// Describes the conceptual graph. It grants no database or consensus authority.
export function validateBatchTransition(fromStatus, toStatus) {
  const next = nextBatchStatus(fromStatus);
  nextBatchStatus(toStatus);
  if (fromStatus !== toStatus && next !== toStatus) {
    throw new Error(`illegal batch lifecycle transition: ${fromStatus} to ${toStatus}`);
  }
}

export function normalizeBatchEpoch(epoch) {
  if (
    typeof epoch !== "bigint" &&
    !(typeof epoch === "string" && /^[0-9]+$/.test(epoch)) &&
    !(typeof epoch === "number" && Number.isSafeInteger(epoch))
  ) {
    throw new Error("invalid batch epoch");
  }
  return toUint256(epoch, "batch epoch");
}

export function nextBatchEpoch(epoch) {
  const next = normalizeBatchEpoch(epoch) + 1n;
  if (next >= (1n << 256n)) {
    throw new Error("batch epoch uint256 overflow");
  }
  return next;
}
