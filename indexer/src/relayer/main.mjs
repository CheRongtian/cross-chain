import { createDatabasePool } from "../db.mjs";
import { deliveryJson } from "../delivery/package.mjs";
import { createDeliveryRepository } from "../delivery/repository.mjs";
import { safeRelayerMessage } from "./config.mjs";
import { loadTransactionConfig, publicTransactionConfig } from "../transaction-manager/config.mjs";
import { createTransactionManager } from "../transaction-manager/service.mjs";
import { createRelaySubmissionRepository } from "./repository.mjs";
import { createRelayerWorker } from "./service.mjs";
import { formatRelayerSummary } from "./summary.mjs";
import { startWorkerMetrics } from "../metrics/http.mjs";

let config;
let pool;
const metricsListener = await startWorkerMetrics();
try {
  config = loadTransactionConfig();
  pool = createDatabasePool(config);
  const queue = createDeliveryRepository({ config,pool });
  const repository = createRelaySubmissionRepository({ config,pool,queue });
  console.log(`Relayer worker: ${deliveryJson(publicTransactionConfig(config))}`);
  const transactionManager = createTransactionManager({ config, pool, queue, legacy: repository });
  const result = await createRelayerWorker({ config,pool,queue,transactionManager }).runOnce();
  console.log(deliveryJson({ workerId: result.workerId,relayerAddress: result.relayerAddress,
    destinationDomain: result.destinationDomain,selected: result.selected,submitted: result.submitted,
    deferred: result.deferred,skipped: result.skipped,results: result.results.map(formatRelayerSummary) }));
} catch (error) {
  console.error(`Relayer worker failed: ${safeRelayerMessage(error,config)}`);
  if (error.observations?.length) console.error(`Destination RPC observations: ${deliveryJson(error.observations)}`);
  process.exitCode = 1;
} finally { await metricsListener.close(); if (pool) await pool.end(); }
