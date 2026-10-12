import { createDatabasePool } from "../db.mjs";
import { deliveryJson } from "../delivery/package.mjs";
import { createDeliveryRepository } from "../delivery/repository.mjs";
import { safeRelayerMessage } from "./config.mjs";
import { loadTransactionConfig, publicTransactionConfig } from "../transaction-manager/config.mjs";
import { createTransactionManager } from "../transaction-manager/service.mjs";
import { createRelaySubmissionRepository } from "./repository.mjs";
import { createSingleRelayer } from "./service.mjs";

let config;
let pool;
try {
  config = loadTransactionConfig();
  pool = createDatabasePool(config);
  const queue = createDeliveryRepository({ config,pool });
  const repository = createRelaySubmissionRepository({ config,pool,queue });
  console.log(`Relayer A: ${deliveryJson(publicTransactionConfig(config))}`);
  const transactionManager = createTransactionManager({ config, pool, queue, legacy: repository });
  const result = await createSingleRelayer({ config,queue,repository,transactionManager }).runOnce();
  console.log(deliveryJson({ ...result, results: result.results.map((record) => ({ deliveryJobId: record.intent?.deliveryJobId ?? record.historicalSubmission?.deliveryJobId,
    transactionHash: record.attempt?.transactionHash ?? record.historicalSubmission?.transactionHash,
    nonce: record.attempt?.nonce ?? null, status: record.attempt?.status ?? "HISTORICAL", submitted: record.submitted })) }));
} catch (error) {
  console.error(`Relayer A failed: ${safeRelayerMessage(error,config)}`);
  if (error.observations?.length) console.error(`Destination RPC observations: ${deliveryJson(error.observations)}`);
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
