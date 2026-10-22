import { loadConfig } from "../../src/config.mjs";
import { createDatabasePool } from "../../src/db.mjs";
import { loadDeliveryConfig } from "../../src/delivery/config.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { loadTransactionConfig } from "../../src/transaction-manager/config.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { createRelaySubmissionRepository } from "../../src/relayer/repository.mjs";
import { createRelayerWorker } from "../../src/relayer/service.mjs";
import { startWorkerMetrics } from "../../src/metrics/http.mjs";
import { createLocalPipeline,createPipelineDriver } from "./pipeline.mjs";
import { pause,safeError,writeJson } from "./tools.mjs";
import { serveLocalRpc } from "./ipc.mjs";
import { readJson } from "./tools.mjs";
import { createWorkerControl } from "./worker-control.mjs";
import { createTransactionRpc } from "../../src/transaction-manager/rpc.mjs";
import { relayerPollingPasses } from "../lib/relayer-polling.mjs";
import { prepareDuplicateTransport } from "../lib/duplicate-transport.mjs";
import assert from "node:assert/strict";

const role = process.argv[2];
const config = role === "pipeline" ? loadDeliveryConfig() : loadTransactionConfig();
const pool = createDatabasePool(config);
const metrics = await startWorkerMetrics();
let stopping = false;
let control;
const stop = () => { stopping = true; control?.close(); };
process.on("SIGINT",stop); process.on("SIGTERM",stop);
try {
  await pool.query("SELECT 1");
  let pass;
  if (role === "pipeline") {
    const pipeline = createLocalPipeline({ config: { ...loadConfig(),...config },pool,peers: JSON.parse(process.env.VALIDATOR_PEERS) });
    const driver = createPipelineDriver(pipeline);
    serveLocalRpc(driver.handlers);
    pass = () => driver.runOnce();
  } else {
    const runtime = await readJson(process.env.LOCAL_CONFIG_FILE);
    control = createWorkerControl({ isolated: runtime.isolated,identity: { role,workerId: config.workerId,
      address: config.relayerAddress,schema: config.databaseSchema } });
    const queue = createDeliveryRepository({ config,pool });
    const legacy = createRelaySubmissionRepository({ config,pool,queue });
    const liveRpc = createTransactionRpc(config);
    const rpc = { ...liveRpc,
      estimateGas(intent) { control.counts.estimates++; return liveRpc.estimateGas(intent); },
      fees() { control.counts.feeQuotes++; return liveRpc.fees(); },
    };
    const manager = createTransactionManager({ config,pool,queue,legacy,rpc,
      beforeSignedCommit: async () => { control.counts.signatures++; } });
    await manager.verifyChain();
    if (role === "replay") {
      assert.equal(runtime.isolated,true);
      let duplicate;
      serveLocalRpc({ ...control.handlers,
        async prepareReplay({ id }) {
          assert.equal(duplicate,undefined);
          duplicate = await prepareDuplicateTransport({ config,queue,manager,rpc,id });
          return { sender: duplicate.intent.senderAddress,calldata: duplicate.intent.calldata,transactionHash: duplicate.attempt.transactionHash };
        },
        async sendReplay() {
          assert.ok(duplicate);
          const hash = await rpc.broadcast(duplicate.attempt.rawSignedTransaction,duplicate.attempt.transactionHash);
          assert.equal(hash,duplicate.attempt.transactionHash); return { transactionHash: hash };
        },
      });
      pass = async () => {};
    } else {
      const worker = createRelayerWorker({ config,pool,queue,transactionManager: { ...manager,
        prepareDeliveryTransaction(id,options) { control.counts.preparations++; return manager.prepareDeliveryTransaction(id,options); },
      },afterPrepared: ({ fence,stored }) => control.checkpoint("signed-persisted",{
        id: fence.deliveryJobId,fence,created: stored.created,transactionHash: stored.attempt?.transactionHash,
        attemptId: stored.attempt?.attemptId,nonce: stored.intent?.nonce,
      }) });
      serveLocalRpc({ ...control.handlers,
        async assertStale({ id,fence }) {
          assert.equal(runtime.isolated,true); assert.equal(fence.ownerId,config.workerId);
          await assert.rejects(manager.prepareDeliveryTransaction(id,{ fence }),{ code: "STALE_FENCE" });
          await assert.rejects(manager.continueDeliveryTransactionOnce(id,{ fence }),{ code: "STALE_FENCE" });
          return { rejected: "STALE_FENCE",pid: process.pid,workerId: config.workerId };
        },
      });
      const passes = relayerPollingPasses("leased-recovery-poll",worker,manager);
      pass = () => control.run(async () => {
        for (const [,run] of passes) {
          try { await run(); }
          catch (error) { control.recordError(error); }
        }
      });
    }
  }
  await writeJson(process.env.LOCAL_READY_FILE,{ pid: process.pid,role,ready: true });
  while (!stopping) { await pass(); await pause(250); }
} catch (error) { if (!stopping) { console.error(`${role} stopped: ${safeError(error)}`); process.exitCode = 1; } }
finally { await metrics.close(); await pool.end(); if (process.connected) process.disconnect(); }
