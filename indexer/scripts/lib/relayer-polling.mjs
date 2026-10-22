import assert from "node:assert/strict";

// Shared verification scheduling; production owns every selection, lease,
// preparation, recovery and send performed by these bounded operations.
export const isRelayerPolling = mode => ["rpc-outage-poll", "leased-recovery-poll"].includes(mode);

export function createRelayerCheckpoint(request) {
  const polling = isRelayerPolling(request.mode);
  const expected = request.mode === "rpc-outage-poll" ? "broadcast-start" : request.checkpoint;
  let used = false;
  return name => {
    if (name !== expected || (polling && used)) return false;
    used = true;
    return true;
  };
}

export function relayerPollingPasses(mode, worker, manager) {
  assert.ok(isRelayerPolling(mode), "a supported verification polling mode is required");
  const passes = [["delivery", () => worker.runOnce()]];
  if (mode === "rpc-outage-poll") {
    passes.push(["retries", () => manager.processTransactionRetriesOnce()], ["recovery", () => manager.recoverTransactionsOnce()]);
  }
  // The composed ownership scenario sends only inside the leased production
  // worker. Receipt observation cannot introduce an unfenced transport send.
  passes.push(["receipts", () => manager.checkReceiptsOnce()]);
  return passes;
}
