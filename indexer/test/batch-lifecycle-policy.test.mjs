import assert from "node:assert/strict";
import test from "node:test";

import {
  BATCH_STATUS,
  nextBatchEpoch,
  nextBatchStatus,
  normalizeBatchEpoch,
  validateBatchTransition,
} from "../src/batch-lifecycle-policy.mjs";

test("the conceptual lifecycle contains all four ordered states", () => {
  assert.deepEqual(Object.values(BATCH_STATUS), ["BUILDING", "SEALED", "CONSENSUS_PENDING", "COMMITTED"]);
  assert.equal(nextBatchStatus("BUILDING"), "SEALED");
  assert.equal(nextBatchStatus("SEALED"), "CONSENSUS_PENDING");
  assert.equal(nextBatchStatus("CONSENSUS_PENDING"), "COMMITTED");
  assert.equal(nextBatchStatus("COMMITTED"), null);
  for (const [from, to] of [["BUILDING", "SEALED"], ["SEALED", "CONSENSUS_PENDING"], ["CONSENSUS_PENDING", "COMMITTED"]]) {
    assert.doesNotThrow(() => validateBatchTransition(from, to));
  }
});

test("skip and backward transitions fail while same-state retries are no-ops", () => {
  for (const from of Object.values(BATCH_STATUS)) {
    assert.doesNotThrow(() => validateBatchTransition(from, from));
    for (const to of Object.values(BATCH_STATUS)) {
      if (from !== to && nextBatchStatus(from) !== to) {
        assert.throws(() => validateBatchTransition(from, to), /illegal batch lifecycle transition/);
      }
    }
  }
  for (const status of ["UNKNOWN", "", undefined, null]) {
    assert.throws(() => nextBatchStatus(status), /unknown batch lifecycle status/);
    assert.throws(() => validateBatchTransition("SEALED", status), /unknown batch lifecycle status/);
  }
});

test("batch epochs are exact uint256 values independent of clocks and validator epochs", () => {
  const large = (1n << 200n) + 7n;
  assert.equal(normalizeBatchEpoch(large.toString()), large);
  assert.equal(nextBatchEpoch(large), large + 1n);
  assert.equal(nextBatchEpoch(0n), 1n);
  assert.equal(nextBatchEpoch((1n << 256n) - 2n), (1n << 256n) - 1n);
  assert.throws(() => nextBatchEpoch((1n << 256n) - 1n), /uint256 overflow/);
  for (const epoch of [undefined, null, true, "", -1n, 1n << 256n, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeBatchEpoch(epoch), /invalid batch epoch/);
  }
});
