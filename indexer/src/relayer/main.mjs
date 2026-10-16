import { createDatabasePool } from "../db.mjs";
import { deliveryJson } from "../delivery/package.mjs";
import { createDeliveryRepository } from "../delivery/repository.mjs";
import { safeRelayerMessage } from "./config.mjs";
import { loadTransactionConfig, publicTransactionConfig } from "../transaction-manager/config.mjs";
import { createTransactionManager } from "../transaction-manager/service.mjs";
import { createRelaySubmissionRepository } from "./repository.mjs";
import { createRelayerWorker } from "./service.mjs";

let config;
let pool;
try {
  config = loadTransactionConfig();
  pool = createDatabasePool(config);
  const queue = createDeliveryRepository({ config,pool });
  const repository = createRelaySubmissionRepository({ config,pool,queue });
  console.log(`Relayer worker: ${deliveryJson(publicTransactionConfig(config))}`);
  const transactionManager = createTransactionManager({ config, pool, queue, legacy: repository });
  const result = await createRelayerWorker({ config,pool,queue,transactionManager }).runOnce();
  console.log(deliveryJson({ ...result, results: result.results.map((record) => ({ deliveryJobId: record.intent?.deliveryJobId ?? record.historicalSubmission?.deliveryJobId ?? record.deliveryJobId,
    transactionHash: record.attempt?.transactionHash ?? record.historicalSubmission?.transactionHash,
    ...(record.attempt ? { nonce: record.attempt.nonce } : {}),
    reason: record.reason,retryAt: record.retryAt,status: record.attempt?.status ?? record.action ?? "HISTORICAL",workerId: record.workerId,
    fencingToken: record.fencingToken,submitted: record.submitted })) }));
} catch (error) {
  console.error(`Relayer worker failed: ${safeRelayerMessage(error,config)}`);
  if (error.observations?.length) console.error(`Destination RPC observations: ${deliveryJson(error.observations)}`);
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
