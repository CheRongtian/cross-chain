import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { createDatabasePool } from "../../src/db.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { createRelayerWorker } from "../../src/relayer/service.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { loadTransactionConfig } from "../../src/transaction-manager/config.mjs";
import { safeRelayerMessage } from "../../src/relayer/config.mjs";
import { deliveryJson } from "../../src/delivery/package.mjs";
import { createTransactionRpc } from "../../src/transaction-manager/rpc.mjs";
import { formatRelayerSummary } from "../../src/relayer/summary.mjs";
import { createRelayerCheckpoint, isRelayerPolling, relayerPollingPasses } from "./relayer-polling.mjs";
import { prepareDuplicateTransport } from "../../scripts/lib/duplicate-transport.mjs";

// IPC barriers exist only in this integration helper. Production has no pause,
// force-expiry, stale-fence or test-mode environment switches.
let config; let pool; let request; const messages = []; const waiters = [];
let pollingStopped = false; let shouldPause;
process.on("message",message => {
  if (isRelayerPolling(request?.mode) && message.type === "stop-polling") { pollingStopped = true; return; }
  const waiter = waiters.shift(); if (waiter) waiter(message); else messages.push(message);
});
const receive = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve));
const notify = value => new Promise((resolve,reject) => process.send(value,error => error ? reject(error) : resolve()));
async function checkpoint(name,payload) {
  if (!shouldPause?.(name)) return;
  await notify({ type: "checkpoint",name,pid: process.pid,workerId: config.workerId,...JSON.parse(deliveryJson(payload)) });
  if ((await receive()).type !== "continue") throw new Error("invalid crash checkpoint command");
}
try {
  config = loadTransactionConfig(); pool = createDatabasePool(config);
  pool.on("error", error => {
    if (request?.mode !== "database-restart") throw error;
    // Keep the verification IPC barrier alive while the real server is down.
    // Production operations still fail; no connection/state recovery is done here.
    console.log(`EXPECTED FAILURE: idle database connection lost (${error.code ?? "CONNECTION_LOST"})`);
  });
  const queue = createDeliveryRepository({ config,pool });
  const liveRpc = createTransactionRpc(config);
  const persistedJobs = new Set();
  let preparation;
  function recordPreparationRpc(field,id = preparation?.deliveryJobId) {
    if (!isRelayerPolling(request?.mode) && request?.mode !== "database-restart") return;
    assert.ok(preparation && preparation.deliveryJobId === id,
      `${field} must belong to the active initial preparation; retry/recovery must reuse persisted transaction fields`);
    assert.ok(!persistedJobs.has(id),`job ${id}: ${field} attempted after the signed transaction was persisted`);
    preparation[field]++;
  }
  const rpc = { ...liveRpc,
    estimateGas(intent) { recordPreparationRpc("estimates",intent.deliveryJobId); return liveRpc.estimateGas(intent); },
    fees() { recordPreparationRpc("feeQuotes"); return liveRpc.fees(); },
  };
  const manager = createTransactionManager({ config,pool,queue,rpc,clock: { now: () => request?.now ?? Date.now() },
    async beforeSignedCommit({ intent }) {
      recordPreparationRpc("signatures",intent.deliveryJobId);
      await checkpoint("signed-commit",{ id: intent.deliveryJobId });
    },
    hooks: {
      afterIntentInsert: ({ intent }) => checkpoint("intent-insert",{ id: intent.deliveryJobId }),
      afterBroadcastStart: value => checkpoint("broadcast-start",value),
      afterEndpointResult: value => checkpoint("endpoint-result",value),
      beforeBroadcastResult: value => checkpoint("broadcast-result",value),
      afterReceiptObserved: ({ stored,winner,head }) => checkpoint("receipt-observed",{ id: stored.intent.deliveryJobId,winner,head }),
      beforeOutcomeCommit: ({ id,observation }) => checkpoint("outcome-commit",{ id,observation }),
      afterOutcomeCommit: value => checkpoint("outcome-return",value),
    } });
  await notify({ type: "ready",pid: process.pid,workerId: config.workerId });
  request = await receive();
  shouldPause = createRelayerCheckpoint(request);
  if (request.mode === "race") {
    await notify({ type: "claim-ready",pid: process.pid,workerId: config.workerId });
    if ((await receive()).type !== "continue") throw new Error("invalid claim barrier command");
  }
  if (request.mode === "stale") {
    try {
      if (request.operation === "recover") await manager.recoverTransactionsOnce({ deliveryJobId: request.id,fence: request.fence });
      else await manager.prepareDeliveryTransaction(request.id,{ fence: request.fence });
      throw new Error("stale fenced transaction orchestration unexpectedly succeeded");
    } catch (error) {
      if (error.code !== "STALE_FENCE") throw error;
      console.log(request.operation === "recover" ? "EXPECTED FAILURE: stale replacement recovery fence rejected before any protected send" :
        "EXPECTED FAILURE: restarted worker's stale fence rejected before intent mutation");
      await notify({ type: "result",action: "STALE_FENCE",pid: process.pid,workerId: config.workerId });
    }
  } else if (request.mode === "duplicate-transport") {
    // Intentional duplicate network delivery is isolated to this test entry.
    // Strict reads/encoding and signing reuse production primitives, but this
    // contender never claims a lease or writes a canonical intent/account.
    const rpc = createTransactionRpc(config);
    const duplicate = await prepareDuplicateTransport({ config,queue,manager,rpc,id: request.id });
    const { attempt } = duplicate;
    const evidence = JSON.parse(deliveryJson(duplicate));
    await notify({ type: "transport-ready",pid: process.pid,workerId: config.workerId,...evidence });
    if ((await receive()).type !== "continue") throw new Error("invalid duplicate pre-send barrier command");
    const hash = await rpc.broadcast(attempt.rawSignedTransaction,attempt.transactionHash);
    assert.equal(hash,attempt.transactionHash);
    await notify({ type: "transport-broadcast",pid: process.pid,workerId: config.workerId,transactionHash: hash });
    // Stay alive until the parent has observed BOTH accepted external sends.
    if ((await receive()).type !== "continue") throw new Error("invalid duplicate post-send barrier command");
    await notify({ type: "result",pid: process.pid,workerId: config.workerId,transactionHash: hash });
  } else if (request.mode === "transaction") {
    let result;
    if (request.operation === "prepare") result = await manager.prepareDeliveryTransaction(request.id);
    else if (request.operation === "broadcast") result = await manager.broadcastPreparedTransaction(request.id);
    else if (request.operation === "replace") {
      result = await manager.prepareReplacement(request.id);
      await checkpoint("replacement-persisted",{ id: request.id,stored: result });
    } else if (request.operation === "recover") result = await manager.recoverTransactionsOnce({ deliveryJobId: request.id });
    else throw new Error("invalid transaction crash harness operation");
    await notify({ type: "result",result,pid: process.pid,workerId: config.workerId });
  } else {
    // Observe the production preparation call without changing its job
    // selection, RPC results, nonce ordering, persistence or error handling.
    const transactionManager = (isRelayerPolling(request.mode) || request.mode === "database-restart") ? { ...manager,
      async prepareDeliveryTransaction(id,options) {
        assert.equal(preparation,undefined,"scheduled preparation calls must remain sequential");
        const activity = { deliveryJobId: id,estimates: 0,feeQuotes: 0,signatures: 0,outcome: "FAILED" };
        preparation = activity;
        try {
          const stored = await manager.prepareDeliveryTransaction(id,options);
          activity.outcome = stored.historicalSubmission ? "HISTORICAL" : stored.created ? "SIGNED" : "REUSED";
          if (!stored.historicalSubmission) persistedJobs.add(id);
          return stored;
        } catch (error) {
          if (error.code === "SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST") {
            activity.outcome = "BLOCKED_BY_EARLIER_NONCE";
            assert.equal(activity.signatures,0,`job ${id}: nonce-blocked preparation must not sign`);
            assert.equal(await manager.repository.getTransaction(id),null,
              `job ${id}: nonce-blocked initial preparation must not create an intent`);
          }
          throw error;
        } finally {
          preparation = undefined;
          // Counts and outcome only: no keys, provider URLs or signed bytes.
          await notify({ type: "preparation",...activity,pid: process.pid,workerId: config.workerId });
        }
      },
    } : manager;
    const worker = createRelayerWorker({ config,pool,queue,transactionManager,
      async afterLeaseAcquired(fence) {
        await checkpoint("lease-acquired",{ id: fence.deliveryJobId,fence });
        await notify({ type: "lease",fence,pid: process.pid,workerId: config.workerId });
        if (request.mode === "race") await notify({ type: "ownership",fence,pid: process.pid,workerId: config.workerId });
        if (request.pause === "lease") {
          if ((await receive()).type !== "continue") throw new Error("invalid integration barrier command");
        }
        if (["lease-only","race"].includes(request.mode)) throw Object.assign(new Error("verification lease-only boundary"),{ code: "VERIFICATION_LEASE_ONLY" });
      },
      async afterPrepared({ fence,stored }) {
        await checkpoint("signed-persisted",{ id: fence.deliveryJobId,fence,stored });
        await notify({ type: "signed",fence,stored,pid: process.pid,workerId: config.workerId });
        if (request.pause === "signed") {
          if ((await receive()).type !== "continue") throw new Error("invalid integration barrier command");
        }
      } });
    if (isRelayerPolling(request.mode)) {
      // Production exposes bounded one-shot operations. This test scheduler
      // repeatedly invokes those SAME operations, never a job-ID operation.
      assert.equal(request.id,undefined);
      const passes = relayerPollingPasses(request.mode,worker,manager);
      let iteration = 0;
      while (!pollingStopped) {
        iteration++;
        for (const [operation,run] of passes) {
          if (pollingStopped) break;
          try {
            const result = await run();
            for (const value of result.results ?? []) {
              const unexpected = value.errorCode && value.errorCode !== "RPC_UNAVAILABLE" ? value.errorCode :
                ["MANUAL_ACTION_REQUIRED","MAX_ATTEMPTS_REACHED","FEE_CAP_EXCEEDED","REPLACEMENT_FEE_OVERFLOW"].includes(value.action) ? value.reason ?? value.action : null;
              if (unexpected) throw Object.assign(new Error(`unexpected ${operation} outcome: ${unexpected}`),{ code: unexpected });
            }
            const summary = { selected: result.selected,processed: result.processed,checked: result.checked,
              scanned: result.scanned,broadcasts: result.broadcasts,replacements: result.replacements,
              finalized: result.finalized,results: (result.results ?? []).map(value => ({ ...formatRelayerSummary(value),
                action: value.action,errorClass: value.errorClass,errorCode: value.errorCode })) };
            await notify({ type: "poll-pass",pid: process.pid,workerId: config.workerId,iteration,operation,summary });
          } catch (error) {
            // An earlier SIGNED nonce can temporarily block the following job.
            // Unexpected protocol, identity, storage and fencing errors fail.
            if (!["RPC_UNAVAILABLE","EARLIER_SIGNED_TRANSACTION_BLOCKS_BROADCAST"].includes(error.code)) throw error;
            await notify({ type: "poll-error",pid: process.pid,workerId: config.workerId,iteration,operation,
              errorCode: error.code,observations: error.observations ?? [] });
          }
        }
        if (!pollingStopped) await pause(100);
      }
      await notify({ type: "result",pid: process.pid,workerId: config.workerId,iterations: iteration });
    } else {
      try {
        let result = request.mode === "database-restart" ? await worker.runOnce() : await worker.submitJob(request.id);
        // Keep the same B process alive across the crash and database-time
        // expiry. Each retry is an explicit parent IPC command, never a timer.
        if (request.mode === "takeover") {
          let attempt = 0;
          while (result.action === "BUSY") {
            await notify({ type: "busy",attempt: ++attempt,result,pid: process.pid,workerId: config.workerId });
            if ((await receive()).type !== "continue") throw new Error("invalid takeover retry command");
            result = await worker.submitJob(request.id);
          }
        }
        if (request.mode === "duplicate-canonical") {
          assert.ok(result.submitted && result.attempt?.transactionHash,
            "canonical duplicate contender must complete its actual broadcast before the post-send barrier");
          await notify({ type: "transport-broadcast",pid: process.pid,workerId: config.workerId,
            transactionHash: result.attempt.transactionHash,result: JSON.parse(deliveryJson(result)) });
          if ((await receive()).type !== "continue") throw new Error("invalid canonical post-send barrier command");
        }
        if (request.mode === "race") await notify({ type: "ownership",fence: null,pid: process.pid,workerId: config.workerId });
        await notify({ type: "result",result,pid: process.pid,workerId: config.workerId });
      } catch (error) {
        if (!["lease-only","race"].includes(request.mode) || error.code !== "VERIFICATION_LEASE_ONLY") throw error;
        await notify({ type: "result",action: "LEASE_ONLY",pid: process.pid,workerId: config.workerId });
      }
    }
  }
} catch (error) {
  console.error(`Relayer integration worker failed: ${safeRelayerMessage(error,config)}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
  if (process.connected) process.disconnect();
}
