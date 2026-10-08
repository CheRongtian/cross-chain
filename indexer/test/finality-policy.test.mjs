import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateBlockDepth,
  determineFinalityTransition,
  isFinalizedByDepth,
  MESSAGE_STATUS,
} from "../src/finality-policy.mjs";

test("calculates successor-block depth with BigInt arithmetic", () => {
  const sourceBlockNumber = (1n << 200n) + 100n;
  assert.equal(
    calculateBlockDepth({ sourceBlockNumber, headBlockNumber: sourceBlockNumber + 7n }),
    7n,
  );
});

test("finalizes exactly at the configured successor-block boundary", () => {
  assert.equal(
    isFinalizedByDepth({
      sourceBlockNumber: 100n,
      headBlockNumber: 102n,
      finalityBlockDepth: 3n,
    }),
    false,
  );
  assert.equal(
    isFinalizedByDepth({
      sourceBlockNumber: 100n,
      headBlockNumber: 103n,
      finalityBlockDepth: 3n,
    }),
    true,
  );
});

test("depth zero makes an observed source block immediately eligible", () => {
  assert.equal(
    isFinalizedByDepth({
      sourceBlockNumber: 100n,
      headBlockNumber: 100n,
      finalityBlockDepth: 0n,
    }),
    true,
  );
});

test("determines only legal forward lifecycle transitions", () => {
  assert.equal(
    determineFinalityTransition({
      status: MESSAGE_STATUS.OBSERVED,
      sourceBlockNumber: 100n,
      headBlockNumber: 101n,
      finalityBlockDepth: 2n,
    }),
    MESSAGE_STATUS.FINALIZING,
  );
  assert.equal(
    determineFinalityTransition({
      status: MESSAGE_STATUS.OBSERVED,
      sourceBlockNumber: 100n,
      headBlockNumber: 102n,
      finalityBlockDepth: 2n,
    }),
    MESSAGE_STATUS.FINALIZED,
  );
  assert.equal(
    determineFinalityTransition({
      status: MESSAGE_STATUS.FINALIZING,
      sourceBlockNumber: 100n,
      headBlockNumber: 101n,
      finalityBlockDepth: 2n,
    }),
    null,
  );
  assert.equal(
    determineFinalityTransition({
      status: MESSAGE_STATUS.FINALIZING,
      sourceBlockNumber: 100n,
      headBlockNumber: 102n,
      finalityBlockDepth: 2n,
    }),
    MESSAGE_STATUS.FINALIZED,
  );
  assert.equal(
    determineFinalityTransition({
      status: MESSAGE_STATUS.FINALIZED,
      sourceBlockNumber: 100n,
      headBlockNumber: 102n,
      finalityBlockDepth: 2n,
    }),
    null,
  );
  assert.equal(
    determineFinalityTransition({
      status: MESSAGE_STATUS.REORGED,
      sourceBlockNumber: 100n,
      headBlockNumber: 1_000n,
      finalityBlockDepth: 2n,
    }),
    null,
  );
});

test("rejects an unknown lifecycle status", () => {
  assert.throws(
    () =>
      determineFinalityTransition({
        status: "UNKNOWN",
        sourceBlockNumber: 100n,
        headBlockNumber: 100n,
        finalityBlockDepth: 0n,
      }),
    /unknown message lifecycle status/,
  );
});

test("rejects a source block greater than the head snapshot", () => {
  assert.throws(
    () =>
      calculateBlockDepth({
        sourceBlockNumber: 101n,
        headBlockNumber: 100n,
      }),
    /source block 101 is greater than the finality head 100/,
  );
});
