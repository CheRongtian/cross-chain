import { loadValidatorConfig } from "./config.mjs";
import { createValidatorPool, createValidatorStore } from "./db.mjs";
import { createBatchValidationService, validateSourceContext } from "./source-validation.mjs";
import { createChainClient } from "../../indexer/src/indexer.mjs";
import { createValidatorServer } from "./server.mjs";
import { tableName } from "../../indexer/src/db.mjs";
import { createPrePrepareService } from "./pre-prepare-service.mjs";
import { createPrepareService } from "./prepare-service.mjs";
import { createCommitService } from "./commit-service.mjs";
import { createBatchLifecycle } from "../../indexer/src/batch-lifecycle.mjs";

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
  for (const table of ["batch_quorum_certificates", "batch_quorum_certificate_signatures"]) {
    await sourcePool.query(`SELECT batch_record_id FROM ${tableName(config.sourceDatabaseSchema, table)} LIMIT 0`);
  }
  for (const table of ["pbft_commit_votes", "pbft_commit_quorums"]) {
    await pool.query(`SELECT local_validator_identity FROM ${tableName(config.databaseSchema, table)} LIMIT 0`);
  }
  const publicClient = createChainClient(config);
  await validateSourceContext(publicClient, config);
  const service = createBatchValidationService({ config, sourcePool, store, publicClient });
  const prePrepare = createPrePrepareService({ config, validation: service, store });
  const prepare = createPrepareService({ config, store });
  const lifecycle = createBatchLifecycle({ config: { ...config, databaseSchema: config.sourceDatabaseSchema },
    pool: sourcePool, committee: config.peers });
  const commit = createCommitService({ config, store, lifecycle });
  runtime = createValidatorServer({ config, service, store, prePrepare, prepare, commit, checkReady: async () => {
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
