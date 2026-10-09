import { loadValidatorConfig } from "./config.mjs";
import { createValidatorPool, createValidatorStore } from "./db.mjs";
import { createBatchValidationService, validateSourceContext } from "./source-validation.mjs";
import { createChainClient } from "../../indexer/src/indexer.mjs";
import { createValidatorServer } from "./server.mjs";
import { tableName } from "../../indexer/src/db.mjs";

let config;
let pool;
let sourcePool;
let runtime;
let stopping = false;

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { if (runtime) await runtime.close(); }
  finally { await Promise.all([pool?.end(), sourcePool?.end()]); }
}

try {
  config = loadValidatorConfig();
  pool = createValidatorPool(config);
  sourcePool = createValidatorPool({ databaseUrl: config.sourceDatabaseUrl });
  const store = createValidatorStore({ pool, config });
  // Migrations are explicit, owned by the validator subsystem, and applied before startup.
  await store.bindIdentity();
  await sourcePool.query(`SELECT batch_record_id FROM ${tableName(config.sourceDatabaseSchema, "message_batches")} LIMIT 0`);
  const publicClient = createChainClient(config);
  await validateSourceContext(publicClient, config);
  const service = createBatchValidationService({ config, sourcePool, store, publicClient });
  runtime = createValidatorServer({ config, service, store, checkReady: async () => {
    await store.checkIdentity();
    await sourcePool.query(`SELECT batch_record_id FROM ${tableName(config.sourceDatabaseSchema, "message_batches")} LIMIT 0`);
    await validateSourceContext(publicClient, config);
  } });
  await runtime.listen();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      shutdown().catch(() => { process.exitCode = 1; });
    });
  }
  console.log(`Validator ready: ${config.validatorAddress} pid=${process.pid} endpoint=http://${config.listenHost}:${config.listenPort}`);
} catch (error) {
  let message = error.message;
  if (config) {
    for (const secret of [config.privateKey, config.databaseUrl, config.sourceDatabaseUrl]) message = message.replaceAll(secret, "<redacted>");
  }
  console.error(`Validator startup failed: ${message}`);
  process.exitCode = 1;
  await shutdown();
}
