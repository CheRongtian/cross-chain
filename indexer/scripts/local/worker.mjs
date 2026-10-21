import { loadConfig } from "../../src/config.mjs";
import { createDatabasePool } from "../../src/db.mjs";
import { loadDeliveryConfig } from "../../src/delivery/config.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { loadTransactionConfig } from "../../src/transaction-manager/config.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { createRelaySubmissionRepository } from "../../src/relayer/repository.mjs";
import { createRelayerWorker } from "../../src/relayer/service.mjs";
import { startWorkerMetrics } from "../../src/metrics/http.mjs";
import { createLocalPipeline } from "./pipeline.mjs";
import { pause,safeError,writeJson } from "./tools.mjs";

const role = process.argv[2];
const config = role === "pipeline" ? loadDeliveryConfig() : loadTransactionConfig();
const pool = createDatabasePool(config);
const metrics = await startWorkerMetrics();
let stopping = false;
process.on("SIGINT",() => { stopping = true; }); process.on("SIGTERM",() => { stopping = true; });
try {
  await pool.query("SELECT 1");
  let pass;
  if (role === "pipeline") {
    const pipeline = createLocalPipeline({ config: { ...loadConfig(),...config },pool,peers: JSON.parse(process.env.VALIDATOR_PEERS) });
    pass = () => pipeline.runOnce();
  } else {
    const queue = createDeliveryRepository({ config,pool });
    const legacy = createRelaySubmissionRepository({ config,pool,queue });
    const manager = createTransactionManager({ config,pool,queue,legacy });
    await manager.verifyChain();
    const worker = createRelayerWorker({ config,pool,queue,transactionManager: manager });
    pass = async () => {
      // Recovery and retry stay under the existing renewed worker/job leases.
      // Receipt reconciliation observes canonical chain state independently.
      await worker.runOnce(); await manager.checkReceiptsOnce();
    };
  }
  await writeJson(process.env.LOCAL_READY_FILE,{ pid: process.pid,role,ready: true });
  while (!stopping) { await pass(); await pause(250); }
} catch (error) { console.error(`${role} stopped: ${safeError(error)}`); process.exitCode = 1; }
finally { await metrics.close(); await pool.end(); }
