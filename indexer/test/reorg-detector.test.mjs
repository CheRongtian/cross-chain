import assert from "node:assert/strict";
import test from "node:test";

import { NoCommonAncestorError } from "../src/canonical-block.mjs";
import { createCanonicalReconciler } from "../src/reorg-detector.mjs";

const CONFIG = {
  chainDomain: 10_011n,
  sourceGateway: "0x0000000000000000000000000000000000001001",
  sourceGatewayStartBlock: 10n,
  databaseSchema: "unused_in_unit_test",
};

function hash(value) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function block(number, hashValue = number + 1n, parentHashValue = number) {
  return { number, hash: hash(hashValue), parentHash: hash(parentHashValue) };
}

function publicClientFor(blocks) {
  return {
    async getBlock({ blockNumber }) {
      const result = blocks.get(blockNumber);
      assert.ok(result, `missing mocked block ${blockNumber}`);
      return result;
    },
  };
}

test("takes the fast path when the tracked head remains canonical", async () => {
  const recoveryCalls = [];
  const canonicalStore = {
    async readCanonicalHistoryState() {
      return { count: 3, firstBlock: 9n, lastBlock: 11n };
    },
    async readCanonicalBlock(_scope, number) {
      assert.equal(number, 11n);
      return block(11n, 12n, 11n);
    },
    async recoverCanonicalReorg(...args) {
      recoveryCalls.push(args);
    },
  };
  const result = await createCanonicalReconciler({
    config: CONFIG,
    pool: undefined,
    publicClient: publicClientFor(new Map([[11n, block(11n, 12n, 11n)]])),
    canonicalStore,
    cursorStore: { async loadOrInitializeCursor() { return 12n; } },
    logger: { log() {}, error() {} },
  }).reconcile({ headBlock: 20n });

  assert.equal(result.detected, false);
  assert.equal(result.oldIndexedHead, 11n);
  assert.deepEqual(recoveryCalls, []);
});

test("finds a common ancestor and delegates one atomic recovery", async () => {
  const recoveryCalls = [];
  const stored = [
    block(12n, 113n, 112n),
    block(11n, 112n, 10n),
    block(10n, 10n, 9n),
    block(9n, 9n, 8n),
  ];
  const current = new Map([
    [12n, block(12n, 213n, 212n)],
    [11n, block(11n, 212n, 10n)],
    [10n, block(10n, 10n, 9n)],
  ]);
  const canonicalStore = {
    async readCanonicalHistoryState() {
      return { count: 4, firstBlock: 9n, lastBlock: 12n };
    },
    async readCanonicalBlock() {
      return stored[0];
    },
    async readCanonicalBlocksDescending() {
      return stored;
    },
    async recoverCanonicalReorg(scope, recovery) {
      recoveryCalls.push({ scope, recovery });
      return {
        reorgedMessages: 2,
        deletedCanonicalBlocks: 2,
        rewoundNextBlock: 11n,
      };
    },
  };
  const result = await createCanonicalReconciler({
    config: CONFIG,
    pool: undefined,
    publicClient: publicClientFor(current),
    canonicalStore,
    cursorStore: { async loadOrInitializeCursor() { return 13n; } },
    logger: { log() {}, error() {} },
  }).reconcile({ headBlock: 12n });

  assert.equal(result.detected, true);
  assert.equal(result.commonAncestor, 10n);
  assert.equal(result.forkBlock, 11n);
  assert.equal(result.reorgedMessages, 2);
  assert.equal(recoveryCalls.length, 1);
  assert.equal(recoveryCalls[0].recovery.commonAncestor.number, 10n);
  assert.equal(recoveryCalls[0].recovery.forkBlock, 11n);
});

test("treats current head regression as divergence even when the probe matches", async () => {
  const canonicalStore = {
    async readCanonicalHistoryState() {
      return { count: 4, firstBlock: 9n, lastBlock: 12n };
    },
    async readCanonicalBlock() {
      return block(10n, 10n, 9n);
    },
    async readCanonicalBlocksDescending() {
      return [block(10n, 10n, 9n), block(9n, 9n, 8n)];
    },
    async recoverCanonicalReorg(_scope, recovery) {
      assert.equal(recovery.forkBlock, 11n);
      return {
        reorgedMessages: 1,
        deletedCanonicalBlocks: 2,
        rewoundNextBlock: 11n,
      };
    },
  };
  const result = await createCanonicalReconciler({
    config: CONFIG,
    pool: undefined,
    publicClient: publicClientFor(new Map([[10n, block(10n, 10n, 9n)]])),
    canonicalStore,
    cursorStore: { async loadOrInitializeCursor() { return 13n; } },
    logger: { log() {}, error() {} },
  }).reconcile({ headBlock: 10n });

  assert.equal(result.detected, true);
  assert.equal(result.commonAncestor, 10n);
});

test("fails closed when persisted history contains no common ancestor", async () => {
  const canonicalStore = {
    async readCanonicalHistoryState() {
      return { count: 2, firstBlock: 10n, lastBlock: 11n };
    },
    async readCanonicalBlock() {
      return block(11n, 111n, 110n);
    },
    async readCanonicalBlocksDescending() {
      return [block(11n, 111n, 110n), block(10n, 110n, 109n)];
    },
  };
  const current = new Map([
    [11n, block(11n, 211n, 210n)],
    [10n, block(10n, 210n, 209n)],
  ]);

  await assert.rejects(
    createCanonicalReconciler({
      config: CONFIG,
      pool: undefined,
      publicClient: publicClientFor(current),
      canonicalStore,
      cursorStore: { async loadOrInitializeCursor() { return 12n; } },
      logger: { log() {}, error() {} },
    }).reconcile({ headBlock: 11n }),
    NoCommonAncestorError,
  );
});
