import assert from "node:assert/strict";
import test from "node:test";

import { CanonicalHistoryBootstrapError, CanonicalHistoryChangedError, NoCommonAncestorError } from "../src/canonical-block.mjs";
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

function publicClientFor(blocks, head = [...blocks.keys()].reduce((highest, number) => number > highest ? number : highest, 0n)) {
  return {
    async request({ method }) {
      assert.equal(method, "eth_blockNumber");
      return `0x${head.toString(16)}`;
    },
    async getBlock({ blockNumber }) {
      const result = blocks.get(blockNumber);
      assert.ok(result, `missing mocked block ${blockNumber}`);
      return result;
    },
  };
}

for (const advanced of [false, true]) {
  test(`reconciles a concurrent bootstrap${advanced ? " and cursor advance" : ""} without moving its snapshot`, async () => {
    let initializedElsewhere = false;
    let bootstrapCalls = 0;
    let retries = 0;
    const reads = [];
    const firstCursor = 10n;
    const currentCursor = advanced ? 14n : firstCursor;
    const currentHead = advanced ? 13n : 9n;
    const result = await createCanonicalReconciler({
      config: CONFIG,
      publicClient: {
        async request({ method }) { assert.equal(method, "eth_blockNumber"); return "0xd"; },
        async getBlock({ blockNumber }) { reads.push(blockNumber); assert.ok(blockNumber <= 10n); return block(blockNumber); },
      },
      canonicalStore: {
        async readCanonicalHistoryState() {
          return initializedElsewhere ? { count: advanced ? 5 : 1, firstBlock: 9n, lastBlock: currentHead } : { count: 0 };
        },
        async bootstrapCanonicalHistory(_scope, input) {
          bootstrapCalls++;
          assert.equal(input.expectedNextBlock, firstCursor);
          assert.deepEqual(input.blocks, [block(9n)]);
          initializedElsewhere = true;
          throw new CanonicalHistoryChangedError(advanced ? "cursor advanced" : "history initialized");
        },
        async readCanonicalBlock(_scope, number) { return block(number); },
        async recoverCanonicalReorg() { assert.fail("concurrent canonical startup must not rewind history"); },
      },
      cursorStore: { async loadOrInitializeCursor() { return initializedElsewhere ? currentCursor : firstCursor; } },
      logger: { log(message) { if (message.includes("same fixed snapshot again")) retries++; }, error() {} },
    }).reconcile({ headBlock: 10n });
    assert.equal(result.detected, false); assert.equal(result.bootstrapped, false);
    assert.equal(result.headBlock, 10n); assert.equal(result.oldIndexedHead, currentHead);
    assert.equal(result.rewoundNextBlock, currentCursor);
    assert.equal(bootstrapCalls, 1); assert.equal(retries, 1);
    assert.deepEqual(reads, [9n, advanced ? 10n : 9n]);
  });
}

test("a concurrent bootstrap still checks the committed branch and fails without a common ancestor", async () => {
  let initializedElsewhere = false;
  let retries = 0;
  await assert.rejects(createCanonicalReconciler({
    config: CONFIG,
    publicClient: publicClientFor(new Map([[9n, block(9n)], [10n, block(10n)]])),
    canonicalStore: {
      async readCanonicalHistoryState() { return initializedElsewhere ? { count: 2, firstBlock: 9n, lastBlock: 10n } : { count: 0 }; },
      async bootstrapCanonicalHistory() { initializedElsewhere = true; throw new CanonicalHistoryChangedError(); },
      async readCanonicalBlock(_scope, number) { return block(number, number + 101n, number + 100n); },
      async readCanonicalBlocksDescending() { return [block(10n, 111n, 110n), block(9n, 110n, 109n)]; },
      async recoverCanonicalReorg() { assert.fail("a missing common ancestor must remain fail-closed"); },
    },
    cursorStore: { async loadOrInitializeCursor() { return initializedElsewhere ? 11n : 10n; } },
    logger: { log() { retries++; }, error() {} },
  }).reconcile({ headBlock: 10n }), NoCommonAncestorError);
  assert.equal(retries, 1);
});

test("unsafe legacy bootstrap remains fatal and is never retried as concurrent progress", async () => {
  const failure = new CanonicalHistoryBootstrapError("pre-existing message block hash disagrees");
  let bootstrapCalls = 0;
  await assert.rejects(createCanonicalReconciler({
    config: CONFIG,
    publicClient: publicClientFor(new Map([[9n, block(9n)]])),
    canonicalStore: {
      async readCanonicalHistoryState() { return { count: 0 }; },
      async bootstrapCanonicalHistory() { bootstrapCalls++; throw failure; },
    },
    cursorStore: { async loadOrInitializeCursor() { return 10n; } },
    logger: { log() { assert.fail("unsafe bootstrap must not be retried"); }, error() {} },
  }).reconcile({ headBlock: 10n }), error => error === failure);
  assert.equal(bootstrapCalls, 1);
});

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

test("confirms actual head regression even when the snapshot prefix matches", async () => {
  const canonicalStore = {
    async readCanonicalHistoryState() {
      return { count: 4, firstBlock: 9n, lastBlock: 12n };
    },
    async readCanonicalBlock(_scope, number) {
      return block(number, number, number - 1n);
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

for (const advancement of [1n, 4n]) {
  test(`preserves canonical history ${advancement} block(s) beyond a fixed snapshot`, async () => {
    const head = 10n + advancement;
    const recoveryCalls = [];
    const reads = [];
    const result = await createCanonicalReconciler({
      config: CONFIG,
      publicClient: publicClientFor(new Map([[10n, block(10n)]]), head),
      canonicalStore: {
        async readCanonicalHistoryState() { return { count: advancement === 1n ? 3 : 6, firstBlock: 9n, lastBlock: head }; },
        async readCanonicalBlock(_scope, number) { reads.push(number); return block(number); },
        async recoverCanonicalReorg(...args) { recoveryCalls.push(args); },
      },
      cursorStore: { async loadOrInitializeCursor() { return head + 1n; } },
      logger: { log() {}, error() {} },
    }).reconcile({ headBlock: 10n });
    assert.equal(result.detected, false);
    assert.equal(result.headBlock, 10n);
    assert.equal(result.commonAncestor, 10n);
    assert.equal(result.rewoundNextBlock, head + 1n);
    assert.deepEqual(reads, [10n]);
    assert.deepEqual(recoveryCalls, []);
  });
}

test("detects snapshot-prefix divergence even when durable history is ahead", async () => {
  const recoveries = [];
  const result = await createCanonicalReconciler({
    config: CONFIG,
    publicClient: publicClientFor(new Map([[10n, block(10n, 211n, 10n)], [9n, block(9n)]]), 12n),
    canonicalStore: {
      async readCanonicalHistoryState() { return { count: 4, firstBlock: 9n, lastBlock: 12n }; },
      async readCanonicalBlock(_scope, number) { return block(number); },
      async readCanonicalBlocksDescending() { return [block(10n), block(9n)]; },
      async recoverCanonicalReorg(_scope, recovery) {
        recoveries.push(recovery);
        return { reorgedMessages: 1, deletedCanonicalBlocks: 3, rewoundNextBlock: 10n };
      },
    },
    cursorStore: { async loadOrInitializeCursor() { return 13n; } },
    logger: { log() {}, error() {} },
  }).reconcile({ headBlock: 10n });
  assert.equal(result.detected, true);
  assert.equal(result.commonAncestor, 9n);
  assert.equal(result.headBlock, 10n);
  assert.equal(recoveries[0].expectedState.nextBlock, 13n);
  assert.equal(recoveries[0].expectedState.head.number, 12n);
  assert.equal(recoveries[0].expectedState.probe.number, 10n);
});

test("confirmed rollback preserves the canonical suffix above the older snapshot", async () => {
  const result = await createCanonicalReconciler({
    config: CONFIG,
    publicClient: publicClientFor(new Map([[10n, block(10n)], [11n, block(11n)]]), 11n),
    canonicalStore: {
      async readCanonicalHistoryState() { return { count: 5, firstBlock: 9n, lastBlock: 13n }; },
      async readCanonicalBlock(_scope, number) { return block(number); },
      async readCanonicalBlocksDescending(_scope, through) {
        assert.equal(through, 11n);
        return [block(11n), block(10n), block(9n)];
      },
      async recoverCanonicalReorg(_scope, recovery) {
        assert.equal(recovery.forkBlock, 12n);
        return { reorgedMessages: 1, deletedCanonicalBlocks: 2, rewoundNextBlock: 12n };
      },
    },
    cursorStore: { async loadOrInitializeCursor() { return 14n; } },
    logger: { log() {}, error() {} },
  }).reconcile({ headBlock: 10n });
  assert.equal(result.detected, true);
  assert.equal(result.headBlock, 10n);
  assert.equal(result.commonAncestor, 11n);
  assert.equal(result.rewoundNextBlock, 12n);
});

test("does not mutate history when rollback evidence disappears before recovery", async () => {
  let headReads = 0;
  const publicClient = publicClientFor(new Map([[10n, block(10n)]]));
  publicClient.request = async ({ method }) => {
    assert.equal(method, "eth_blockNumber");
    headReads += 1;
    return headReads === 1 ? "0xa" : "0xc";
  };
  const result = await createCanonicalReconciler({ config: CONFIG, publicClient,
    canonicalStore: {
      async readCanonicalHistoryState() { return { count: 4, firstBlock: 9n, lastBlock: 12n }; },
      async readCanonicalBlock(_scope, number) { return block(number); },
      async readCanonicalBlocksDescending() { return [block(10n), block(9n)]; },
      async recoverCanonicalReorg() { assert.fail("unconfirmed rollback must not mutate history"); },
    },
    cursorStore: { async loadOrInitializeCursor() { return 13n; } },
    logger: { log() {}, error() {} },
  }).reconcile({ headBlock: 10n });
  assert.equal(result.detected, false);
  assert.equal(result.headBlock, 10n);
  assert.equal(result.rewoundNextBlock, 13n);
  assert.equal(headReads, 3);
});

test("rechecks a changed durable recovery premise without moving the fixed snapshot", async () => {
  let branchChanged = false;
  let recoveries = 0;
  const result = await createCanonicalReconciler({
    config: CONFIG,
    publicClient: publicClientFor(new Map([[10n, block(10n, 211n, 10n)], [9n, block(9n)]])),
    canonicalStore: {
      async readCanonicalHistoryState() { return { count: 2, firstBlock: 9n, lastBlock: 10n }; },
      async readCanonicalBlock(_scope, number) {
        return branchChanged && number === 10n ? block(10n, 211n, 10n) : block(number);
      },
      async readCanonicalBlocksDescending() { return [block(10n), block(9n)]; },
      async recoverCanonicalReorg() {
        recoveries += 1;
        branchChanged = true;
        throw new CanonicalHistoryChangedError();
      },
    },
    cursorStore: { async loadOrInitializeCursor() { return 11n; } },
    logger: { log() {}, error() {} },
  }).reconcile({ headBlock: 10n });
  assert.equal(result.detected, false);
  assert.equal(result.headBlock, 10n);
  assert.equal(recoveries, 1);
});

test("rechecks history another worker recovered during ancestor search", async () => {
  let recoveredElsewhere = false;
  const result = await createCanonicalReconciler({ config: CONFIG,
    publicClient: publicClientFor(new Map([[10n, block(10n, 211n, 10n)], [9n, block(9n)]]), 11n),
    canonicalStore: {
      async readCanonicalHistoryState() {
        return recoveredElsewhere ? { count: 1, firstBlock: 9n, lastBlock: 9n } : { count: 3, firstBlock: 9n, lastBlock: 11n };
      },
      async readCanonicalBlock(_scope, number) { return recoveredElsewhere && number > 9n ? undefined : block(number); },
      async readCanonicalBlocksDescending() { recoveredElsewhere = true; return [block(9n)]; },
      async recoverCanonicalReorg() { assert.fail("the other worker already recovered this branch"); },
    },
    cursorStore: { async loadOrInitializeCursor() { return recoveredElsewhere ? 10n : 12n; } },
    logger: { log() {}, error() {} },
  }).reconcile({ headBlock: 10n });
  assert.equal(result.detected, false);
  assert.equal(result.headBlock, 10n);
  assert.equal(result.rewoundNextBlock, 10n);
});

test("large block heights remain exact when shared history advances", async () => {
  const snapshot = (1n << 80n) + 7n;
  const head = snapshot + 4n;
  const result = await createCanonicalReconciler({
    config: CONFIG,
    publicClient: publicClientFor(new Map([[snapshot, block(snapshot)]]), head),
    canonicalStore: {
      async readCanonicalHistoryState() { return { count: 5, firstBlock: snapshot, lastBlock: head }; },
      async readCanonicalBlock(_scope, number) { assert.equal(number, snapshot); return block(number); },
      async recoverCanonicalReorg() { assert.fail("canonical advancement must not recover a fork"); },
    },
    cursorStore: { async loadOrInitializeCursor() { return head + 1n; } },
    logger: { log() {}, error() {} },
  }).reconcile({ headBlock: snapshot });
  assert.equal(result.headBlock, snapshot);
  assert.equal(result.rewoundNextBlock, head + 1n);
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
