import { createDatabasePool } from "../db.mjs";
import { deliveryJson } from "../delivery/package.mjs";
import { safeRelayerMessage } from "../relayer/config.mjs";
import { loadTransactionConfig, publicTransactionConfig } from "./config.mjs";
import { createTransactionManager } from "./service.mjs";

let config;
let pool;
try {
  config = loadTransactionConfig();
  pool = createDatabasePool(config);
  const manager = createTransactionManager({ config, pool });
  const [operation, jobId] = process.argv.slice(2);
  console.log(`Transaction Manager: ${deliveryJson(publicTransactionConfig(config))}`);
  let result;
  if (operation === "receipts" && !jobId) result = await manager.checkReceiptsOnce();
  else if (operation === "retries" && !jobId) result = await manager.processTransactionRetriesOnce();
  else if (operation === "prepare" && jobId) result = await manager.prepareDeliveryTransaction(jobId);
  else if (operation === "broadcast" && jobId) result = await manager.broadcastPreparedTransaction(jobId);
  else if (operation === "rebroadcast" && jobId) result = await manager.rebroadcastTransaction(jobId);
  else if (operation === "replace" && jobId) result = await manager.prepareReplacement(jobId);
  else if (operation === "read" && jobId) result = await manager.repository.getTransaction(jobId);
  else throw new Error("Expected receipts, retries, prepare/broadcast/rebroadcast/replace/read <deliveryJobId>");
  console.log(deliveryJson(result));
} catch (error) {
  console.error(`Transaction Manager failed: ${safeRelayerMessage(error, config)}`);
  if (error.observations?.length) console.error(`Destination RPC observations: ${deliveryJson(error.observations)}`);
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
