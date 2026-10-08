import assert from "node:assert/strict";
import test from "node:test";

import { createFinalityWatcher } from "../src/finality-watcher.mjs";

const CONFIG = {
  chainDomain: 10_011n,
  sourceGateway: "0x0000000000000000000000000000000000001001",
  finalityBlockDepth: 2n,
  finalityPollIntervalMs: 10,
  databaseSchema: "unused_in_unit_test",
};

test("uses one fixed head snapshot for a finality pass", async () => {
  let headReads = 0;
  const calls = [];
  const reconciliationCalls = [];
  const logs = [];
  const publicClient = {
    async request({ method }) {
      assert.equal(method, "eth_blockNumber");
      headReads += 1;
      return headReads === 1 ? "0x7b" : "0x3e7";
    },
  };
  const expected = {
    headBlock: 123n,
    candidatesChecked: 3,
    observedToFinalizing: 1,
    observedToFinalized: 0,
    finalizingToFinalized: 1,
    unchangedFinalizing: 1,
  };
  const store = {
    async advanceFinality(scope, policy) {
      calls.push({ scope, policy });
      return expected;
    },
  };

  const result = await createFinalityWatcher({
    config: CONFIG,
    pool: undefined,
    publicClient,
    store,
    reconciler: {
      async reconcile(input) {
        reconciliationCalls.push(input);
        return { detected: false, headBlock: input.headBlock };
      },
    },
    logger: { log(message) { logs.push(message); } },
  }).runFinalityPass();

  assert.equal(headReads, 1);
  assert.deepEqual(reconciliationCalls, [{ headBlock: 123n }]);
  assert.deepEqual(calls, [
    {
      scope: { chainDomain: CONFIG.chainDomain, sourceGateway: CONFIG.sourceGateway },
      policy: { headBlock: 123n, finalityBlockDepth: 2n },
    },
  ]);
  assert.deepEqual(result, expected);
  assert.ok(logs.includes("Finality head: 123"));
  assert.ok(logs.includes("Configured block depth: 2"));
});

test("continuous mode stops cleanly after an aborted pass", async () => {
  const controller = new AbortController();
  let passes = 0;
  const watcher = createFinalityWatcher({
    config: CONFIG,
    pool: undefined,
    publicClient: {
      async request() {
        return "0x7b";
      },
    },
    reconciler: {
      async reconcile() {
        return { detected: false, headBlock: 123n };
      },
    },
    store: {
      async advanceFinality() {
        passes += 1;
        controller.abort();
        return {
          headBlock: 123n,
          candidatesChecked: 0,
          observedToFinalizing: 0,
          observedToFinalized: 0,
          finalizingToFinalized: 0,
          unchangedFinalizing: 0,
        };
      },
    },
    logger: { log() {} },
  });

  await watcher.runContinuous({ signal: controller.signal });
  assert.equal(passes, 1);
});

test("does not evaluate stale finality candidates when reconciliation fails", async () => {
  let finalityCalls = 0;
  const watcher = createFinalityWatcher({
    config: CONFIG,
    pool: undefined,
    publicClient: {
      async request() {
        return "0x7b";
      },
    },
    reconciler: {
      async reconcile() {
        throw new Error("canonical reconciliation failed");
      },
    },
    store: {
      async advanceFinality() {
        finalityCalls += 1;
      },
    },
    logger: { log() {} },
  });

  await assert.rejects(watcher.runFinalityPass(), /canonical reconciliation failed/);
  assert.equal(finalityCalls, 0);
});
