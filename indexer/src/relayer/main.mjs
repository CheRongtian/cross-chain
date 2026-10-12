import { createDatabasePool } from "../db.mjs";
import { deliveryJson } from "../delivery/package.mjs";
import { createDeliveryRepository } from "../delivery/repository.mjs";
import { loadRelayerConfig, publicRelayerConfig, safeRelayerMessage } from "./config.mjs";
import { createRelaySubmissionRepository } from "./repository.mjs";
import { createSingleRelayer } from "./service.mjs";
import { createDirectRpcSubmitter } from "./submitter.mjs";

let config;
let pool;
try {
  config = loadRelayerConfig();
  pool = createDatabasePool(config);
  const queue = createDeliveryRepository({ config,pool });
  const repository = createRelaySubmissionRepository({ config,pool,queue });
  console.log(`Relayer A: ${deliveryJson(publicRelayerConfig(config))}`);
  const result = await createSingleRelayer({ config,queue,repository,submitter: createDirectRpcSubmitter(config) }).runOnce();
  console.log(deliveryJson(result));
} catch (error) {
  console.error(`Relayer A failed: ${safeRelayerMessage(error,config)}`);
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
