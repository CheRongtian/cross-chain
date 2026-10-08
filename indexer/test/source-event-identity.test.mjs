import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSourceEventIdentity,
  sameSourceEventIdentity,
  sourceEventIdentityKey,
} from "../src/source-event-identity.mjs";

const EVENT = {
  sourceDomain: 10_011n,
  sourceGateway: "0x000000000000000000000000000000000000ABCD",
  sourceBlockHash: `0x${"AB".repeat(32)}`,
  sourceTransactionHash: `0x${"CD".repeat(32)}`,
  sourceLogIndex: 7n,
};

test("normalizes deterministic source-event identity", () => {
  const normalized = normalizeSourceEventIdentity(EVENT);

  assert.deepEqual(normalized, {
    sourceDomain: "10011",
    sourceGateway: "0x000000000000000000000000000000000000abcd",
    sourceBlockHash: `0x${"ab".repeat(32)}`,
    sourceTransactionHash: `0x${"cd".repeat(32)}`,
    sourceLogIndex: "7",
  });
  assert.equal(sourceEventIdentityKey(EVENT), sourceEventIdentityKey(normalized));
  assert.equal(sameSourceEventIdentity(EVENT, normalized), true);
});

for (const [label, changed] of [
  ["source domain", { sourceDomain: 10_012n }],
  ["source gateway", { sourceGateway: "0x000000000000000000000000000000000000abce" }],
  ["block hash", { sourceBlockHash: `0x${"ef".repeat(32)}` }],
  ["transaction hash", { sourceTransactionHash: `0x${"12".repeat(32)}` }],
  ["log index", { sourceLogIndex: 8n }],
]) {
  test(`treats a different ${label} as a different source occurrence`, () => {
    assert.equal(sameSourceEventIdentity(EVENT, { ...EVENT, ...changed }), false);
  });
}
