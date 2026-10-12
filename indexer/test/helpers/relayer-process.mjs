import { createDatabasePool } from "../../src/db.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { createRelayerWorker } from "../../src/relayer/service.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { loadTransactionConfig } from "../../src/transaction-manager/config.mjs";
import { safeRelayerMessage } from "../../src/relayer/config.mjs";

// IPC barriers exist only in this integration helper. Production has no pause,
// force-expiry, stale-fence or test-mode environment switches.
let config; let pool; const messages = []; const waiters = [];
process.on("message",message => {
  const waiter = waiters.shift(); if (waiter) waiter(message); else messages.push(message);
});
const receive = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve));
const notify = value => new Promise((resolve,reject) => process.send(value,error => error ? reject(error) : resolve()));
try {
  config = loadTransactionConfig(); pool = createDatabasePool(config);
  const queue = createDeliveryRepository({ config,pool });
  const manager = createTransactionManager({ config,pool,queue });
  await notify({ type: "ready",pid: process.pid,workerId: config.workerId });
  const request = await receive();
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
  } else {
    const worker = createRelayerWorker({ config,pool,queue,transactionManager: manager,
      async afterLeaseAcquired(fence) {
        await notify({ type: "lease",fence,pid: process.pid,workerId: config.workerId });
        if (request.mode === "race") await notify({ type: "ownership",fence,pid: process.pid,workerId: config.workerId });
        if (request.pause === "lease") {
          if ((await receive()).type !== "continue") throw new Error("invalid integration barrier command");
        }
        if (["lease-only","race"].includes(request.mode)) throw Object.assign(new Error("verification lease-only boundary"),{ code: "VERIFICATION_LEASE_ONLY" });
      },
      async afterPrepared({ fence,stored }) {
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
