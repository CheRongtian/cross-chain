import { createDatabasePool } from "../../src/db.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { createRelayerWorker } from "../../src/relayer/service.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { loadTransactionConfig } from "../../src/transaction-manager/config.mjs";
import { safeRelayerMessage } from "../../src/relayer/config.mjs";
import { deliveryJson } from "../../src/delivery/package.mjs";

// IPC barriers exist only in this integration helper. Production has no pause,
// force-expiry, stale-fence or test-mode environment switches.
let config; let pool; let request; const messages = []; const waiters = [];
process.on("message",message => {
  const waiter = waiters.shift(); if (waiter) waiter(message); else messages.push(message);
});
const receive = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve));
const notify = value => new Promise((resolve,reject) => process.send(value,error => error ? reject(error) : resolve()));
async function checkpoint(name,payload) {
  if (request?.checkpoint !== name) return;
  await notify({ type: "checkpoint",name,pid: process.pid,workerId: config.workerId,...JSON.parse(deliveryJson(payload)) });
  if ((await receive()).type !== "continue") throw new Error("invalid crash checkpoint command");
}
try {
  config = loadTransactionConfig(); pool = createDatabasePool(config);
  const queue = createDeliveryRepository({ config,pool });
  const manager = createTransactionManager({ config,pool,queue,clock: { now: () => request?.now ?? Date.now() },
    beforeSignedCommit: ({ intent }) => checkpoint("signed-commit",{ id: intent.deliveryJobId }),
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
  if (request.mode === "race") {
    await notify({ type: "claim-ready",pid: process.pid,workerId: config.workerId });
    if ((await receive()).type !== "continue") throw new Error("invalid claim barrier command");
  }
  if (request.mode === "stale") {
    try {
      await manager.prepareDeliveryTransaction(request.id,{ fence: request.fence });
      throw new Error("stale intent preparation unexpectedly succeeded");
    } catch (error) {
      if (error.code !== "STALE_FENCE") throw error;
      console.log("EXPECTED FAILURE: restarted worker's stale fence rejected before intent mutation");
      await notify({ type: "result",action: "STALE_FENCE",pid: process.pid,workerId: config.workerId });
    }
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
    const worker = createRelayerWorker({ config,pool,queue,transactionManager: manager,
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
    try {
      const result = await worker.submitJob(request.id);
      if (request.mode === "race") await notify({ type: "ownership",fence: null,pid: process.pid,workerId: config.workerId });
      await notify({ type: "result",result,pid: process.pid,workerId: config.workerId });
    } catch (error) {
      if (!["lease-only","race"].includes(request.mode) || error.code !== "VERIFICATION_LEASE_ONLY") throw error;
      await notify({ type: "result",action: "LEASE_ONLY",pid: process.pid,workerId: config.workerId });
    }
  }
} catch (error) {
  console.error(`Relayer integration worker failed: ${safeRelayerMessage(error,config)}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
  if (process.connected) process.disconnect();
}
