import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { createDatabasePool } from "../../src/db.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { createRelayerWorker } from "../../src/relayer/service.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { loadTransactionConfig } from "../../src/transaction-manager/config.mjs";
import { safeRelayerMessage } from "../../src/relayer/config.mjs";
import { deliveryJson } from "../../src/delivery/package.mjs";
import { encodeGatewaySubmission } from "../../src/relayer/encoding.mjs";
import { createTransactionRpc } from "../../src/transaction-manager/rpc.mjs";
import { signDeliveryTransaction } from "../../src/transaction-manager/transaction.mjs";

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
    const pack = await queue.getDeliveryPackage(request.id);
    const encoded = await encodeGatewaySubmission(pack,{ validatorSets: config.validatorSets,
      sourceDomain: config.chainDomain,sourceGateway: config.sourceGateway });
    const canonical = await manager.resolveIntent(request.id);
    assert.equal(canonical.calldata,encoded.calldata); assert.equal(canonical.packageDigest,encoded.packageDigest);
    const rpc = createTransactionRpc(config);
    assert.equal(await rpc.verifyChain(),config.destinationDomain);
    const gasLimit = await rpc.estimateGas(canonical);
    const fees = await rpc.fees();
    assert.ok(fees.maxFeePerGas <= config.maxFeePerGasCap && fees.maxPriorityFeePerGas <= config.maxPriorityFeePerGasCap);
    const nonce = await rpc.pendingNonce();
    const intent = { ...canonical,nonce: nonce.toString() };
    const attempt = await signDeliveryTransaction(intent,{ nonce,gasLimit,...fees },privateKeyToAccount(config.privateKey));
    const evidence = JSON.parse(deliveryJson({ intent,attempt,package: encoded.package }));
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
      let result = await worker.submitJob(request.id);
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
} catch (error) {
  console.error(`Relayer integration worker failed: ${safeRelayerMessage(error,config)}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
  if (process.connected) process.disconnect();
}
