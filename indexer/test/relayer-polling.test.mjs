import assert from "node:assert/strict";
import { test } from "node:test";
import { createRelayerCheckpoint, isRelayerPolling, relayerPollingPasses } from "./helpers/relayer-polling.mjs";

test("existing RPC-outage polling pauses once at the committed broadcast marker", () => {
  const gate = createRelayerCheckpoint({ mode: "rpc-outage-poll" });
  for (const name of ["lease-acquired", "signed-commit", "signed-persisted"]) assert.equal(gate(name), false);
  assert.equal(gate("broadcast-start"), true);
  assert.equal(gate("broadcast-start"), false);
  assert.equal(gate("endpoint-result"), false);
});

test("leased polling reaches the signed takeover boundary once and later passes cannot pause recovery", () => {
  const gate = createRelayerCheckpoint({ mode: "leased-recovery-poll", checkpoint: "signed-persisted" });
  assert.equal(gate("lease-acquired"), false);
  assert.equal(gate("signed-commit"), false);
  assert.equal(gate("signed-persisted"), true);
  for (const name of ["signed-persisted", "broadcast-start", "endpoint-result", "receipt-observed", "signed-persisted"]) {
    assert.equal(gate(name), false);
  }
});

test("ordinary one-shot crash and database barriers retain their existing repeated-match semantics", () => {
  for (const mode of ["job", "database-restart", "transaction"]) {
    const gate = createRelayerCheckpoint({ mode, checkpoint: "endpoint-result" });
    assert.equal(gate("signed-persisted"), false);
    assert.equal(gate("endpoint-result"), true);
    assert.equal(gate("endpoint-result"), true);
    assert.equal(isRelayerPolling(mode), false);
  }
});

test("composed polling invokes the leased worker and receipt observer without standalone transport recovery", async () => {
  const calls = [];
  const passes = relayerPollingPasses("leased-recovery-poll", { async runOnce() { calls.push("leased delivery"); } }, {
    processTransactionRetriesOnce() { assert.fail("composed transport must retain the worker's fence"); },
    recoverTransactionsOnce() { assert.fail("composed transport must retain the worker's fence"); },
    async checkReceiptsOnce() { calls.push("receipts"); },
  });
  assert.deepEqual(passes.map(([name]) => name), ["delivery", "receipts"]);
  for (const [, run] of passes) await run();
  assert.deepEqual(calls, ["leased delivery", "receipts"]);
});

test("existing RPC-outage polling preserves all four production operations and their order", async () => {
  const calls = [];
  const passes = relayerPollingPasses("rpc-outage-poll", { async runOnce() { calls.push("delivery"); } }, {
    async processTransactionRetriesOnce() { calls.push("retries"); },
    async recoverTransactionsOnce() { calls.push("recovery"); },
    async checkReceiptsOnce() { calls.push("receipts"); },
  });
  for (const [, run] of passes) await run();
  assert.deepEqual(calls, ["delivery", "retries", "recovery", "receipts"]);
});
