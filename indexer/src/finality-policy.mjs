import { toUint256 } from "./canonical-message.mjs";

export const MESSAGE_STATUS = Object.freeze({
  OBSERVED: "OBSERVED",
  FINALIZING: "FINALIZING",
  FINALIZED: "FINALIZED",
  REORGED: "REORGED",
});

export function calculateBlockDepth({ sourceBlockNumber, headBlockNumber }) {
  const sourceBlock = toUint256(sourceBlockNumber, "source block number");
  const headBlock = toUint256(headBlockNumber, "head block number");

  if (sourceBlock > headBlock) {
    throw new Error(
      `source block ${sourceBlock} is greater than the finality head ${headBlock}`,
    );
  }

  return headBlock - sourceBlock;
}

export function isFinalizedByDepth({
  sourceBlockNumber,
  headBlockNumber,
  finalityBlockDepth,
}) {
  const requiredDepth = toUint256(finalityBlockDepth, "finality block depth");
  return calculateBlockDepth({ sourceBlockNumber, headBlockNumber }) >= requiredDepth;
}

export function determineFinalityTransition({
  status,
  sourceBlockNumber,
  headBlockNumber,
  finalityBlockDepth,
}) {
  if (!Object.values(MESSAGE_STATUS).includes(status)) {
    throw new Error(`unknown message lifecycle status: ${status}`);
  }
  if (status === MESSAGE_STATUS.FINALIZED || status === MESSAGE_STATUS.REORGED) {
    return null;
  }

  const finalized = isFinalizedByDepth({
    sourceBlockNumber,
    headBlockNumber,
    finalityBlockDepth,
  });

  if (status === MESSAGE_STATUS.OBSERVED) {
    return finalized ? MESSAGE_STATUS.FINALIZED : MESSAGE_STATUS.FINALIZING;
  }
  return finalized ? MESSAGE_STATUS.FINALIZED : null;
}
