import { loadValidatorConfig } from "./config.mjs";
import { createValidatorPool, createValidatorStore } from "./db.mjs";
import { createBatchValidationService, validateConsensusBindings, validateSourceContext } from "./source-validation.mjs";
import { createChainClient } from "../../indexer/src/indexer.mjs";
import { createValidatorServer } from "./server.mjs";
import { tableName } from "../../indexer/src/db.mjs";
import { createPrePrepareService } from "./pre-prepare-service.mjs";
import { createPrepareService } from "./prepare-service.mjs";
import { createCommitService } from "./commit-service.mjs";
import { createBatchLifecycle } from "../../indexer/src/batch-lifecycle.mjs";
import { createViewChangeService } from "./view-change-service.mjs";
import { createConsensusRuntime } from "./consensus-runtime.mjs";

let config;
let pool;
let sourcePool;
let runtime;
let consensus;
let stopping = false;

async function shutdown() {
  if (stopping) return;
  stopping = true;
  try { if (consensus) await consensus.close(); if (runtime) await runtime.close(); }
  finally { await Promise.all([pool?.end(), sourcePool?.end()]); }
}

try {
  config = { ...loadValidatorConfig(), allowHistorical: true };
  pool = createValidatorPool(config);
  sourcePool = createValidatorPool({ databaseUrl: config.sourceDatabaseUrl });
  const store = createValidatorStore({ pool, config });
  // Migrations are explicit, owned by the validator subsystem, and applied before startup.
  await sourcePool.query(`SELECT batch_record_id FROM ${tableName(config.sourceDatabaseSchema, "message_batches")} LIMIT 0`);
  for (const table of ["batch_quorum_certificates", "batch_quorum_certificate_signatures"]) {
    await sourcePool.query(`SELECT batch_record_id FROM ${tableName(config.sourceDatabaseSchema, table)} LIMIT 0`);
  }
  for (const table of ["pbft_commit_votes", "pbft_commit_quorums", "pbft_epoch_views", "pbft_view_change_votes", "pbft_new_views"]) {
    await pool.query(`SELECT local_validator_identity FROM ${tableName(config.databaseSchema, table)} LIMIT 0`);
  }
  await pool.query(`SELECT target_view,view_change_at,progress_revision FROM ${tableName(config.databaseSchema, "pbft_epoch_views")} LIMIT 0`);
  await validateConsensusBindings(config,sourcePool);
  await store.bindIdentity();
  const publicClient = createChainClient(config);
  await validateSourceContext(publicClient, config);
  const service = createBatchValidationService({ config, sourcePool, store, publicClient });
  const prePrepare = createPrePrepareService({ config, validation: service, store });
  const prepare = createPrepareService({ config, store });
  const lifecycle = createBatchLifecycle({ config: { ...config, databaseSchema: config.sourceDatabaseSchema },
    pool: sourcePool, committee: config.peers, validatorSets: config.validatorSets });
  const commit = createCommitService({ config, store, lifecycle });
  const viewChange = createViewChangeService({ config, store, validation: service });
  consensus = createConsensusRuntime({ config, sourcePool, store, validation: service, lifecycle, prePrepare, prepare, commit, viewChange });
  // Complete initial local observations and epoch registration before readiness.
  // Peer traffic starts only after the HTTP listener is available.
  await consensus.initialize();
  runtime = createValidatorServer({ config, service, store, prePrepare, prepare, commit, viewChange, checkReady: async () => {
    if (!consensus.healthy()) throw new Error("consensus scheduler halted");
    await store.checkIdentity();
    await sourcePool.query(`SELECT batch_record_id FROM ${tableName(config.sourceDatabaseSchema, "message_batches")} LIMIT 0`);
    await validateSourceContext(publicClient, config);
  } });
  await runtime.listen();
  consensus.start();
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
