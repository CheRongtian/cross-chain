import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { encodeAbiParameters, toHex } from "viem";
import { readCursor, readMessages, tableName } from "../../../indexer/src/db.mjs";
import { createIndexer } from "../../../indexer/src/indexer.mjs";
import { createFinalityWatcher } from "../../../indexer/src/finality-watcher.mjs";
import { createDeliveryProjector } from "../../../indexer/src/delivery/projector.mjs";
import { buildDeliveryPackages } from "../../../indexer/src/delivery/package.mjs";
import { encodeGatewaySubmission } from "../../../indexer/src/relayer/encoding.mjs";
import { loadTransactionConfig } from "../../../indexer/src/transaction-manager/config.mjs";
import { createTransactionManager } from "../../../indexer/src/transaction-manager/service.mjs";
import { createDestinationRpcPool } from "../../../indexer/src/transaction-manager/rpc-pool.mjs";
import { verifyRpcTransaction } from "../../../indexer/src/transaction-manager/receipts.mjs";
import { createRelayerProcesses } from "../../../indexer/test/helpers/multi-relayer-integration.mjs";
import { destinationAccessPath } from "../../../indexer/test/helpers/rpc-failover-integration.mjs";
import { deterministicPrimary } from "../../src/committee.mjs";
import { authenticatePrePrepare } from "../../src/pre-prepare.mjs";
import { authenticatePrepare } from "../../src/prepare.mjs";
import { authenticateCommit } from "../../src/commit.mjs";
import { expectedCommitStatement, verifyQuorumCertificate } from "../../src/quorum-certificate.mjs";
import { sourceState } from "./four-process.mjs";
import { rpcObserver } from "./process-cluster.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const same = (actual, expected, label) => assert.ok(isDeepStrictEqual(actual, expected), label);
const safetyTables = ["validator_metadata", "validator_committee", "validator_set_history", "validation_observations",
  "validated_batch_bindings", "pbft_epoch_views", "pbft_pre_prepares", "pbft_prepare_votes",
  "pbft_prepared_states", "pbft_commit_votes", "pbft_commit_quorums", "pbft_view_change_votes", "pbft_new_views"];

async function until(label, condition, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await condition();
    if (value) return value;
    await pause(50);
  } while (Date.now() < deadline);
  assert.fail(`Multi-component recovery timed out: ${label}`);
}

async function safetyState(states) {
  const result = new Map();
  for (const [index, state] of states) {
    const rows = {};
    for (const name of safetyTables) rows[name] = (await state.pool.query(
      `SELECT * FROM ${tableName(state.config.databaseSchema, name)} t ORDER BY to_jsonb(t)::text`)).rows;
    result.set(index, rows);
  }
  return result;
}

function retained(actual, previous, label) {
  for (const [table, rows] of Object.entries(previous)) {
    for (const row of rows) assert.ok(actual[table].some(value => isDeepStrictEqual(value, row)), `${label}: ${table} history must survive`);
  }
}

// Continue in the already-live owned database and validator namespace. This
// scenario has no database fault controller and never restarts either chain.
export async function verifyMultiComponentRecovery({ config, pool, lifecycle, queue, validatorSets, peers, active,
  states, records, processes, request, produceMessage, client, chainA, gateway, application, gatewayAbi, appAbi,
  rpcUrl, registryChecks, certificateChecks }) {
  console.log("\n[Multi-component Recovery]");
  const paths = []; let observer; let relayers; let failure;
  try {
    const previousSource = await sourceState(pool, config.databaseSchema);
    const previousSafety = await safetyState(states);
    const previousEntries = await queue.getDeliveryEntries((await queue.listReadyDeliveryJobs()).map(job => job.deliveryJobId));
    const previousEpoch = previousSource.message_batches.reduce((maximum, row) => BigInt(row.epoch) > maximum ? BigInt(row.epoch) : maximum, 0n);
    const supplier = toHex(0xaa00000000000000000000000000000000000000n + previousEpoch + 1n, { size: 20 });
    assert.equal(await client.readContract({ address: application, abi: appAbi, functionName: "isVerifiedSupplier", args: [supplier] }), false);
    const event = await produceMessage(encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "address" }], [1, 1, supplier]), {
      destinationGateway: gateway, destinationReceiver: application, deadlineFloor: (await client.getBlock()).timestamp + 7200n,
    });
    const indexer = createIndexer({ config, pool, logger: quiet });
    const finality = createFinalityWatcher({ config, pool, logger: quiet });
    const targetRow = async () => {
      const rows = (await readMessages(pool, config.databaseSchema)).filter(row => row.message_id === event.messageId);
      assert.equal(rows.length, 1); return rows[0];
    };
    await indexer.catchUpOnce(); assert.equal((await targetRow()).status, "OBSERVED");
    await finality.runFinalityPass(); assert.equal((await targetRow()).status, "FINALIZING");
    await chainA.request({ method: "anvil_mine", params: [toHex(config.finalityBlockDepth)] });
    await indexer.catchUpOnce(); await finality.runFinalityPass();
    assert.equal((await targetRow()).status, "FINALIZED");
    assert.equal((await targetRow()).source_block_hash, event.sourceBlockHash);
    const cursor = await readCursor(pool, config.databaseSchema, config);
    assert.ok(BigInt(cursor.next_block) > event.sourceBlockNumber, "normal indexing must advance its persisted next-block cursor");
    console.log(`VALID: one fresh exact-intent ZK-authorized message ${event.messageId} traversed OBSERVED -> FINALIZING -> FINALIZED; supplier=${supplier}`);

    const collected = await lifecycle.collectEligible();
    assert.equal(collected.assignedCount, 1);
    const batchRecordId = collected.snapshot.record.batchRecordId;
    await lifecycle.sealBatch({ batchRecordId });
    const pending = await lifecycle.markConsensusPending({ batchRecordId });
    const epoch = pending.record.epoch;
    assert.equal(epoch, previousEpoch + 1n);
    same(pending.batch.messageIds, [event.messageId], "the composed batch must contain only its fresh source message");
    const selected = validatorSets.resolveForBatchEpoch(epoch);
    same([...active.map(index => peers[index].address)].sort(), selected.validators, "the existing four processes must match this batch's pinned committee");
    assert.equal(selected.validators.length, 4);
    const primaryAddress = deterministicPrimary(selected.validators, epoch, "0");
    const primary = peers.findIndex(peer => peer.address === primaryAddress);
    const offlineAddress = selected.validators.find(address => address !== primaryAddress);
    const offline = peers.findIndex(peer => peer.address === offlineAddress);
    const live = active.filter(index => index !== offline);
    assert.ok(active.includes(primary) && active.includes(offline)); assert.equal(live.length, 3);
    assert.equal(new Set(active.map(index => records.get(index).child.pid)).size, 4);
    await until("all four validators independently register the fresh pending epoch", async () => {
      const views = await Promise.all(active.map(index => states.get(index).store.readViewState(epoch)));
      return views.every(view => view?.batch_id === pending.record.batchId && view.message_root === pending.record.messageRoot);
    });
    for (const index of active) {
      assert.equal(records.get(index).exited, false);
      const store = states.get(index).store;
      const view = await store.readViewState(epoch);
      assert.equal(view.current_view, "0"); assert.equal(view.target_view, "0"); assert.equal(view.changing_view, false);
      assert.equal(await store.readPrePrepare(epoch, "0"), null);
      assert.equal((await store.readPrepareState(epoch, "0")).voteCount, 0);
      assert.equal((await store.readCommitState(epoch, "0")).voteCount, 0);
    }
    await processes.stop(records.get(offline));
    assert.equal(records.get(offline).exited, true);
    await assert.rejects(() => request(offline, "/health"));
    console.log(`FAULT: stopped active non-primary validator ${offlineAddress}, PID ${records.get(offline).child.pid}, before any target-epoch vote; primary=${primaryAddress}, view=0`);
    assert.equal((await request(primary, "/pbft/propose", { batchId: pending.record.batchId })).status, 200);
    for (const index of live) assert.equal((await request(index, "/pbft/prepare/cast", { epoch: epoch.toString() })).status, 200);
    for (const index of live) {
      const state = states.get(index); const proposal = await state.store.readPrePrepare(epoch, "0");
      assert.ok(proposal); await authenticatePrePrepare(state.config, proposal.envelope);
      const prepared = await state.store.readPrepareState(epoch, "0");
      assert.equal(prepared.voteCount, 3); assert.ok(prepared.prepared);
      same(prepared.votes.map(vote => vote.voterIdentity).sort(), live.map(member => peers[member].address).sort(), "PREPARED must use exactly the three live validators");
      for (const vote of prepared.votes) await authenticatePrepare(state.config, vote);
    }
    for (const index of live) assert.equal((await request(index, "/pbft/commit/cast", { epoch: epoch.toString() })).status, 200);
    const qc = (await request(live[0], "/pbft/qc", { epoch: epoch.toString() })).body.certificate;
    assert.ok(qc); assert.equal(qc.commits.length, 3); assert.equal(qc.view, "0");
    same(qc.commits.map(vote => vote.voterIdentity).sort(), live.map(index => peers[index].address).sort(), "QC must contain exactly the live signers, never the offline validator");
    for (const index of live) {
      const state = states.get(index); const proposal = await state.store.readPrePrepare(epoch, "0");
      const commits = await state.store.readCommitState(epoch, "0");
      assert.equal(commits.voteCount, 3); assert.ok(commits.quorum);
      for (const vote of commits.votes) await authenticateCommit(state.config, vote);
      await verifyQuorumCertificate(qc, { peers, validatorSets, expected: expectedCommitStatement(proposal.envelope, state.config) });
    }
    assert.equal((await request(live[0], "/pbft/qc/submit", qc)).status, 200);
    const committed = await lifecycle.readBatch({ batchRecordId });
    assert.equal(committed.record.status, "COMMITTED"); assert.equal(committed.record.messageRoot, pending.record.messageRoot);
    assert.equal(committed.consensusBinding.validatorEpoch, selected.validatorEpoch);
    assert.equal(committed.consensusBinding.committeeDigest, selected.committeeDigest);
    await until("all surviving validators finalize the same view", async () => {
      const views = await Promise.all(live.map(index => states.get(index).store.readViewState(epoch)));
      return views.every(view => view?.finalized && view.current_view === "0" && view.target_view === "0" && !view.changing_view);
    });
    for (const index of active) {
      const state = states.get(index);
      const predicate = "local_validator_identity = $1 AND epoch = $2 AND batch_id = $3 AND validator_epoch = $4 AND view = $5 AND voter_identity = $6 AND protocol_version = 3";
      const counts = (await state.pool.query(`SELECT
        (SELECT COUNT(*) FROM ${tableName(state.config.databaseSchema, "pbft_prepare_votes")} WHERE ${predicate})::text AS prepares,
        (SELECT COUNT(*) FROM ${tableName(state.config.databaseSchema, "pbft_commit_votes")} WHERE ${predicate})::text AS commits`,
      [state.config.validatorAddress, epoch.toString(), committed.record.batchId, selected.validatorEpoch, "0", offlineAddress])).rows[0];
      same(counts, { prepares: "0", commits: "0" }, "the offline validator must supply no target PREPARE or COMMIT anywhere");
    }
    const stoppedStore = states.get(offline).store;
    assert.equal(await stoppedStore.readPrePrepare(epoch, "0"), null);
    assert.equal((await stoppedStore.readPrepareState(epoch, "0")).prepared, null);
    assert.equal((await stoppedStore.readCommitState(epoch, "0")).quorum, null);
    console.log("VALID: stopped validator contributed exactly zero target-epoch PREPARE and COMMIT votes in every local store; no view change or quorum modification");
    await registryChecks.assertQcBinding(qc);
    await certificateChecks.snapshot(committed, "three live validators committed the composed-recovery message");
    console.log(`VALID: real PRE-PREPARE/PREPARE/PREPARED/COMMIT/QC reached COMMITTED with exactly 3-of-4 live signers; batchEpoch=${epoch}; batch=${committed.record.batchId}; root=${committed.record.messageRoot}; validatorEpoch=${selected.validatorEpoch}; committee=${selected.committeeDigest}; QC=${qc.qcDigest}`);

    const projected = await createDeliveryProjector({ config, pool }).materializeBatch({ batchRecordId });
    assert.equal(projected.createdJobs, 1);
    const packages = await buildDeliveryPackages(committed, { validatorSets }); assert.equal(packages.length, 1);
    const [pack] = packages; const id = pack.deliveryJobId;
    assert.equal(pack.message.messageId, event.messageId); assert.equal(pack.message.destinationGateway, gateway);
    assert.equal(pack.message.destinationReceiver, application);
    const entry = await queue.getDeliveryEntries([id]); assert.equal(entry[0].job.status, "READY");
    same(entry[0].package, pack, "READY must retain the authenticated canonical package");
    const encoded = await encodeGatewaySubmission(pack, { validatorSets, sourceDomain: config.chainDomain, sourceGateway: config.sourceGateway });
    const durableSource = await sourceState(pool, config.databaseSchema);
    const durableSafety = await safetyState(states);
    const { indexer_cursors: _oldCursor, ...oldRows } = previousSource;
    retained(durableSource, oldRows, "pre-existing source/batch/QC");
    for (const [index, old] of previousSafety) retained(durableSafety.get(index), old, "pre-existing validator");

    let reader; let signed; let takeoverFence; let sends = 0; let restored = false;
    const accepted = []; const wireOwners = [];
    const leaseTable = tableName(config.databaseSchema, "relayer_job_leases");
    const leaseState = async () => (await pool.query(`SELECT *,lease_expires_at > clock_timestamp() AS active,
      clock_timestamp() AS observed_at FROM ${leaseTable} WHERE delivery_job_id = $1`, [id])).rows[0];
    observer = await rpcObserver(rpcUrl, {
      async beforeForward(message) {
        if (message.method !== "eth_sendRawTransaction") return;
        assert.equal(restored, true, "no external send may precede restoration of every configured path");
        assert.equal(++sends, 1, "this bounded recovery must make exactly one real external send");
        assert.ok(message.params[0] === signed.attempt.rawSignedTransaction, "B must send exactly A's durable raw bytes");
        const lease = await leaseState();
        assert.equal(lease.owner_id, "relayer-b"); assert.equal(lease.active, true); assert.equal(lease.released_at, null);
        assert.ok(BigInt(lease.fencing_token) >= BigInt(takeoverFence.fencingToken));
        assert.ok((await reader.repository.getBroadcastEvents(id)).some(row => row.endpointLabel !== null && row.completedAt === null),
          "endpoint evidence must be committed before external send");
        wireOwners.push({ owner: lease.owner_id, token: lease.fencing_token, session: lease.owner_session_id });
      },
      async afterForward(message, reply) {
        if (message.method !== "eth_sendRawTransaction") return;
        assert.ok(reply && !reply.error); assert.equal(reply.result, signed.attempt.transactionHash); accepted.push(reply.result);
      },
    });
    paths.push(await destinationAccessPath(observer.url)); paths.push(await destinationAccessPath(observer.url));
    const genesis = (await client.getBlock({ blockNumber: 0n })).hash;
    const gatewayCode = await client.getCode({ address: gateway }); assert.ok(gatewayCode && gatewayCode !== "0x");
    const environment = { ...process.env, DATABASE_URL: config.databaseUrl, INDEXER_DB_SCHEMA: config.databaseSchema,
      CHAIN_A_DOMAIN: config.chainDomain.toString(), SOURCE_GATEWAY_ADDRESS: config.sourceGateway,
      CHAIN_B_RPC_URL: paths[0].url, CHAIN_B_RPC_URLS: JSON.stringify(paths.map(path => path.url)),
      CHAIN_B_CHAIN_ID: "2001", CHAIN_B_GENESIS_HASH: genesis, RELAYER_WORKER_ID: "relayer-a",
      RELAYER_LEASE_MS: "5000", RELAYER_MAX_JOBS_PER_RUN: "1",
      VALIDATOR_SET_HISTORY_FILE: "", VALIDATOR_SET_HISTORY: JSON.stringify(validatorSets.history) };
    const txConfig = loadTransactionConfig(environment);
    same(txConfig.destinationRpcUrls, paths.map(path => new URL(path.url).href), "every configured destination path must pass through an owned outage gate");
    reader = createTransactionManager({ config: txConfig, pool, queue });
    const history = new Map();
    for (const { job } of previousEntries) history.set(job.deliveryJobId, {
      stored: await reader.repository.getRecoverySnapshot(job.deliveryJobId), receipts: await reader.repository.getReceiptObservations(job.deliveryJobId),
    });
    const accountBefore = await reader.repository.getAccount(); assert.ok(accountBefore);
    const pendingNonce = BigInt(await client.request({ method: "eth_getTransactionCount", params: [txConfig.relayerAddress, "pending"] }));
    assert.equal(await reader.repository.getTransaction(id), null);
    const registryPath = process.env.POSTGRES_VERIFICATION_REGISTRY_FILE; assert.ok(registryPath);
    relayers = createRelayerProcesses({ environment, pidFile: join(dirname(registryPath), "postgres-relayer-pids") });
    const a = relayers.start("relayer-a", { mode: "leased-recovery-poll", checkpoint: "signed-persisted" });
    await a.started;
    const pointA = await a.wait("checkpoint", value => value.name === "signed-persisted");
    assert.equal(pointA.id, id); assert.equal(pointA.pid, a.child.pid); assert.equal(pointA.workerId, "relayer-a");
    assert.equal(pointA.stored.created, true);
    signed = await reader.repository.getRecoverySnapshot(id);
    same(pointA.stored.intent, signed.intent, "A intent must be durably committed");
    same(pointA.stored.attempts, signed.attempts, "A signed candidate must be durably committed");
    assert.equal(signed.intent.status, "PENDING"); assert.equal(signed.intent.intentId, id);
    assert.equal(signed.intent.senderAddress, txConfig.relayerAddress); assert.equal(signed.intent.destinationGateway, gateway);
    assert.ok(signed.intent.calldata === encoded.calldata, "signed calldata must encode the same authenticated message");
    assert.equal(signed.intent.packageDigest, encoded.packageDigest);
    assert.equal(signed.intent.winningAttemptId, null); assert.equal(signed.intent.retryStoppedAt, null);
    assert.equal(signed.attempts.length, 1); assert.equal(signed.attempt.attemptNumber, 0);
    assert.equal(signed.attempt.transactionType, 2); assert.equal(signed.attempt.replacementOfAttemptId, null);
    assert.equal(signed.attempt.status, "SIGNED"); assert.equal(signed.attempt.broadcastAttemptCount, "0");
    assert.equal(signed.attempt.broadcastAt, null); assert.equal(signed.attempt.receiptBlockHash, null);
    assert.equal(signed.broadcastEvents.length, 0);
    const account = await reader.repository.getAccount();
    assert.equal(BigInt(signed.intent.nonce), BigInt(accountBefore.nextNonce) > pendingNonce ? BigInt(accountBefore.nextNonce) : pendingNonce);
    assert.equal(account.nextNonce, (BigInt(signed.intent.nonce) + 1n).toString());
    assert.equal(account.highestReservedNonce, signed.intent.nonce);
    const prepA = await a.wait("preparation", value => value.deliveryJobId === id);
    same([prepA.estimates, prepA.feeQuotes, prepA.signatures, prepA.outcome], [1, 1, 1, "SIGNED"], "only A initially prepares and signs");
    const noExecution = async () => {
      assert.equal(await client.readContract({ address: gateway, abi: gatewayAbi, functionName: "isMessageExecuted", args: [event.messageId] }), false);
      assert.equal(await client.readContract({ address: application, abi: appAbi, functionName: "isVerifiedSupplier", args: [supplier] }), false);
      assert.equal(await client.request({ method: "eth_getTransactionByHash", params: [signed.attempt.transactionHash] }), null);
      assert.equal(await client.request({ method: "eth_getTransactionReceipt", params: [signed.attempt.transactionHash] }), null);
    };
    const retainedUnsent = async () => {
      same(await reader.repository.getRecoverySnapshot(id), signed, "pre-send crash/outage must retain the exact durable transaction and empty journal");
      same(await reader.repository.getAccount(), account, "recovery must not reserve another nonce");
      same(await queue.getDeliveryEntries([id]), entry, "the same READY job/package must survive");
      assert.equal(sends, 0); await noExecution();
    };
    await retainedUnsent();
    assert.equal((await leaseState()).active, true);
    console.log(`VALID: READY job=${id}; Relayer A PID=${a.child.pid}; intent=${signed.intent.intentId}; sender=${signed.intent.senderAddress}; nonce=${signed.intent.nonce}; signed hash=${signed.attempt.transactionHash}; zero broadcast starts/sends`);
    const b = relayers.start("relayer-b", { mode: "leased-recovery-poll", checkpoint: "signed-persisted" });
    await b.started;
    const busy = await b.wait("poll-pass", value => value.operation === "delivery" && value.summary.selected === 0);
    assert.equal(busy.pid, b.child.pid); assert.notEqual(a.child.pid, b.child.pid);
    assert.equal(b.messages.some(value => value.type === "lease"), false);
    assert.equal((await leaseState()).owner_session_id, pointA.fence.ownerSessionId);
    await relayers.stop(a, "SIGKILL"); assert.equal((await a.closed).signal, "SIGKILL");
    const abandoned = await leaseState();
    assert.equal(abandoned.owner_id, "relayer-a"); assert.equal(abandoned.active, true); assert.equal(abandoned.released_at, null);
    assert.equal(abandoned.fencing_token, pointA.fence.fencingToken);
    await retainedUnsent();
    console.log(`FAULT: SIGKILL Relayer A after durable SIGNED and before any send; B PID=${b.child.pid} continues ordinary polling, waiting for PostgreSQL-time expiry ${abandoned.lease_expires_at.toISOString()}`);
    const pointB = await b.wait("checkpoint", value => value.name === "signed-persisted");
    takeoverFence = pointB.fence;
    assert.equal(pointB.id, id); assert.equal(pointB.pid, b.child.pid); assert.equal(pointB.workerId, "relayer-b");
    assert.equal(takeoverFence.ownerId, "relayer-b"); assert.equal(pointB.stored.created, false);
    assert.notEqual(takeoverFence.ownerSessionId, pointA.fence.ownerSessionId);
    assert.ok(BigInt(takeoverFence.fencingToken) > BigInt(pointA.fence.fencingToken));
    same(pointB.stored.intent, signed.intent, "B must load A's original intent");
    same(pointB.stored.attempts, signed.attempts, "B must load A's original signed bytes, hash, nonce, gas and fees");
    const held = await leaseState();
    assert.equal(held.owner_session_id, takeoverFence.ownerSessionId); assert.equal(held.fencing_token, takeoverFence.fencingToken);
    assert.equal(held.active, true); assert.equal(held.released_at, null);
    assert.ok(held.lease_acquired_at >= abandoned.lease_expires_at, "takeover must follow the dead owner's actual renewed expiry");
    assert.ok(held.observed_at >= abandoned.lease_expires_at);
    const prepB = await b.wait("preparation", value => value.deliveryJobId === id);
    same([prepB.estimates, prepB.feeQuotes, prepB.signatures, prepB.outcome], [0, 0, 0, "REUSED"], "B cannot re-estimate, reprice or sign");
    await assert.rejects(() => reader.prepareDeliveryTransaction(id, { fence: pointA.fence }), error => error.code === "STALE_FENCE");
    await assert.rejects(() => reader.continueDeliveryTransactionOnce(id, { fence: pointA.fence }), error => error.code === "STALE_FENCE");
    await retainedUnsent();
    console.log(`VALID: B autonomously acquired the same job after natural lease expiry with fencing token ${takeoverFence.fencingToken}, reused the original candidate, and production rejected stale A before protected mutation`);

    const preparationCalls = () => observer.calls.filter(call => ["eth_estimateGas", "eth_maxPriorityFeePerGas", "eth_gasPrice", "eth_feeHistory"].includes(call.method)).length;
    const initialPreparationCalls = preparationCalls();
    const beforeDown = paths.map(path => path.calls.length);
    for (const path of paths) path.state.available = false;
    // One release of the test-only takeover barrier. No later per-job command,
    // parent send/recovery call, worker restart or selection override is used.
    await b.send({ type: "continue" });
    const unavailable = await b.wait("poll-error", value => value.operation === "delivery" && value.errorCode === "RPC_UNAVAILABLE");
    assert.equal(unavailable.pid, b.child.pid); assert.equal(unavailable.observations.length, paths.length);
    assert.equal(new Set(unavailable.observations.map(value => value.endpointLabel)).size, paths.length);
    assert.ok(unavailable.observations.every(value => value.outcome === "UNAVAILABLE" && value.errorClass === "TRANSIENT_RPC_ERROR"));
    for (const [index, path] of paths.entries()) assert.ok(path.calls.length > beforeDown[index], "the real B process must observe each unavailable path");
    await retainedUnsent();
    assert.equal((await pool.query("SELECT 1 AS alive")).rows[0].alive, 1);
    assert.equal(BigInt(await chainA.getChainId()), config.chainDomain); assert.equal(await client.getChainId(), 2001);
    assert.equal((await client.getBlock({ blockNumber: 0n })).hash, genesis);
    assert.equal(await client.getCode({ address: gateway }), gatewayCode);
    assert.equal(preparationCalls(), initialPreparationCalls);
    same(await sourceState(pool, config.databaseSchema), durableSource, "transport faults cannot rebuild source, batch, Merkle or QC state");
    same(await safetyState(states), durableSafety, "transport faults cannot clear PBFT safety state");
    console.log(`FAULT OBSERVED: B returned structured RPC_UNAVAILABLE for all ${paths.length} configured paths after takeover and before its first send; both chains and PostgreSQL remained online, the exact SIGNED candidate and READY job remained intact`);
    const restorationOffset = observer.calls.length;
    for (const path of paths) path.state.available = true;
    restored = true;
    const rpc = createDestinationRpcPool({ config: txConfig });
    for (let index = 0; index < paths.length; index++) assert.equal((await rpc.probeEndpoint(index)).status, "HEALTHY");
    assert.equal(await rpc.verifyChain(), txConfig.destinationDomain);
    const receipt = await until("the same polling B sends and mines the retained transaction", () =>
      client.request({ method: "eth_getTransactionReceipt", params: [signed.attempt.transactionHash] }));
    assert.equal(BigInt(receipt.status), 1n);
    await client.request({ method: "anvil_mine", params: [toHex(txConfig.destinationConfirmations)] });
    await until("the same B process persists canonical configured-depth CONFIRMED", async () => {
      assert.equal(b.exited, false);
      return (await reader.repository.getTransaction(id)).intent.status === "CONFIRMED";
    });
    await b.send({ type: "stop-polling" }); await b.wait("result"); await b.finish();
    const final = await reader.repository.getRecoverySnapshot(id);
    assert.equal(final.intent.status, "CONFIRMED"); assert.equal(final.attempt.status, "CONFIRMED");
    assert.equal(final.intent.winningAttemptId, signed.attempt.attemptId); assert.equal(final.attempts.length, 1);
    assert.equal(final.winningAttempt.receiptStatus, 1); assert.equal(final.attempt.broadcastAttemptCount, "1");
    assert.equal(final.attempt.receiptBlockHash, receipt.blockHash);
    assert.equal(final.attempt.receiptBlockNumber, BigInt(receipt.blockNumber).toString());
    assert.ok(BigInt(final.attempt.confirmedHead) - BigInt(final.attempt.receiptBlockNumber) + 1n >= txConfig.destinationConfirmations);
    assert.equal((await client.getBlock({ blockNumber: BigInt(receipt.blockNumber) })).hash, receipt.blockHash);
    for (const field of ["intentId", "deliveryJobId", "packageDigest", "chainId", "senderAddress", "destinationGateway", "value", "calldata", "nonce", "createdAt"]) {
      assert.ok(final.intent[field] === signed.intent[field], `canonical recovery must preserve original intent ${field}`);
    }
    for (const field of ["attemptId", "attemptNumber", "replacementOfAttemptId", "nonce", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "transactionType", "rawSignedTransaction", "transactionHash", "createdAt"]) {
      assert.ok(final.attempt[field] === signed.attempt[field], `canonical recovery must preserve original candidate ${field}`);
    }
    assert.equal(final.intent.retryStoppedAt, null); assert.ok(BigInt(final.version) >= BigInt(signed.version));
    same(await reader.repository.getAccount(), account, "confirmation cannot reset the allocator or reserve another nonce");
    assert.equal(BigInt(await client.request({ method: "eth_getTransactionCount", params: [txConfig.relayerAddress, "pending"] })), BigInt(signed.intent.nonce) + 1n);
    assert.equal(sends, 1); same(accepted, [signed.attempt.transactionHash], "one exact external acceptance");
    assert.equal(wireOwners.length, 1); assert.equal(wireOwners[0].owner, "relayer-b");
    assert.equal(preparationCalls(), initialPreparationCalls);
    assert.ok(observer.calls.slice(restorationOffset).some(call => call.method === "eth_chainId"));
    assert.ok(observer.calls.slice(restorationOffset).some(call => call.method === "eth_getBlockByNumber" && call.params[0] === "0x0"));
    assert.equal(a.messages.filter(value => value.type === "preparation" && value.outcome === "SIGNED").length, 1);
    for (const message of b.messages.filter(value => value.type === "preparation")) {
      same([message.estimates, message.feeQuotes, message.signatures, message.outcome], [0, 0, 0, "REUSED"], "every later B preparation must reuse durable fields");
    }
    assert.equal(a.messages.some(value => value.type === "result"), false);
    assert.equal(b.messages.filter(value => value.type === "checkpoint").length, 1);
    assert.equal(final.broadcastEvents.length, 2);
    assert.equal(final.broadcastEvents.filter(row => row.parentEventId === null).length, 1);
    assert.equal(final.broadcastEvents.filter(row => row.parentEventId !== null).length, 1);
    same(final.broadcastEvents.map(row => row.broadcastSequence), ["1", "2"], "broadcast journal sequence must advance without reset or deletion");
    for (const row of final.broadcastEvents) {
      assert.notEqual(row.completedAt, null); assert.equal(row.resultClass, "ACCEPTED");
      assert.equal(row.errorClass, null); assert.equal(row.returnedTransactionHash, signed.attempt.transactionHash);
    }
    const observations = await reader.repository.getReceiptObservations(id);
    assert.equal(observations.length, 1); assert.equal(observations[0].orphaned, false);
    assert.equal(observations[0].transactionHash, signed.attempt.transactionHash); assert.equal(observations[0].blockHash, receipt.blockHash);
    verifyRpcTransaction(final.intent, final.attempt, await client.request({ method: "eth_getTransactionByHash", params: [signed.attempt.transactionHash] }), receipt);
    assert.equal(await client.readContract({ address: gateway, abi: gatewayAbi, functionName: "isMessageExecuted", args: [event.messageId] }), true);
    assert.equal(await client.readContract({ address: application, abi: appAbi, functionName: "isVerifiedSupplier", args: [supplier] }), true);
    for (const [address, abi, name] of [[gateway, gatewayAbi, "CrossChainMessageExecuted"], [application, appAbi, "VerifiedSupplierGranted"]]) {
      const logs = await client.getLogs({ address, event: abi.find(value => value.type === "event" && value.name === name),
        args: { messageId: event.messageId }, fromBlock: 0n, toBlock: "latest" });
      assert.equal(logs.length, 1); assert.equal(logs[0].transactionHash, signed.attempt.transactionHash);
      if (address === gateway) {
        assert.equal(logs[0].args.batchId, committed.record.batchId); assert.equal(logs[0].args.sourceDomain, config.chainDomain);
        assert.equal(logs[0].args.destinationReceiver.toLowerCase(), application);
      } else assert.equal(logs[0].args.supplier.toLowerCase(), supplier);
    }
    same(await queue.getDeliveryEntries([id]), entry, "no job/package identity may change during composed recovery");
    same(await sourceState(pool, config.databaseSchema), durableSource, "all source, batch, Merkle and QC history must survive composed recovery");
    same(await safetyState(states), durableSafety, "all pinned committee/view/vote/QC safety history must survive composed recovery");
    same(await lifecycle.readBatch({ batchRecordId }), committed, "the original committed QC must reverify without a new round");
    same(await queue.getDeliveryEntries(previousEntries.map(value => value.job.deliveryJobId)), previousEntries, "earlier READY history must remain unchanged");
    for (const [previousId, value] of history) {
      same(await reader.repository.getRecoverySnapshot(previousId), value.stored, "earlier transaction/journal/version history must remain unchanged");
      same(await reader.repository.getReceiptObservations(previousId), value.receipts, "earlier canonical receipt history must remain unchanged");
    }
    const counts = (await pool.query(`SELECT
      (SELECT COUNT(*) FROM ${tableName(config.databaseSchema, "delivery_jobs")} WHERE message_id = $2)::text AS jobs,
      (SELECT COUNT(*) FROM ${tableName(config.databaseSchema, "transaction_intents")} WHERE delivery_job_id = $1)::text AS intents,
      COUNT(*)::text AS attempts,COUNT(DISTINCT nonce)::text AS nonces,COUNT(DISTINCT transaction_hash)::text AS hashes,
      COUNT(*) FILTER (WHERE replacement_of_attempt_id IS NOT NULL)::text AS replacements
      FROM ${tableName(config.databaseSchema, "transaction_attempts")} WHERE delivery_job_id = $1`, [id, event.messageId])).rows[0];
    same(counts, { jobs: "1", intents: "1", attempts: "1", nonces: "1", hashes: "1", replacements: "0" }, "one continuous message must retain one durable transport identity");
    assert.equal((await pool.query(`SELECT COUNT(DISTINCT message_root)::text AS roots FROM ${tableName(config.databaseSchema, "message_batches")} WHERE epoch = $1 AND status = 'COMMITTED'`, [epoch.toString()])).rows[0].roots, "1");
    await registryChecks.assertQcBinding(qc); await certificateChecks.snapshot(committed, "original composed-recovery QC remains valid after execution");
    assert.equal(records.get(offline).exited, true);
    for (const index of live) { assert.equal(records.get(index).exited, false); assert.equal((await request(index, "/health")).body.ready, true); }
    assert.equal(observer.errors.length, 0); for (const path of paths) assert.equal(path.errors.length, 0);
    console.log(`VALID: the same B PID=${b.child.pid} automatically resumed after all RPC paths recovered with unchanged Chain B identity; exact original hash=${final.attempt.transactionHash}, canonical receipt block=${final.attempt.receiptBlockNumber}, confirmations>=${txConfig.destinationConfirmations}`);
    console.log("VALID: combined non-primary validator stop -> Relayer A SIGKILL -> natural-expiry B takeover -> all-path RPC outage -> autonomous recovery completed for ONE message; exactly one READY job, intent, nonce, candidate, accepted external send, Gateway execution and ApplicationB transition; zero replacements");
    console.log("VALID: source provenance/finality, batch/Merkle, pinned committee, same-view 3-of-4 QC, earlier transaction history and fencing authority survived; PostgreSQL and both chains stayed online throughout this composed scenario");
  } catch (error) { failure = error; throw error; }
  finally {
    // The surrounding owner cleans up validators/database. Restore test gates
    // first, stop only our workers, then remove our two access paths/observer.
    for (const path of paths) path.state.available = true;
    const workerCleanup = await Promise.allSettled([relayers?.close()]);
    const transportCleanup = await Promise.allSettled([...paths.map(path => path.close()), observer?.close()]);
    const errors = [...workerCleanup, ...transportCleanup].filter(value => value.status === "rejected").map(value => value.reason);
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], "multi-component recovery cleanup failed");
  }
}
