import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { encodeAbiParameters, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { applyMigrations, createDatabasePool, readMessages, tableName } from "../../../indexer/src/db.mjs";
import { createIndexer } from "../../../indexer/src/indexer.mjs";
import { createFinalityWatcher } from "../../../indexer/src/finality-watcher.mjs";
import { createBatchLifecycle } from "../../../indexer/src/batch-lifecycle.mjs";
import { createDeliveryProjector } from "../../../indexer/src/delivery/projector.mjs";
import { createDeliveryRepository } from "../../../indexer/src/delivery/repository.mjs";
import { loadTransactionConfig } from "../../../indexer/src/transaction-manager/config.mjs";
import { createTransactionManager } from "../../../indexer/src/transaction-manager/service.mjs";
import { verifyRpcTransaction } from "../../../indexer/src/transaction-manager/receipts.mjs";
import { createRelayerProcesses } from "../../../indexer/test/helpers/multi-relayer-integration.mjs";
import { applyValidatorMigrations, createValidatorPool, createValidatorStore } from "../../src/db.mjs";
import { loadValidatorConfig } from "../../src/config.mjs";
import { deterministicPrimary } from "../../src/committee.mjs";
import { authenticatePrePrepare } from "../../src/pre-prepare.mjs";
import { authenticatePrepare } from "../../src/prepare.mjs";
import { authenticateCommit } from "../../src/commit.mjs";
import { expectedCommitStatement, verifyQuorumCertificate } from "../../src/quorum-certificate.mjs";
import { developmentKeys } from "./fixtures.mjs";
import { sourceState } from "./four-process.mjs";
import { createValidatorProcesses, reservePort, rpcObserver } from "./process-cluster.mjs";
import { createOwnedPostgresCluster } from "./postgres-cluster.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const same = (actual, expected, label) => assert.ok(isDeepStrictEqual(actual, expected), label);
const validatorTables = ["schema_migrations", "validator_metadata", "validator_committee", "validator_set_history",
  "validated_batch_bindings", "validation_observations", "pbft_epoch_views", "pbft_pre_prepares", "pbft_prepare_votes",
  "pbft_prepared_states", "pbft_commit_votes", "pbft_commit_quorums", "pbft_view_change_votes", "pbft_new_views"];
const operationalTables = ["schema_migrations", "delivery_batches", "delivery_jobs", "transaction_accounts", "transaction_intents",
  "transaction_attempts", "transaction_broadcast_events", "transaction_receipt_observations", "transaction_receipt_orphans", "relayer_worker_ids"];

async function tables(pool, schema, names) {
  const result = {};
  for (const name of names) result[name] = (await pool.query(`SELECT * FROM ${tableName(schema, name)} t ORDER BY to_jsonb(t)::text`)).rows;
  return result;
}

async function until(label, condition, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await condition();
    if (value) return value;
    await pause(50);
  } while (Date.now() < deadline);
  assert.fail(`PostgreSQL restart verification timed out: ${label}`);
}

// A real server outage on a separate owned cluster. All state machines below
// are the existing production implementations, with their real schemas.
export async function verifyPostgresRestart({ config: originalConfig, pool: originalPool, validatorSets, produceMessage,
  client, chainA, gateway, application, gatewayAbi, appAbi, rpcUrl, registryChecks, certificateChecks }) {
  console.log("\n[PostgreSQL Restart Recovery]");
  const registryPath = process.env.POSTGRES_VERIFICATION_REGISTRY_FILE;
  assert.ok(registryPath, "root verification must provide its owned PostgreSQL registry");
  const resources = { pools: [], reservations: [] };
  let cluster; let validatorProcesses; let relayers; let observer; let failure;
  const poolErrors = [];
  function ownPool(pool) {
    // These are orchestration/read pools, not production recovery logic.
    pool.on("error", error => poolErrors.push(error.code ?? "CONNECTION_LOST"));
    resources.pools.push(pool); return pool;
  }
  try {
    const originalSource = await sourceState(originalPool, originalConfig.databaseSchema);
    const latestEpoch = originalSource.message_batches.reduce((maximum, row) => BigInt(row.epoch) > maximum ? BigInt(row.epoch) : maximum, 0n);
    const epoch = latestEpoch + 1n;
    const supplier = toHex(0xa900000000000000000000000000000000000000n + epoch, { size: 20 });
    assert.equal(await client.readContract({ address: application, abi: appAbi, functionName: "isVerifiedSupplier", args: [supplier] }), false);
    cluster = await createOwnedPostgresCluster({ parent: dirname(registryPath), registryPath });
    console.log(`Owned PostgreSQL: run=${cluster.runId}; PGDATA=${cluster.dataDirectory}; port=${cluster.port}; loopback only`);
    const event = await produceMessage(encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "address" }], [1, 1, supplier]), {
      destinationGateway: gateway, destinationReceiver: application, deadlineFloor: (await client.getBlock()).timestamp + 7200n,
    });
    const config = { ...originalConfig, databaseUrl: cluster.databaseUrl, databaseSchema: "postgres_restart_source",
      sourceGatewayStartBlock: event.sourceBlockNumber, validatorSets };
    const pool = ownPool(createDatabasePool(config));
    await applyMigrations(pool, config.databaseSchema);
    const indexer = createIndexer({ config, pool, logger: quiet });
    const finality = createFinalityWatcher({ config, pool, logger: quiet });
    await indexer.catchUpOnce();
    assert.equal((await readMessages(pool, config.databaseSchema))[0].status, "OBSERVED");
    await finality.runFinalityPass();
    assert.equal((await readMessages(pool, config.databaseSchema))[0].status, "FINALIZING");
    await chainA.request({ method: "anvil_mine", params: [toHex(config.finalityBlockDepth)] });
    await indexer.catchUpOnce(); await finality.runFinalityPass();
    const [sourceRow] = await readMessages(pool, config.databaseSchema);
    assert.equal(sourceRow.message_id, event.messageId); assert.equal(sourceRow.status, "FINALIZED");

    const keys = developmentKeys(5);
    for (const key of keys) resources.reservations.push(await reservePort());
    const peers = keys.map((key, index) => ({ address: privateKeyToAccount(key).address.toLowerCase(),
      url: `http://127.0.0.1:${resources.reservations[index].port}` }));
    const selected = validatorSets.resolveForBatchEpoch(epoch);
    const active = peers.map((peer, index) => selected.validators.includes(peer.address) ? index : -1).filter(index => index >= 0);
    assert.equal(active.length, 4);
    const environments = new Map(); const states = new Map(); const records = new Map();
    const pidFile = join(dirname(registryPath), "postgres-validator-pids");
    validatorProcesses = createValidatorProcesses({ keys, pidFile });
    const lifecycle = createBatchLifecycle({ config, pool, committee: peers, validatorSets });
    const collected = await lifecycle.collectEligible({ initialEpoch: epoch });
    assert.equal(collected.assignedCount, 1);
    await lifecycle.sealBatch({ batchRecordId: collected.snapshot.record.batchRecordId });
    const pending = await lifecycle.markConsensusPending({ batchRecordId: collected.snapshot.record.batchRecordId });
    for (const index of active) {
      const environment = { VALIDATOR_PRIVATE_KEY: keys[index], VALIDATOR_LISTEN_HOST: "127.0.0.1",
        VALIDATOR_LISTEN_PORT: String(resources.reservations[index].port), VALIDATOR_PEERS: JSON.stringify(peers),
        VALIDATOR_SET_HISTORY_FILE: "", VALIDATOR_SET_HISTORY: JSON.stringify(validatorSets.history),
        SOURCE_DATABASE_URL: cluster.databaseUrl, SOURCE_DB_SCHEMA: config.databaseSchema,
        VALIDATOR_DATABASE_URL: cluster.databaseUrl, VALIDATOR_DB_SCHEMA: `postgres_restart_v${index + 1}`,
        CHAIN_A_DOMAIN: config.chainDomain.toString(), SOURCE_GATEWAY_ADDRESS: config.sourceGateway,
        CHAIN_A_RPC_URL: config.chainRpcUrl, FINALITY_BLOCK_DEPTH: config.finalityBlockDepth.toString(), PBFT_VIEW_TIMEOUT_MS: "3600000" };
      const validatorConfig = loadValidatorConfig(environment);
      const localPool = ownPool(createValidatorPool(validatorConfig));
      await applyValidatorMigrations(localPool, validatorConfig.databaseSchema);
      states.set(index, { config: validatorConfig, pool: localPool, store: createValidatorStore({ pool: localPool, config: validatorConfig }) });
      environments.set(index, environment);
      await resources.reservations[index].release();
      records.set(index, await validatorProcesses.start(environment));
    }
    const request = (index, route, body) => validatorProcesses.request(peers[index].url, route, body);
    const primary = peers.findIndex(peer => peer.address === deterministicPrimary(selected.validators, epoch));
    assert.ok(active.includes(primary));
    assert.equal((await request(primary, "/pbft/propose", { batchId: pending.record.batchId })).status, 200);
    for (const index of active) assert.equal((await request(index, "/pbft/prepare/cast", { epoch: epoch.toString() })).status, 200);
    for (const index of active.slice(0, 3)) assert.equal((await request(index, "/pbft/commit/cast", { epoch: epoch.toString() })).status, 200);
    const qc = (await request(active[0], "/pbft/qc", { epoch: epoch.toString() })).body.certificate;
    assert.ok(qc); assert.equal((await request(active[0], "/pbft/qc/submit", qc)).status, 200);
    const committed = await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId });
    assert.equal(committed.record.status, "COMMITTED");
    assert.equal(committed.consensusBinding.validatorEpoch, selected.validatorEpoch);
    await registryChecks.assertQcBinding(committed.quorumCertificate);
    await certificateChecks.snapshot(committed, "PostgreSQL restart message has a real pinned-committee QC");
    // Finish ordinary discovery before recording the baseline. Never rebuild
    // or reset these stores when the database comes back.
    await until("all four validator epochs finalized", async () => {
      const views = await Promise.all(active.map(index => states.get(index).store.readViewState(epoch)));
      return views.every(view => view?.finalized);
    });
    const queue = createDeliveryRepository({ config, pool });
    await createDeliveryProjector({ config, pool }).materializeBatch({ batchRecordId: committed.record.batchRecordId });
    const jobs = await queue.listReadyDeliveryJobs(); assert.equal(jobs.length, 1);
    const id = jobs[0].deliveryJobId; assert.equal(jobs[0].messageId, event.messageId);
    const entry = await queue.getDeliveryEntries([id]);
    console.log(`VALID: fresh exact-intent message ${event.messageId} reached source FINALIZED, real 4-validator/3-vote PBFT/QC COMMITTED and canonical READY ${id}`);
    console.log(`Persisted consensus identity: batch=${committed.record.batchId}; root=${committed.record.messageRoot}; validatorEpoch=${committed.consensusBinding.validatorEpoch}; committee=${committed.consensusBinding.committeeDigest}; QC=${committed.quorumCertificate.qcDigest}`);

    let sends = 0; let reader;
    observer = await rpcObserver(rpcUrl, { async beforeForward(message) {
      if (message.method !== "eth_sendRawTransaction") return;
      assert.equal(++sends, 1, "restart recovery must reconcile acceptance without another external send");
      const stored = await reader.repository.getTransaction(id);
      assert.ok(message.params[0] === stored.attempt.rawSignedTransaction, "wire bytes must match the durable signed candidate");
      assert.ok((await reader.repository.getBroadcastEvents(id)).some(row => row.endpointLabel !== null && row.completedAt === null));
      console.log("VALID: broadcast-start evidence was durable before the real Chain B send");
    } });
    const environment = { ...process.env, DATABASE_URL: cluster.databaseUrl, INDEXER_DB_SCHEMA: config.databaseSchema,
      CHAIN_A_DOMAIN: config.chainDomain.toString(), SOURCE_GATEWAY_ADDRESS: config.sourceGateway,
      CHAIN_B_RPC_URL: observer.url, CHAIN_B_RPC_URLS: JSON.stringify([observer.url]),
      CHAIN_B_GENESIS_HASH: (await client.getBlock({ blockNumber: 0n })).hash,
      VALIDATOR_SET_HISTORY_FILE: "", VALIDATOR_SET_HISTORY: JSON.stringify(validatorSets.history),
      RELAYER_WORKER_ID: "relayer-a", RELAYER_LEASE_MS: "5000" };
    const txConfig = loadTransactionConfig(environment);
    reader = createTransactionManager({ config: txConfig, pool, queue });
    relayers = createRelayerProcesses({ environment, pidFile: join(dirname(registryPath), "postgres-relayer-pids") });
    const first = relayers.start("relayer-a", { mode: "database-restart", checkpoint: "endpoint-result" });
    await first.started;
    const point = await first.wait("checkpoint", value => value.name === "endpoint-result");
    assert.equal(point.result.resultClass, "ACCEPTED"); assert.equal(point.id, id);
    const original = await reader.repository.getRecoverySnapshot(id);
    const durableAccount = await reader.repository.getAccount();
    const oldFence = (await first.wait("lease")).fence;
    assert.equal(original.intent.status, "PENDING"); assert.equal(original.attempt.status, "SIGNED");
    assert.equal(original.attempts.length, 1); assert.equal(original.attempt.broadcastAttemptCount, "1");
    assert.equal(original.broadcastEvents.length, 2);
    assert.ok(original.broadcastEvents.every(value => value.completedAt === null));
    const initialPreparation = await first.wait("preparation");
    assert.equal(initialPreparation.signatures, 1); assert.equal(initialPreparation.outcome, "SIGNED");
    const actual = await client.request({ method: "eth_getTransactionByHash", params: [original.attempt.transactionHash] });
    assert.ok(actual); verifyRpcTransaction(original.intent, original.attempt, actual);
    const accepted = await client.request({ method: "eth_getTransactionReceipt", params: [original.attempt.transactionHash] });
    assert.ok(accepted); assert.equal(BigInt(accepted.status), 1n);
    assert.equal(accepted.transactionHash, original.attempt.transactionHash);
    same((await reader.repository.listTrackingIntents({ limit: 1 })).map(value => value.intent.deliveryJobId), [id], "persist receipt scan progress before interruption");
    same(await reader.repository.listRecoveryIntents({ limit: 1 }), [id], "persist independent recovery scan progress before interruption");
    const durableSource = await sourceState(pool, config.databaseSchema);
    const durableOperations = await tables(pool, config.databaseSchema, operationalTables);
    const durableValidators = new Map();
    for (const index of active) durableValidators.set(index, await tables(states.get(index).pool, states.get(index).config.databaseSchema, validatorTables));
    const preparationCount = () => observer.calls.filter(value => ["eth_estimateGas", "eth_maxPriorityFeePerGas", "eth_gasPrice", "eth_feeHistory"].includes(value.method)).length;
    const beforePreparation = preparationCount();
    console.log(`VALID: delivery ${id} persisted one intent, sender ${original.intent.senderAddress}, nonce ${original.intent.nonce} and exact signed transaction ${original.attempt.transactionHash} before PostgreSQL interruption`);
    console.log(`VALID: Chain B accepted transaction ${accepted.transactionHash} before local result persistence completed; batch=${committed.record.batchId}; QC=${committed.quorumCertificate.qcDigest}`);

    console.log("EXPECTED FAILURE WINDOW: the owned database shutdown may halt/exit its dependent validators; both chains and the ordinary database stay available");
    await cluster.stop();
    console.log(`VALID: verification-owned PostgreSQL server was stopped while the pipeline was live; run=${cluster.runId}; port=${cluster.port}`);
    await assert.rejects(() => indexer.catchUpOnce(), error => ["ECONNREFUSED", "57P01", "57P02", "08006"].includes(error.code) || /connection|terminat/i.test(error.message));
    console.log("EXPECTED FAILURE: production Indexer operation failed while PostgreSQL was unavailable");
    console.log(`Observed owned orchestration-pool disconnects: ${poolErrors.length}`);
    // Release the existing callback barrier into its real failed persistence
    // path. No worker kill and no additional injected component fault.
    await first.send({ type: "continue" });
    await first.finish({ expectedError: "Relayer integration worker failed:" });
    assert.equal(sends, 1);
    assert.equal(BigInt(await chainA.getChainId()), config.chainDomain);
    assert.equal(await client.getChainId(), 2001);
    await cluster.assertDown();
    const originalDataDirectory = cluster.dataDirectory;
    await cluster.restart();
    assert.equal(cluster.dataDirectory, originalDataDirectory);
    console.log("VALID: the same verification-owned PostgreSQL data directory restarted successfully; no initdb, reseed or SQL repair was used for recovery");

    const freshPool = ownPool(createDatabasePool(config));
    same(await sourceState(freshPool, config.databaseSchema), durableSource, "source occurrence, block history, lifecycle and cursor must survive the actual server restart");
    same(await tables(freshPool, config.databaseSchema, operationalTables), durableOperations, "operational rows, all observation cursors, versions, counters and unresolved journals must survive unchanged");
    for (const index of active) {
      const state = states.get(index); const freshLocal = ownPool(createValidatorPool(state.config));
      same(await tables(freshLocal, state.config.databaseSchema, validatorTables), durableValidators.get(index), "validator identity, locks, votes, views, committee and QC must survive WAL recovery");
      states.set(index, { ...state, pool: freshLocal, store: createValidatorStore({ config: state.config, pool: freshLocal }) });
    }
    console.log("VALID: original source FINALIZED occurrence, batch membership/Message Root, validator epoch/committee/final QC and READY job survived PostgreSQL restart unchanged");
    console.log("VALID: PostgreSQL outage produced no new durable intent, nonce, signed candidate, PBFT vote, conflicting root or unjournaled external transaction");
    const freshQueue = createDeliveryRepository({ config, pool: freshPool });
    const recovered = createTransactionManager({ config: txConfig, pool: freshPool, queue: freshQueue });
    const freshLifecycle = createBatchLifecycle({ config, pool: freshPool, committee: peers, validatorSets });
    same(await recovered.repository.getRecoverySnapshot(id), original, "fresh production manager must reconstruct the exact interrupted transaction");
    same(await freshQueue.getDeliveryEntries([id]), entry, "READY package must remain exact");
    same(await freshLifecycle.readBatch({ batchRecordId: committed.record.batchRecordId }), committed, "committed reads must reverify the original immutable QC");
    await createIndexer({ config, pool: freshPool, logger: quiet }).catchUpOnce();
    await createFinalityWatcher({ config, pool: freshPool, logger: quiet }).runFinalityPass();
    same(await sourceState(freshPool, config.databaseSchema), durableSource, "fresh production Indexer/Finality passes must resume the durable cursor without rewriting finalized history");

    // PostgreSQL session locks disappear. Durable rows/fencing remain; verify
    // the old keys can be acquired/released without changing protocol rows.
    const lockClient = await freshPool.connect();
    try {
      for (const [name, column, key, value] of [["relayer_worker_ids", "lock_id", "worker_id", "relayer-a"],
        ["transaction_intents", "recovery_lock_id", "delivery_job_id", id]]) {
        const row = (await lockClient.query(`SELECT ((tableoid::bigint << 32) | ${column}::bigint)::text AS key FROM ${tableName(config.databaseSchema, name)} WHERE ${key} = $1`, [value])).rows[0];
        assert.equal((await lockClient.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [row.key])).rows[0].held, true);
        assert.equal((await lockClient.query("SELECT pg_advisory_unlock($1::bigint) AS released", [row.key])).rows[0].released, true);
      }
    } finally { lockClient.release(); }
    // Dependency recovery after the database returned: start the same normal
    // executables with the same identities/schemas. No initialization helper
    // or migration is called on these persisted validator stores.
    for (const index of active) {
      await validatorProcesses.stop(records.get(index));
      records.set(index, await validatorProcesses.start(environments.get(index)));
    }
    for (const index of active) {
      assert.equal((await request(index, "/health")).body.ready, true);
      const state = states.get(index);
      same(await tables(state.pool, state.config.databaseSchema, validatorTables), durableValidators.get(index), "normal process restart must not reset or rewrite PBFT history");
      const proposal = await state.store.readPrePrepare(epoch, "0"); await authenticatePrePrepare(state.config, proposal.envelope);
      const prepares = await state.store.readPrepareState(epoch, "0");
      for (const vote of prepares.votes) await authenticatePrepare(state.config, vote);
      const commits = await state.store.readCommitState(epoch, "0");
      for (const vote of commits.votes) await authenticateCommit(state.config, vote);
      await verifyQuorumCertificate(committed.quorumCertificate, { peers, validatorSets, expected: expectedCommitStatement(proposal.envelope, state.config) });
    }

    const leaseTable = tableName(config.databaseSchema, "relayer_job_leases");
    const persistedLease = (await freshPool.query(`SELECT * FROM ${leaseTable} WHERE delivery_job_id = $1`, [id])).rows[0];
    assert.equal(persistedLease.owner_session_id, oldFence.ownerSessionId);
    assert.equal(persistedLease.fencing_token, oldFence.fencingToken);
    assert.equal(persistedLease.lease_acquired_at.toISOString(), oldFence.leaseAcquiredAt);
    assert.ok(persistedLease.lease_expires_at.getTime() >= Date.parse(oldFence.leaseExpiresAt));
    assert.equal(persistedLease.preparation_retry_at, null);
    await until("durable lease expires according to database time", async () =>
      (await freshPool.query(`SELECT lease_expires_at <= clock_timestamp() AS expired FROM ${leaseTable} WHERE delivery_job_id = $1`, [id])).rows[0].expired);
    const resumed = relayers.start("relayer-a", { mode: "database-restart", pause: "signed" });
    await resumed.started; const loaded = await resumed.wait("signed");
    assert.notEqual(resumed.child.pid, first.child.pid);
    assert.equal(loaded.fence.deliveryJobId, id);
    assert.ok(BigInt(loaded.fence.fencingToken) > BigInt(oldFence.fencingToken));
    assert.notEqual(loaded.fence.ownerSessionId, oldFence.ownerSessionId);
    for (const field of ["attemptId", "nonce", "transactionHash", "rawSignedTransaction", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas"]) {
      assert.ok(loaded.stored.attempt[field] === original.attempt[field], `restart must preserve ${field}`);
    }
    await assert.rejects(() => recovered.repository.assertFence(id, oldFence), error => error.code === "STALE_FENCE");
    const reused = await resumed.wait("preparation");
    assert.equal(reused.outcome, "REUSED"); assert.equal(reused.estimates, 0); assert.equal(reused.feeQuotes, 0); assert.equal(reused.signatures, 0);
    await resumed.send({ type: "continue" }); await resumed.wait("result"); await resumed.finish();
    await client.request({ method: "anvil_mine", params: [toHex(txConfig.destinationConfirmations)] });
    await recovered.checkReceiptsOnce();
    const final = await recovered.repository.getRecoverySnapshot(id);
    assert.equal(final.intent.status, "CONFIRMED"); assert.equal(final.attempts.length, 1);
    assert.equal(final.winningAttempt.receiptStatus, 1);
    assert.ok(BigInt(final.winningAttempt.confirmedHead) - BigInt(final.winningAttempt.receiptBlockNumber) + 1n >= txConfig.destinationConfirmations);
    assert.equal(final.intent.intentId, original.intent.intentId); assert.equal(final.intent.nonce, original.intent.nonce);
    assert.equal(final.intent.senderAddress, original.intent.senderAddress); assert.equal(final.intent.packageDigest, original.intent.packageDigest);
    for (const field of ["attemptId", "nonce", "transactionHash", "rawSignedTransaction", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "createdAt"]) {
      assert.ok(final.attempt[field] === original.attempt[field], `canonical recovery must preserve ${field}`);
    }
    assert.equal(final.attempt.broadcastAttemptCount, "1");
    assert.ok(BigInt(final.version) >= BigInt(original.version));
    assert.equal(sends, 1); assert.equal(preparationCount(), beforePreparation);
    same(await recovered.repository.getAccount(), durableAccount, "reconnect must not reset or allocate another nonce");
    for (const oldEvent of original.broadcastEvents) {
      const restored = final.broadcastEvents.find(row => row.eventId === oldEvent.eventId);
      assert.ok(restored); assert.equal(restored.startedAt, oldEvent.startedAt); assert.equal(restored.attemptId, oldEvent.attemptId);
      assert.equal(restored.resultClass, "RECONCILED");
    }
    const observations = await recovered.repository.getReceiptObservations(id);
    assert.equal(observations.length, 1); assert.equal(observations[0].orphaned, false);
    assert.equal(observations[0].transactionHash, original.attempt.transactionHash);
    assert.equal(observations[0].blockHash, accepted.blockHash);
    assert.equal(await client.readContract({ address: gateway, abi: gatewayAbi, functionName: "isMessageExecuted", args: [event.messageId] }), true);
    assert.equal(await client.readContract({ address: application, abi: appAbi, functionName: "isVerifiedSupplier", args: [supplier] }), true);
    for (const [address, abi, name] of [[gateway, gatewayAbi, "CrossChainMessageExecuted"], [application, appAbi, "VerifiedSupplierGranted"]]) {
      const logs = await client.getLogs({ address, event: abi.find(value => value.type === "event" && value.name === name),
        args: { messageId: event.messageId }, fromBlock: 0n, toBlock: "latest" });
      assert.equal(logs.length, 1); assert.equal(logs[0].transactionHash, original.attempt.transactionHash);
    }
    same(await sourceState(freshPool, config.databaseSchema), durableSource, "receipt recovery must leave source/batch/Merkle/QC history unchanged");
    const roots = (await freshPool.query(`SELECT COUNT(DISTINCT message_root)::text AS roots FROM ${tableName(config.databaseSchema, "message_batches")} WHERE epoch = $1 AND status = 'COMMITTED'`, [epoch.toString()])).rows[0];
    assert.equal(roots.roots, "1");
    for (const index of active) {
      const state = states.get(index);
      same(await tables(state.pool, state.config.databaseSchema, validatorTables), durableValidators.get(index), "business recovery must preserve all original PBFT safety evidence");
    }
    const counts = (await freshPool.query(`SELECT (SELECT COUNT(*)::text FROM ${tableName(config.databaseSchema, "delivery_jobs")}) AS jobs,
      (SELECT COUNT(*)::text FROM ${tableName(config.databaseSchema, "transaction_intents")}) AS intents,
      (SELECT COUNT(*)::text FROM ${tableName(config.databaseSchema, "transaction_attempts")}) AS attempts`)).rows[0];
    same(counts, { jobs: "1", intents: "1", attempts: "1" }, "restart must not duplicate any delivery/transaction identity");
    await registryChecks.assertQcBinding(committed.quorumCertificate);
    await certificateChecks.snapshot(await freshLifecycle.readBatch({ batchRecordId: committed.record.batchRecordId }), "original QC reverified after database restart");
    same(await sourceState(originalPool, originalConfig.databaseSchema), originalSource, "the user's ordinary database must remain untouched by the owned-cluster scenario");
    console.log(`VALID: fresh production processes reconciled accepted transaction ${final.attempt.transactionHash} from canonical Chain B; same sender/intent/nonce/raw bytes/hash, no re-estimation, repricing, re-signing or second send`);
    console.log("VALID: original session locks were released; database-time lease expiry issued a higher fencing token and rejected the stale fence");
    console.log("VALID: PostgreSQL restart preserved validator safety state and exactly one durable committed root; production Gateway/ApplicationB executed the message exactly once");
    console.log("VALID: recovered transaction reached canonical CONFIRMED; zero lost messages, zero duplicate business executions and zero PBFT state corruption in this restart scenario");
    assert.equal(observer.errors.length, 0);
  } catch (error) { failure = error; throw error; }
  finally {
    // Stop owned workers before stopping/removing their owned database. The
    // root shell trap repeats disposal if this process is interrupted.
    const workerCleanup = await Promise.allSettled([relayers?.close(), validatorProcesses?.close()]);
    const otherCleanup = await Promise.allSettled([observer?.close(), ...resources.reservations.map(value => value.release()), ...resources.pools.map(value => value.end())]);
    const errors = [...workerCleanup, ...otherCleanup].filter(value => value.status === "rejected").map(value => value.reason);
    try { if (cluster) await cluster.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], "owned PostgreSQL scenario cleanup failed");
  }
}
