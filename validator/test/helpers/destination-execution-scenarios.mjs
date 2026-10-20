import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { createPublicClient, createWalletClient, decodeAbiParameters, decodeEventLog, decodeFunctionData,
  defineChain, encodeAbiParameters, http, parseAbi, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalizeAddress, computeCanonicalMessageId, computePayloadHash } from "../../../indexer/src/canonical-message.mjs";
import { computeMessageMerkleLeaf, computeMessageMerkleNode } from "../../../indexer/src/message-merkle.mjs";
import { createDatabasePool, createFinalityStore, readCursor, readIndexedSourceBlocks, readMessages, tableName } from "../../../indexer/src/db.mjs";
import { createBatchLifecycle } from "../../../indexer/src/batch-lifecycle.mjs";
import { createIndexer } from "../../../indexer/src/indexer.mjs";
import { createFinalityWatcher } from "../../../indexer/src/finality-watcher.mjs";
import { buildDeliveryPackages } from "../../../indexer/src/delivery/package.mjs";
import { createDeliveryProjector } from "../../../indexer/src/delivery/projector.mjs";
import { createDeliveryRepository } from "../../../indexer/src/delivery/repository.mjs";
import { DELIVERY_POLICY } from "../../../indexer/src/delivery/policy.mjs";
import { encodeDestinationSubmission, encodeGatewaySubmission, ENVELOPE_PARAMETERS, MESSAGE_PARAMETERS,
  QC_PARAMETERS, DESTINATION_GATEWAY_ABI } from "../../../indexer/src/relayer/encoding.mjs";
import { createRelayerWorker } from "../../../indexer/src/relayer/service.mjs";
import { createRelayerLeaseRepository } from "../../../indexer/src/relayer/leases.mjs";
import { loadTransactionConfig } from "../../../indexer/src/transaction-manager/config.mjs";
import { createTransactionManager } from "../../../indexer/src/transaction-manager/service.mjs";
import { createTransactionRpc } from "../../../indexer/src/transaction-manager/rpc.mjs";
import { verifyRpcTransaction } from "../../../indexer/src/transaction-manager/receipts.mjs";
import { deterministicPrimary } from "../../src/committee.mjs";
import { authenticatePrePrepare, prePrepareDigest } from "../../src/pre-prepare.mjs";
import { authenticatePrepare, prepareDigest } from "../../src/prepare.mjs";
import { authenticateCommit, commitDigest } from "../../src/commit.mjs";
import { expectedCommitStatement, qcDigest, verifyQuorumCertificate } from "../../src/quorum-certificate.mjs";
import { authenticateNewView, authenticateViewChange } from "../../src/view-change.mjs";
import { proposalIdentity } from "../../src/prepared-certificate.mjs";
import { developmentKeys } from "./fixtures.mjs";
import { signAdversarial } from "./fault-scenarios.mjs";
import { createPeerProxy, createTransportGate } from "./fault-transport.mjs";
import { snapshotContext, encodeCertificate } from "./pbft-certificate.mjs";
import { snapshotInclusions } from "../../../indexer/test/helpers/merkle-inclusion-contract.mjs";
import { canonicalDomainMessage } from "../../../indexer/test/helpers/message-domain-contract.mjs";
import { createRelayerProcesses, verifySignedTakeoverAfterExpiry, verifyDuplicateTransportRace, verifyDestinationRpcOutage } from "../../../indexer/test/helpers/multi-relayer-integration.mjs";
import { destinationAccessPath } from "../../../indexer/test/helpers/rpc-failover-integration.mjs";
import { rpcObserver } from "./process-cluster.mjs";
import { withAutomineDisabled } from "../../../indexer/test/helpers/transaction-retry-integration.mjs";
import { verifyPostgresRestart } from "./postgres-restart-scenarios.mjs";
import { verifyMultiComponentRecovery } from "./multi-component-recovery-scenario.mjs";
import { verifyMessageQueryHTTP } from "../../../indexer/test/helpers/message-query-integration.mjs";
import { metricValue, scrapeMetrics, scrapeValue } from "../../../indexer/test/helpers/metrics-assertions.mjs";
import { withPendingDashboardProbe } from "../../../indexer/test/helpers/pending-dashboard-integration.mjs";

const artifact = name => JSON.parse(readFileSync(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
const normalizeError = value => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : value;
const quiet = { log() {}, warn() {}, error() {} };

// Extends the existing real rotation cluster after its historical/fault assertions have completed.
export async function verifyDestinationExecution({ config, pool, lifecycle, validatorSets, peers, states, environments,
  validators, processes, peerProxies, request, until, produceMessage, historical, rpcUrl, registryChecks,
  certificateChecks, merkleChecks, domainVerifierAddress }) {
  assert.equal(typeof produceMessage, "function", "fresh source authorization producer is required");
  const gateway = normalizeAddress(process.env.PRODUCTION_DESTINATION_GATEWAY_ADDRESS);
  const application = normalizeAddress(process.env.PRODUCTION_APPLICATION_B_ADDRESS);
  const chain = defineChain({ id: 2001, name: "Chain B", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } } });
  const client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0 }) });
  assert.equal(await client.getChainId(), 2001);
  const appAbi = artifact("ApplicationB").abi;
  const gatewayAbi = [...artifact("DestinationGateway").abi,
    ...["ApplicationB", "PBFTCertificateVerifier", "PBFTCertificateCodec", "DeliveryPackageCodec", "MerkleInclusionVerifier",
      "MessageMerkle", "MessageDomainVerifier", "RemoteGatewayRegistry", "ValidatorSetRegistry"]
      .flatMap(name => artifact(name).abi.filter(item => item.type === "error"))];
  const operator = privateKeyToAccount(process.env.REMOTE_REGISTRY_ADMIN_PRIVATE_KEY);
  const alternate = privateKeyToAccount(developmentKeys(6)[5]);
  const wallet = account => createWalletClient({ account, chain, transport: http(rpcUrl, { retryCount: 0 }) });
  await client.request({ method: "anvil_setBalance", params: [alternate.address, toHex(100n * 10n ** 18n)] });
  const readGateway = (functionName, args = []) => client.readContract({ address: gateway, abi: gatewayAbi, functionName, args });
  const readApp = (functionName, args = []) => client.readContract({ address: application, abi: appAbi, functionName, args });
  assert.equal(normalizeAddress(await readApp("destinationGateway")), gateway);
  assert.equal(normalizeAddress(await readGateway("CERTIFICATE_VERIFIER")), normalizeAddress(process.env.PBFT_CERTIFICATE_VERIFIER_ADDRESS));
  assert.equal(normalizeAddress(await readGateway("MERKLE_VERIFIER")), normalizeAddress(process.env.MERKLE_INCLUSION_VERIFIER_ADDRESS));
  assert.equal(normalizeAddress(await readGateway("DOMAIN_VERIFIER")), normalizeAddress(domainVerifierAddress));
  for (const [getter, key] of [["MAX_PAYLOAD_BYTES", "maxPayloadBytes"], ["MAX_BATCH_MESSAGES", "maxBatchMessages"], ["MAX_PACKAGE_BYTES", "maxPackageBytes"]]) {
    assert.equal(await readGateway(getter), BigInt(DELIVERY_POLICY[key]));
  }
  console.log(`Production DestinationGateway: ${gateway}; Production ApplicationB: ${application}; trusted Gateway: ${gateway}`);
  console.log(`Destination transport convention: execute(bytes), inner transport version 1; Max message payload bytes: ${DELIVERY_POLICY.maxPayloadBytes}; Max batch members: ${DELIVERY_POLICY.maxBatchMessages}; Max package bytes: ${DELIVERY_POLICY.maxPackageBytes}`);

  // Restore all four current members within this SAME cluster; no duplicate validator network is created.
  const active = peers.map((peer, index) => ({ peer, index })).filter(({ peer }) =>
    validatorSets.resolveForBatchEpoch(historical.at(-1).record.epoch + 1n).validators.includes(peer.address)).map(({ index }) => index);
  assert.equal(active.length, 4);
  for (const index of active) {
    await processes.stop(validators[index]);
    environments[index].PBFT_VIEW_TIMEOUT_MS = "3600000";
    validators[index] = await processes.start(environments[index]);
  }
  const chainA = createPublicClient({ transport: http(config.chainRpcUrl, { retryCount: 0 }) });
  const indexer = createIndexer({ config, pool, logger: quiet });
  const finality = createFinalityWatcher({ config, pool, logger: quiet });
  const rowsFor = async ids => (await readMessages(pool, config.databaseSchema)).filter(row => ids.includes(row.message_id));

  async function produceSourceMessage(payload, target = application, destinationWindow = 3600n) {
    const event = await produceMessage(payload, { destinationGateway: gateway, destinationReceiver: target,
      deadlineFloor: (await client.getBlock()).timestamp + destinationWindow });
    const sourceAbi = parseAbi(["function computeMessageId(address,uint256,address,address,uint256,bytes32,uint256) view returns (bytes32)"]);
    assert.equal(await chainA.readContract({ address: config.sourceGateway, abi: sourceAbi, functionName: "computeMessageId",
      args: [event.sourceSender, event.destinationDomain, event.destinationGateway, event.destinationReceiver,
        event.nonce, event.payloadHash, event.deadline] }), event.messageId);
    assert.ok(event.deadline > (await client.getBlock()).timestamp);
    return event;
  }

  async function produceAndFinalize(payload, target = application, destinationWindow = 3600n) {
    const observedBefore = await metricValue("messages_observed_total");
    const finalizedBefore = await metricValue("messages_finalized_total");
    const event = await produceSourceMessage(payload, target, destinationWindow);
    await indexer.catchUpOnce();
    let [row] = await rowsFor([event.messageId]);
    assert.equal(row.status, "OBSERVED");
    await finality.runFinalityPass();
    [row] = await rowsFor([event.messageId]);
    assert.equal(row.status, "FINALIZING");
    await chainA.request({ method: "anvil_mine", params: [toHex(config.finalityBlockDepth)] });
    await indexer.catchUpOnce();
    await finality.runFinalityPass();
    [row] = await rowsFor([event.messageId]);
    assert.equal(row.status, "FINALIZED");
    assert.equal(await metricValue("messages_observed_total"), observedBefore + 1);
    assert.equal(await metricValue("messages_finalized_total"), finalizedBefore + 1);
    await indexer.catchUpOnce(); await finality.runFinalityPass();
    assert.equal(await metricValue("messages_observed_total"), observedBefore + 1);
    assert.equal(await metricValue("messages_finalized_total"), finalizedBefore + 1);
    console.log("VALID: one fresh source occurrence increments observed once, its durable finalization increments finalized once, and duplicate ingestion adds no duplicate event");
    console.log(`VALID: fresh exact-intent credential proof and Application A → SourceGateway ${event.messageId}; Indexer OBSERVED → FINALIZING → FINALIZED`);
    return event;
  }

  async function sealFreshBatch(events) {
    const before = await metricValue("batches_created_total");
    const batchCount = async () => Number((await pool.query(`SELECT COUNT(*) AS count FROM ${tableName(config.databaseSchema, "message_batches")}`)).rows[0].count);
    const rowsBefore = await batchCount();
    const collected = await lifecycle.collectEligible();
    const created = await batchCount() - rowsBefore;
    assert.ok(created === 0 || created === 1);
    assert.equal(await metricValue("batches_created_total"), before + created);
    assert.equal(collected.assignedCount, events.length);
    const sealed = await lifecycle.sealBatch({ batchRecordId: collected.snapshot.record.batchRecordId });
    assert.deepEqual(sealed.batch.messageIds, events.map(event => event.messageId));
    await lifecycle.readBatch({ batchRecordId: sealed.record.batchRecordId });
    assert.equal(await metricValue("batches_created_total"), before + created, "seal and readback add no creation");
    if (created) console.log("VALID: one new durable batch increments batches-created once while seal/commit/re-read paths do not double count it");
    return sealed;
  }

  async function prepareFreshBatch(events) {
    const sealed = await sealFreshBatch(events);
    return lifecycle.markConsensusPending({ batchRecordId: sealed.record.batchRecordId });
  }

  async function commitPending(pending, participants) {
    const selected = validatorSets.resolveForBatchEpoch(pending.record.epoch);
    assert.equal(pending.consensusBinding.validatorEpoch, selected.validatorEpoch);
    assert.equal(pending.consensusBinding.committeeDigest, selected.committeeDigest);
    assert.ok(participants.length >= 3 && participants.length <= 4);
    assert.equal(new Set(participants).size, participants.length);
    assert.ok(participants.every(index => selected.validators.includes(peers[index].address)));
    const primary = peers.findIndex(peer => peer.address === deterministicPrimary(selected.validators, pending.record.epoch));
    assert.ok(participants.includes(primary));
    assert.equal((await request(primary, "/pbft/propose", { batchId: pending.record.batchId })).status, 200);
    for (const index of participants) assert.equal((await request(index, "/pbft/prepare/cast", { epoch: pending.record.epoch.toString() })).status, 200);
    return commitPrepared(pending, participants);
  }

  async function commitPrepared(pending, participants) {
    for (const index of participants.slice(0, 3)) assert.equal((await request(index, "/pbft/commit/cast", { epoch: pending.record.epoch.toString() })).status, 200);
    const qc = (await request(participants[0], "/pbft/qc", { epoch: pending.record.epoch.toString() })).body.certificate;
    assert.ok(qc);
    assert.equal((await request(participants[0], "/pbft/qc/submit", qc)).status, 200);
    const committed = await until("fresh business batch COMMITTED", async () => {
      const value = await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId });
      return value.record.status === "COMMITTED" ? value : null;
    }, participants);
    await registryChecks.assertQcBinding(committed.quorumCertificate);
    console.log(`VALID: bounded canonical batch ${committed.record.batchId}; Message Root ${committed.record.messageRoot}; validator epoch ${committed.consensusBinding.validatorEpoch}; real PBFT QC → COMMITTED`);
    return committed;
  }

  async function commitFresh(events) {
    const node = active[0];
    const before = scrapeValue(await scrapeMetrics(peers[node].url), "cross_chain_pbft_round_duration_seconds_count", { outcome: "committed" });
    const pending = await prepareFreshBatch(events);
    const batchCount = await metricValue("batches_created_total");
    const committed = await commitPending(pending, active);
    assert.equal(await metricValue("batches_created_total"), batchCount, "consensus commit is no batch creation");
    assert.ok((await states[node].store.readCommitState(committed.record.epoch)).quorum);
    const after = scrapeValue(await scrapeMetrics(peers[node].url), "cross_chain_pbft_round_duration_seconds_count", { outcome: "committed" });
    assert.equal(after, before + 1, "the real local QC records one sample, not one per replicated vote");
    console.log("VALID: a real PBFT round records one bounded round-duration observation for the exact production consensus lifecycle");
    return committed;
  }

  const vectors = JSON.parse(readFileSync(new URL("../../../test-vectors/application-b-commands.json", import.meta.url), "utf8"));
  const command = vectors.vectors[0];
  const supplier = normalizeAddress(command.supplier);
  const payload = command.expectedPayload;
  const privateFixture = JSON.parse(readFileSync(new URL("../../../zk/credential-model/fixtures/active-secondary.json", import.meta.url), "utf8"));
  assert.notEqual(supplier, privateFixture.subject, "typed private subject does not establish supplier ownership");
  for (const identity of [gateway, application, operator.address, alternate.address,
    privateKeyToAccount(process.env.INDEXER_INTEGRATION_PRIVATE_KEY).address,
    privateKeyToAccount(process.env.RELAYER_A_PRIVATE_KEY).address, ...peers.map(peer => peer.address)]) {
    assert.notEqual(supplier, identity.toLowerCase());
  }
  assert.equal(await readApp("isVerifiedSupplier", [supplier]), false);
  const first = await produceAndFinalize(payload);
  const redundant = await produceAndFinalize(payload);
  assert.notEqual(first.messageId, redundant.messageId);
  const snapshot = await commitFresh([first, redundant]);
  const deliveryConfig = { ...config, validatorSets };
  const projector = createDeliveryProjector({ config: deliveryConfig, pool });
  const materialized = await projector.materializeBatch({ batchRecordId: snapshot.record.batchRecordId });
  assert.equal(materialized.createdJobs, 2);
  const queue = createDeliveryRepository({ config: deliveryConfig, pool });
  const packages = await buildDeliveryPackages(snapshot, { validatorSets });
  const [successPack, failurePack] = packages;
  for (const pack of packages) {
    assert.equal((await queue.getDeliveryJob(pack.deliveryJobId)).status, "READY");
    assert.deepEqual(await queue.getDeliveryPackage(pack.deliveryJobId), pack);
    console.log(`VALID: immutable READY portable package ${pack.deliveryJobId}; message ${pack.message.messageId}; supplier ${supplier}`);
  }
  const relayConfig = loadTransactionConfig({ ...process.env, DATABASE_URL: config.databaseUrl, INDEXER_DB_SCHEMA: config.databaseSchema,
    CHAIN_A_DOMAIN: config.chainDomain.toString(), SOURCE_GATEWAY_ADDRESS: config.sourceGateway,
    CHAIN_B_RPC_URL: rpcUrl, CHAIN_B_RPC_URLS: JSON.stringify([rpcUrl]), CHAIN_B_GENESIS_HASH: (await client.getBlock({ blockNumber: 0n })).hash,
    VALIDATOR_SET_HISTORY_FILE: "", VALIDATOR_SET_HISTORY: JSON.stringify(validatorSets.history), RELAYER_WORKER_ID: "relayer-a" });
  const manager = createTransactionManager({ config: relayConfig, pool, queue });
  const worker = createRelayerWorker({ config: relayConfig, pool, queue, transactionManager: manager });
  // Both estimates execute while S is unverified. G is a legitimate pre-signed transaction whose
  // later business revert is observed by the ordinary manager, without overriding its gas RPC.
  const prepared = [];
  const attemptsBefore = await metricValue("delivery_attempts_total");
  for (const pack of packages) prepared.push(await manager.prepareDeliveryTransaction(pack.deliveryJobId));
  assert.equal(await metricValue("delivery_attempts_total"), attemptsBefore + packages.length);
  for (const pack of packages) await manager.repository.getTransaction(pack.deliveryJobId);
  assert.equal(await metricValue("delivery_attempts_total"), attemptsBefore + packages.length);
  console.log("VALID: durable transaction candidate creation increments delivery attempts while receipt polling and read-only recovery do not fabricate attempts");
  assert.equal(await readGateway("isMessageExecuted", [first.messageId]), false);
  assert.equal(await readGateway("isMessageExecuted", [redundant.messageId]), false);
  assert.equal(await readApp("isVerifiedSupplier", [supplier]), false);
  await worker.submitJob(successPack.deliveryJobId);
  const receipt = await client.waitForTransactionReceipt({ hash: prepared[0].attempt.transactionHash });
  assert.equal(receipt.status, "success");
  const encoding = await encodeGatewaySubmission(successPack, { validatorSets });
  const tx = await client.getTransaction({ hash: receipt.transactionHash });
  assert.equal(tx.to.toLowerCase(), gateway);
  assert.equal(tx.value, 0n);
  assert.equal(tx.input, encoding.calldata);
  assert.equal(decodeFunctionData({ abi: DESTINATION_GATEWAY_ABI, data: tx.input }).args[0], encoding.data);
  assert.equal(prepared[0].intent.packageDigest, encoding.packageDigest);
  assert.equal(await readGateway("isMessageExecuted", [first.messageId]), true);
  assert.equal(await readApp("isVerifiedSupplier", [supplier]), true);
  const gatewayEvents = receipt.logs.filter(log => log.address.toLowerCase() === gateway).map(log => decodeEventLog({ abi: gatewayAbi, ...log }));
  const appEvents = receipt.logs.filter(log => log.address.toLowerCase() === application).map(log => decodeEventLog({ abi: appAbi, ...log }));
  assert.equal(gatewayEvents.length, 1); assert.equal(appEvents.length, 1);
  assert.equal(gatewayEvents[0].eventName, "CrossChainMessageExecuted");
  assert.equal(gatewayEvents[0].args.messageId, first.messageId);
  assert.equal(gatewayEvents[0].args.sourceDomain, config.chainDomain);
  assert.equal(gatewayEvents[0].args.destinationReceiver.toLowerCase(), application);
  assert.equal(gatewayEvents[0].args.batchId, snapshot.record.batchId);
  assert.equal(appEvents[0].eventName, "VerifiedSupplierGranted");
  assert.equal(appEvents[0].args.messageId, first.messageId);
  assert.equal(appEvents[0].args.supplier.toLowerCase(), supplier);
  console.log(`VALID: real Relayer/Tx Manager signed type-2 Gateway transaction ${receipt.transactionHash}; nonce ${prepared[0].intent.nonce}; to=${gateway}; value=0; exact execute(bytes) wrapper/inner v1 parity`);
  console.log(`VALID: PBFT → Merkle → message domain → replay false → true → ApplicationB VERIFIED_SUPPLIER false → true; both exact events in the same transaction ${receipt.transactionHash}`);

  const block = await client.getBlock();
  // Controlled negative transactions use half of the actual local block budget, never a production gas override.
  const testGas = block.gasLimit / 2n;
  const call = bytes => ({ address: gateway, abi: gatewayAbi, functionName: "execute", args: [bytes] });
  async function expectError(parameters, account, name, args) {
    await assert.rejects(() => client.simulateContract({ ...parameters, account }), error => {
      for (let cause = error; cause; cause = cause.cause) {
        if (cause.data?.errorName === name) {
          if (args) assert.deepEqual((cause.data.args ?? []).map(normalizeError), args.map(normalizeError));
          return true;
        }
      }
      return false;
    }, name);
  }
  async function reject(bytes, messageId, name, args, account = operator) {
    const before = await readGateway("isMessageExecuted", [messageId]);
    await expectError(call(bytes), account, name, args);
    const hash = await wallet(account).writeContract({ ...call(bytes), gas: testGas });
    const reverted = await client.waitForTransactionReceipt({ hash });
    assert.equal(reverted.status, "reverted"); assert.equal(reverted.logs.length, 0);
    assert.equal(await readGateway("isMessageExecuted", [messageId]), before);
    assert.equal(await readApp("isVerifiedSupplier", [supplier]), true);
    console.log(`EXPECTED FAILURE: production Gateway ${name}; actual reverted receipt ${hash}; replay/business state unchanged`);
  }
  async function authenticate(pack, committed) {
    const context = snapshotContext(committed);
    await certificateChecks.accept(encodeCertificate(committed.quorumCertificate), context, "production Gateway upstream QC remains valid");
    const inclusion = snapshotInclusions(committed, context)[pack.messageIndex];
    await merkleChecks.accept(inclusion, "production Gateway upstream membership remains valid");
    const [message, rawPayload] = canonicalDomainMessage(pack.message);
    assert.equal(await client.readContract({ address: domainVerifierAddress, abi: artifact("MessageDomainVerifier").abi,
      functionName: "verifyMessage", args: [message, rawPayload, pack.message.messageId, gateway] }), true);
    return context;
  }
  await authenticate(successPack, snapshot);
  await reject(encoding.data, first.messageId, "MessageAlreadyExecuted", [first.messageId]);
  await reject(encoding.data, first.messageId, "MessageAlreadyExecuted", [first.messageId], alternate);
  await authenticate(failurePack, snapshot);
  const failureEncoding = await encodeGatewaySubmission(failurePack, { validatorSets });
  await expectError(call(failureEncoding.data), operator, "AlreadyVerifiedSupplier", [supplier]);
  await worker.submitJob(failurePack.deliveryJobId);
  const failedReceipt = await client.waitForTransactionReceipt({ hash: prepared[1].attempt.transactionHash });
  assert.equal(failedReceipt.status, "reverted"); assert.equal(failedReceipt.logs.length, 0);
  assert.equal(await readGateway("isMessageExecuted", [redundant.messageId]), false);
  assert.equal(await readApp("isVerifiedSupplier", [supplier]), true);
  console.log(`EXPECTED FAILURE: different authenticated message ${redundant.messageId} reached ApplicationB AlreadyVerifiedSupplier; actual Tx Manager transaction REVERTED; replay remains false`);
  await client.request({ method: "anvil_mine", params: [toHex(relayConfig.destinationConfirmations)] });
  await withPendingDashboardProbe({ config, pool, resolvedCount: 2, validatorOrigins: active.map(index => peers[index].url), captureDestination: async () => ({
    first: await readGateway("isMessageExecuted", [first.messageId]),
    redundant: await readGateway("isMessageExecuted", [redundant.messageId]),
    supplier: await readApp("isVerifiedSupplier", [supplier]),
  }) }, async () => {
    const executionFailures = await metricValue("destination_execution_failures_total");
    const latencyCount = await metricValue("cross_chain_latency_seconds", { part: "_count" });
    const latencySum = await metricValue("cross_chain_latency_seconds", { part: "_sum" });
    await manager.checkReceiptsOnce();
    assert.equal((await manager.repository.getTransaction(successPack.deliveryJobId)).intent.status, "CONFIRMED");
    assert.equal((await manager.repository.getTransaction(failurePack.deliveryJobId)).intent.status, "REVERTED");
    assert.equal(await metricValue("destination_execution_failures_total"), executionFailures + 1);
    assert.equal(await metricValue("cross_chain_latency_seconds", { part: "_count" }), latencyCount + 1);
    const successObservation = (await manager.repository.getTransaction(successPack.deliveryJobId)).winningAttempt;
    const [sourceObservation] = await rowsFor([first.messageId]);
    const durationMs = Date.parse(successObservation.confirmedAt) - sourceObservation.observed_at.getTime();
    assert.ok(durationMs >= 0);
    assert.equal(Math.round(((await metricValue("cross_chain_latency_seconds", { part: "_sum" })) - latencySum) * 1000), durationMs,
      "the fresh latency sample must use the real persisted source and canonical confirmation timestamps");
    await manager.checkReceiptsOnce();
    assert.equal(await metricValue("destination_execution_failures_total"), executionFailures + 1);
    assert.equal(await metricValue("cross_chain_latency_seconds", { part: "_count" }), latencyCount + 1);
    console.log("VALID: one fresh successful production message records cross-chain latency from durable source observation to canonical destination execution confirmation");
    console.log("VALID: a real canonical destination REVERTED outcome increments destination execution failures while preparation defer and RPC failure do not");
  });
  const evidence = async () => ({
    intents: (await pool.query(`SELECT * FROM ${tableName(config.databaseSchema, "transaction_intents")} ORDER BY delivery_job_id`)).rows,
    attempts: (await pool.query(`SELECT * FROM ${tableName(config.databaseSchema, "transaction_attempts")} ORDER BY attempt_id`)).rows,
    account: await manager.repository.getAccount(),
    nonce: await client.getTransactionCount({ address: relayConfig.relayerAddress, blockTag: "pending" }),
  });
  const beforeRerun = await evidence();
  const recovered = createTransactionManager({ config: relayConfig, pool, queue });
  await recovered.recoverTransactionsOnce();
  const rerun = await createRelayerWorker({ config: relayConfig, pool, queue, transactionManager: recovered }).runOnce();
  assert.equal(rerun.selected, 0); assert.equal(rerun.submitted, 0);
  assert.deepEqual(await evidence(), beforeRerun);
  assert.equal(await readApp("isVerifiedSupplier", [supplier]), true);
  console.log("VALID: fresh normal Relayer/Tx Manager recovery selected no final jobs; no new intent, nonce, signature or duplicate business transition; deterministic REVERTED stayed final");

  const rawFailure = (await encodeDestinationSubmission(failurePack, { validatorSets })).data;
  function mutatedEnvelope(change) {
    const envelope = [...decodeAbiParameters(ENVELOPE_PARAMETERS, rawFailure)];
    change(envelope);
    return encodeAbiParameters(ENVELOPE_PARAMETERS, envelope);
  }
  function mutatedMessage(position, value) {
    return mutatedEnvelope(envelope => {
      const message = [...decodeAbiParameters(MESSAGE_PARAMETERS, envelope[3])];
      message[position] = value; envelope[3] = encodeAbiParameters(MESSAGE_PARAMETERS, message);
    });
  }
  await reject(mutatedEnvelope(envelope => {
    const qc = [...decodeAbiParameters(QC_PARAMETERS, envelope[9])]; qc[2] = `0x${"01".repeat(32)}`;
    envelope[9] = encodeAbiParameters(QC_PARAMETERS, qc);
  }), redundant.messageId, "QuorumCertificateDigestMismatch", []);
  const zeroSibling = `0x${"00".repeat(32)}`;
  const wrongPathRoot = computeMessageMerkleNode(zeroSibling, computeMessageMerkleLeaf({
    batchId: failurePack.batchId, index: failurePack.messageIndex, messageId: redundant.messageId }));
  await reject(mutatedEnvelope(envelope => { envelope[8] = [zeroSibling]; }), redundant.messageId, "MerkleRootMismatch", [failurePack.messageRoot, wrongPathRoot]);
  await reject(mutatedMessage(4, 3001n), redundant.messageId, "InvalidDestinationDomain", [2001n, 3001n]);
  await reject(mutatedMessage(5, alternate.address), redundant.messageId, "DestinationGatewayMismatch", [gateway, alternate.address]);
  const rehashed = computeCanonicalMessageId({ ...failurePack.message, destinationReceiver: alternate.address });
  await reject(mutatedMessage(6, alternate.address), redundant.messageId, "MessageIdMismatch", [redundant.messageId, rehashed]);
  await reject(mutatedEnvelope(envelope => {
    const message = [...decodeAbiParameters(MESSAGE_PARAMETERS, envelope[3])];
    message[6] = alternate.address; message[11] = rehashed;
    envelope[3] = encodeAbiParameters(MESSAGE_PARAMETERS, message);
  }), rehashed, "MemberMessageIdMismatch", [BigInt(failurePack.messageIndex), rehashed, redundant.messageId]);
  await reject(mutatedMessage(8, "0x01"), redundant.messageId, "PayloadHashMismatch", [failurePack.message.payloadHash, computePayloadHash("0x01")]);
  await reject(mutatedEnvelope(envelope => { envelope[1] = 2; }), redundant.messageId, "UnsupportedTransportVersion", [2]);
  await reject(`${rawFailure}00`, redundant.messageId, "InvalidPackageEncoding", []);
  await reject(`0x${"00".repeat(DELIVERY_POLICY.maxPackageBytes + 1)}`, redundant.messageId, "PackageLimitExceeded",
    [BigInt(DELIVERY_POLICY.maxPackageBytes + 1), BigInt(DELIVERY_POLICY.maxPackageBytes)]);
  const [oldPackage] = await buildDeliveryPackages(historical[0], { validatorSets });
  const oldContext = snapshotContext(historical[0]);
  await certificateChecks.accept(encodeCertificate(historical[0].quorumCertificate), oldContext, "authentic historical different-Gateway QC");
  await merkleChecks.accept(snapshotInclusions(historical[0], oldContext)[0], "authentic historical different-Gateway membership");
  const [oldMessage, oldPayload] = canonicalDomainMessage(oldPackage.message);
  assert.equal(await client.readContract({ address: domainVerifierAddress, abi: artifact("MessageDomainVerifier").abi,
    functionName: "verifyMessage", args: [oldMessage, oldPayload, oldPackage.message.messageId, oldPackage.message.destinationGateway] }), true);
  await reject((await encodeGatewaySubmission(oldPackage, { validatorSets })).data, oldPackage.message.messageId,
    "DestinationGatewayMismatch", [gateway, oldPackage.message.destinationGateway]);
  const remoteAbi = artifact("RemoteGatewayRegistry").abi;
  const remoteAddress = normalizeAddress(process.env.REMOTE_GATEWAY_REGISTRY_ADDRESS);
  const temporary = await client.request({ method: "evm_snapshot" });
  try {
    let hash = await wallet(operator).writeContract({ address: remoteAddress, abi: remoteAbi, functionName: "setRemoteGateway",
      args: [config.chainDomain, alternate.address] });
    assert.equal((await client.waitForTransactionReceipt({ hash })).status, "success");
    await reject(rawFailure, redundant.messageId, "UntrustedRemoteGateway", [config.chainDomain, config.sourceGateway, alternate.address]);
  } finally { assert.equal(await client.request({ method: "evm_revert", params: [temporary] }), true); }

  // A separately authenticated EOA-targeted source message reaches the final executable-receiver policy.
  const eoaEvent = await produceAndFinalize(payload, alternate.address.toLowerCase());
  const eoaSnapshot = await commitFresh([eoaEvent]);
  const [eoaPack] = await buildDeliveryPackages(eoaSnapshot, { validatorSets });
  await authenticate(eoaPack, eoaSnapshot);
  await reject((await encodeGatewaySubmission(eoaPack, { validatorSets })).data, eoaEvent.messageId,
    "InvalidDestinationReceiver", [alternate.address]);
  // Authentic expiry is isolated from durable transport history and restored afterwards.
  const timeSnapshot = await client.request({ method: "evm_snapshot" });
  try {
    const deadline = BigInt(failurePack.message.deadline);
    await client.request({ method: "evm_setNextBlockTimestamp", params: [toHex(deadline)] });
    await client.request({ method: "evm_mine" });
    const context = snapshotContext(snapshot);
    await certificateChecks.accept(encodeCertificate(snapshot.quorumCertificate), context, "expired business QC still valid");
    await merkleChecks.accept(snapshotInclusions(snapshot, context)[failurePack.messageIndex], "expired business membership still valid");
    await reject(rawFailure, redundant.messageId, "MessageExpired", [deadline, (await client.getBlock()).timestamp]);
  } finally { assert.equal(await client.request({ method: "evm_revert", params: [timeSnapshot] }), true); }
  for (const old of historical) assert.deepEqual(await lifecycle.readBatch({ batchRecordId: old.record.batchRecordId }), old);
  assert.equal(await readGateway("isMessageExecuted", [first.messageId]), true);
  assert.equal(await readGateway("isMessageExecuted", [redundant.messageId]), false);
  assert.equal(await readApp("isVerifiedSupplier", [supplier]), true);
  // Unlike the retained pre-signed redundant transaction above, this message
  // has NEVER been prepared before the first supplier grant took effect.
  const lateRedundant = await produceAndFinalize(payload);
  const independent = vectors.vectors[1];
  const independentSupplier = normalizeAddress(independent.supplier);
  assert.equal(await readApp("isVerifiedSupplier", [independentSupplier]), false);
  const following = await produceAndFinalize(independent.expectedPayload);
  const preparationSnapshot = await commitFresh([lateRedundant, following]);
  await projector.materializeBatch({ batchRecordId: preparationSnapshot.record.batchRecordId });
  const [deferPack, followingPack] = await buildDeliveryPackages(preparationSnapshot, { validatorSets });
  await authenticate(deferPack, preparationSnapshot);
  await expectError(call((await encodeGatewaySubmission(deferPack, { validatorSets })).data), operator,
    "AlreadyVerifiedSupplier", [supplier]);
  const limited = { ...relayConfig, maxJobs: 1 };
  const liveRpc = createTransactionRpc(limited);
  const activity = { estimates: 0, fees: 0, nonces: 0, signatures: 0, sends: 0 };
  const account = privateKeyToAccount(limited.privateKey);
  const liveManager = () => createTransactionManager({ config: limited, pool, queue,
    account: { ...account, async signTransaction(...args) { activity.signatures++; return account.signTransaction(...args); } },
    rpc: { ...liveRpc,
      async estimateGas(...args) { activity.estimates++; return liveRpc.estimateGas(...args); },
      async fees(...args) { activity.fees++; return liveRpc.fees(...args); },
      async pendingNonce(...args) { activity.nonces++; return liveRpc.pendingNonce(...args); },
      async broadcast(...args) { activity.sends++; return liveRpc.broadcast(...args); },
    } });
  const beforeDefer = await evidence();
  const journals = tableName(config.databaseSchema, "transaction_broadcast_events");
  const beforeJournal = (await pool.query(`SELECT * FROM ${journals} ORDER BY event_id`)).rows;
  assert.equal(await manager.repository.getTransaction(deferPack.deliveryJobId), null);
  const deferredPass = await createRelayerWorker({ config: limited, pool, queue, transactionManager: liveManager() }).runOnce();
  assert.equal(deferredPass.selected, 1); assert.equal(deferredPass.deferred, 1); assert.equal(deferredPass.submitted, 0);
  const deferred = deferredPass.results[0];
  assert.equal(deferred.deliveryJobId, deferPack.deliveryJobId); assert.equal(deferred.action, "PREPARATION_DEFERRED");
  assert.equal(deferred.reason, "ESTIMATE_EXECUTION_REVERT");
  for (const key of ["intent", "attempt", "nonce", "transactionHash", "receipt"]) assert.equal(key in deferred, false);
  assert.deepEqual(activity, { estimates: 1, fees: 0, nonces: 0, signatures: 0, sends: 0 });
  assert.deepEqual(await evidence(), beforeDefer);
  assert.deepEqual((await pool.query(`SELECT * FROM ${journals} ORDER BY event_id`)).rows, beforeJournal);
  const schedule = await createRelayerLeaseRepository({ config: limited, pool, queue }).getLease(deferPack.deliveryJobId);
  assert.equal(schedule.preparationRetryAt, deferred.retryAt); assert.notEqual(schedule.releasedAt, null);
  assert.equal((await queue.getDeliveryJob(deferPack.deliveryJobId)).status, "READY");
  assert.equal(await readGateway("isMessageExecuted", [lateRedundant.messageId]), false);
  assert.equal(await readApp("isVerifiedSupplier", [supplier]), true);
  console.log(`VALID: real eth_estimateGas AlreadyVerifiedSupplier classified as PREPARATION_DEFERRED for ${deferPack.deliveryJobId}; bounded reason ${deferred.reason}; retry ${deferred.retryAt}`);
  console.log("VALID: preparation defer created zero intent, zero nonce allocation, zero signed attempt/signature, zero broadcast/journal/receipt; READY, replay and ApplicationB state unchanged");
  let progressed;
  for (let round = 0; round < 2 && !progressed; round++) {
    const pass = await createRelayerWorker({ config: limited, pool, queue, transactionManager: liveManager() }).runOnce();
    progressed = pass.results.find(result => result.submitted);
  }
  assert.ok(progressed, "following ordinary job must obtain a slot within two selection rounds even if the defer already became due");
  assert.equal(progressed.intent.deliveryJobId, followingPack.deliveryJobId);
  const followingReceipt = await client.waitForTransactionReceipt({ hash: progressed.attempt.transactionHash });
  assert.equal(followingReceipt.status, "success");
  assert.equal(await readGateway("isMessageExecuted", [following.messageId]), true);
  assert.equal(await readApp("isVerifiedSupplier", [independentSupplier]), true);
  assert.equal(await readGateway("isMessageExecuted", [lateRedundant.messageId]), false);
  assert.equal(await manager.repository.getTransaction(deferPack.deliveryJobId), null);
  assert.equal(activity.signatures, 1); assert.equal(activity.sends, 1);
  await client.request({ method: "anvil_mine", params: [toHex(limited.destinationConfirmations)] });
  await manager.checkReceiptsOnce();
  assert.equal((await manager.repository.getTransaction(followingPack.deliveryJobId)).intent.status, "CONFIRMED");
  assert.equal((await manager.repository.getTransaction(failurePack.deliveryJobId)).intent.status, "REVERTED");
  for (const old of historical) assert.deepEqual(await lifecycle.readBatch({ batchRecordId: old.record.batchRecordId }), old);
  console.log("VALID: following fresh READY job progressed through the real Relayer/Gateway/ApplicationB within the two-group bound; earlier actual mined REVERTED remained final; deferred message has no transaction outcome");
  await verifySourceReorgRecovery();
  await verifyValidatorFailureRecovery();
  await verifyByzantineSafety();
  await verifyRelayerFailure();
  await verifyDuplicateDelivery();
  await verifyDestinationRpcRecovery();
  await verifyDestinationTransactionReorg();
  await verifyPrimaryFailure();
  // Observe existing real data before the owned-database scenarios clean up.
  // No extra message, chain, validator world or fault is created for the API.
  const querySuccess = (await pool.query(`SELECT s.message_id FROM ${tableName(config.databaseSchema, "source_messages")} s
    JOIN ${tableName(config.databaseSchema, "delivery_jobs")} j ON j.source_message_id = s.id
    JOIN ${tableName(config.databaseSchema, "transaction_intents")} i USING (delivery_job_id)
    WHERE s.status = 'FINALIZED' AND s.destination_gateway = $1 AND i.status = 'CONFIRMED' ORDER BY s.id DESC LIMIT 1`, [gateway])).rows[0];
  const queryOrphan = (await pool.query(`SELECT message_id FROM ${tableName(config.databaseSchema, "source_messages")}
    WHERE status = 'REORGED' ORDER BY id DESC LIMIT 1`)).rows[0];
  const queryReplacement = (await pool.query(`SELECT j.message_id FROM ${tableName(config.databaseSchema, "delivery_jobs")} j
    JOIN ${tableName(config.databaseSchema, "transaction_attempts")} a USING (delivery_job_id)
    WHERE a.replacement_of_attempt_id IS NOT NULL ORDER BY a.attempt_id DESC LIMIT 1`)).rows[0];
  assert.ok(querySuccess && queryOrphan && queryReplacement, "existing E2E must supply real successful, reorged and replacement-history API cases");
  await verifyMessageQueryHTTP({ config: { ...config, validatorSets, destinationConfirmations: relayConfig.destinationConfirmations }, pool, states, records: validators,
    messageIds: [...new Set([querySuccess.message_id, queryOrphan.message_id, queryReplacement.message_id,
      ...historical.map(snapshot => snapshot.batch.messageIds[0])])], productionGateway: gateway,
    destinationCheck: async () => ({ executed: await readGateway("isMessageExecuted", [querySuccess.message_id]),
      nonce: await client.request({ method: "eth_getTransactionCount", params: [relayConfig.relayerAddress, "pending"] }) }),
    label: "complete lifecycle, real orphan, replacement and historical committees" });
  await verifyPostgresRestart({ config, pool, validatorSets, produceMessage, client, chainA, gateway, application,
    gatewayAbi, appAbi, rpcUrl, registryChecks, certificateChecks, afterVerification: verifyMultiComponentRecovery });
  console.log("COMPLETE END-TO-END EXECUTION EVIDENCE RECORDED: fresh ZK intent → source event → real finality/batch/PBFT/READY → production Relayer/Tx Manager → atomic Gateway/ApplicationB; duplicate rejection and business rollback; historical snapshots unchanged");

  async function verifyDestinationTransactionReorg() {
    console.log("\n[Destination Transaction Reorg Recovery]");
    const epoch = BigInt((await pool.query(`SELECT MAX(epoch)::text AS epoch FROM ${tableName(config.databaseSchema,"message_batches")}`)).rows[0].epoch);
    const supplier = toHex(0x9000000000000000000000000000000000000000n + epoch,{ size: 20 });
    assert.equal(await readApp("isVerifiedSupplier",[supplier]),false);
    const pids = active.map(index => validators[index].child.pid);
    for (const index of active) assert.equal((await request(index,"/health")).body.ready,true);
    const event = await produceAndFinalize(encodeAbiParameters([{ type: "uint8" },{ type: "uint8" },{ type: "address" }],[1,1,supplier]),
      application,relayConfig.destinationConfirmations * 3n + 3600n);
    const committed = await commitFresh([event]);
    await certificateChecks.snapshot(committed,"healthy pinned committee committed the destination-reorg message");
    assert.equal((await projector.materializeBatch({ batchRecordId: committed.record.batchRecordId })).createdJobs,1);
    const [pack] = await buildDeliveryPackages(committed,{ validatorSets }); const id = pack.deliveryJobId;
    await authenticate(pack,committed);
    const entry = await queue.getDeliveryEntries([id]);
    const source = { rows: await readMessages(pool,config.databaseSchema),blocks: await readIndexedSourceBlocks(pool,config.databaseSchema,config),
      cursor: await readCursor(pool,config.databaseSchema,config) };
    const intents = tableName(config.databaseSchema,"transaction_intents");
    const previousIntents = (await pool.query(`SELECT * FROM ${intents} WHERE status <> 'PENDING' ORDER BY delivery_job_id`)).rows;
    console.log(`VALID: fresh exact-intent proof reached source FINALIZED, real PBFT/QC COMMITTED and canonical READY ${id}; message ${event.messageId}; supplier ${supplier}`);
    let observed; let freshPool; let failure;
    try {
      const accepted = [];
      observed = await rpcObserver(rpcUrl,{
        async beforeForward(message) {
          if (message.method !== "eth_sendRawTransaction" || accepted.length !== 1) return;
          assert.equal(await readGateway("isMessageExecuted",[event.messageId]),false,
            "exact-message replay must still be false at the actual recovery wire boundary");
          const held = (await pool.query(`SELECT owner_id,lease_expires_at > clock_timestamp() AND released_at IS NULL AS held
            FROM ${tableName(config.databaseSchema,"relayer_job_leases")} WHERE delivery_job_id = $1`,[id])).rows[0];
          assert.equal(held.owner_id,cfg.workerId); assert.equal(held.held,true);
          const stored = await initialManager.repository.getTransaction(id);
          assert.equal(stored.intent.status,"PENDING"); assert.ok(stored.intent.reorgRecovery);
          assert.ok(stored.attempt.rawSignedTransaction === message.params[0],"recovery must forward the exact durable candidate");
          console.log("VALID: Gateway exact-message replay remained false and the Relayer fence remained live at the actual recovery send boundary");
        },
        async afterForward(message,reply) {
          if (message.method === "eth_sendRawTransaction") {
            assert.ok(reply && !reply.error,"reorg scenario requires actual accepted destination broadcasts"); accepted.push(reply.result);
          }
        },
      });
      const cfg = { ...relayConfig,maxJobs: 1,destinationRpcUrl: observed.url,destinationRpcUrls: Object.freeze([observed.url]) };
      let destinationSnapshot; let reorgEvidence; let signatures = 0;
      const initialManager = createTransactionManager({ config: cfg,pool,queue,
        async beforeSignedCommit({ intent }) { if (intent.deliveryJobId === id) signatures++; },
        hooks: {
          async afterBroadcastStart(value) {
            if (value.id !== id || destinationSnapshot !== undefined) return;
            destinationSnapshot = await client.request({ method: "evm_snapshot",params: [] });
            console.log("VALID: destination control snapshot was taken after durable signing and before the target transaction's external broadcast/inclusion");
          },
          async afterDestinationReorg(value) { if (value.id === id) reorgEvidence = value; },
        } });
      const initialWorker = createRelayerWorker({ config: cfg,pool,queue,transactionManager: initialManager });
      const rounds = previousIntents.length + 8;
      await withAutomineDisabled(client,async () => {
        let broadcast;
        for (let round = 0; round < rounds; round++) {
          await initialWorker.runOnce(); broadcast = await initialManager.repository.getTransaction(id);
          if (broadcast?.attempt.status === "BROADCAST") break;
        }
        assert.equal(broadcast?.attempt.status,"BROADCAST","normal bounded Relayer selection must send the fresh READY job");
        assert.notEqual(destinationSnapshot,undefined); assert.equal(signatures,1);
        await client.request({ method: "anvil_mine",params: [toHex(cfg.destinationConfirmations)] });
        await initialManager.checkReceiptsOnce();
        const original = await initialManager.repository.getTransaction(id);
        assert.equal(original.intent.status,"CONFIRMED"); assert.equal(original.winningAttempt.attemptId,original.attempt.attemptId);
        const oldReceipt = await client.request({ method: "eth_getTransactionReceipt",params: [original.attempt.transactionHash] });
        assert.equal(BigInt(oldReceipt.status),1n);
        for (const [address,abi,name] of [[gateway,gatewayAbi,"CrossChainMessageExecuted"],[application,appAbi,"VerifiedSupplierGranted"]]) {
          const logs = oldReceipt.logs.filter(log => log.address.toLowerCase() === address).map(log => decodeEventLog({ abi,...log }));
          assert.equal(logs.length,1); assert.equal(logs[0].eventName,name); assert.equal(logs[0].args.messageId,event.messageId);
        }
        const oldBlock = await client.request({ method: "eth_getBlockByNumber",params: [oldReceipt.blockNumber,false] });
        assert.equal(oldBlock.hash,original.attempt.receiptBlockHash);
        assert.ok(BigInt(original.attempt.confirmedHead) - BigInt(oldReceipt.blockNumber) + 1n >= cfg.destinationConfirmations);
        assert.equal(await readGateway("isMessageExecuted",[event.messageId]),true);
        assert.equal(await readApp("isVerifiedSupplier",[supplier]),true);
        const history = await initialManager.repository.getReceiptObservations(id); assert.equal(history.length,1);
        const account = await initialManager.repository.getAccount();
        const journal = await initialManager.repository.getBroadcastEvents(id);
        const preparation = () => observed.calls.filter(call => call.method === "eth_maxPriorityFeePerGas" ||
          (call.method === "eth_estimateGas" && call.params[0].data === original.intent.calldata)).length;
        const beforePreparation = preparation();
        console.log(`VALID: transaction ${original.attempt.transactionHash} reached canonical CONFIRMED at ${oldReceipt.blockNumber}/${oldReceipt.blockHash}; Gateway and ApplicationB executed the fresh message`);

        assert.equal(await client.request({ method: "evm_revert",params: [destinationSnapshot] }),true);
        // A reverted local node may return the displaced transaction to its
        // mempool. Remove only this scenario's known hash before mining the
        // empty replacement branch; production recovery must provide its send.
        const returned = await client.request({ method: "eth_getTransactionByHash",params: [original.attempt.transactionHash] });
        if (returned !== null) {
          assert.equal(returned.blockNumber,null);
          await client.request({ method: "anvil_dropTransaction",params: [original.attempt.transactionHash] });
        }
        await client.request({ method: "evm_setNextBlockTimestamp",params: [toHex(BigInt(oldBlock.timestamp) + 7n)] });
        await client.request({ method: "anvil_mine",params: [toHex(cfg.destinationConfirmations + 1n)] });
        const replacement = await client.request({ method: "eth_getBlockByNumber",params: [oldReceipt.blockNumber,false] });
        assert.notEqual(replacement.hash,oldReceipt.blockHash);
        assert.equal(await client.request({ method: "eth_getTransactionReceipt",params: [original.attempt.transactionHash] }),null);
        assert.equal(await readGateway("isMessageExecuted",[event.messageId]),false);
        assert.equal(await readApp("isVerifiedSupplier",[supplier]),false);
        assert.equal((await initialManager.repository.getTransaction(id)).intent.status,"CONFIRMED",
          "the fault changes Chain B only; no harness SQL manufactures a recovery result");
        console.log(`VALID: destination canonical history replaced stored receipt block ${oldReceipt.blockNumber}: former ${oldReceipt.blockHash}; current ${replacement.hash}`);
        console.log("VALID: the orphaned branch genuinely rolled back exact-message Gateway replay and ApplicationB business state");
        // No target ID or fault result is supplied to the production scan.
        for (let round = 0; round < rounds && !reorgEvidence; round++) await initialManager.checkReceiptsOnce();
        assert.ok(reorgEvidence,"bounded normal terminal receipt scanning must discover the reorg itself");
        assert.equal(reorgEvidence.candidatesChecked,original.attempts.length); assert.equal(reorgEvidence.replay,false);
        const recovering = await initialManager.repository.getTransaction(id);
        assert.equal(recovering.intent.status,"PENDING"); assert.equal(recovering.winningAttempt,null);
        assert.equal(recovering.intent.reorgRecovery.rebroadcastRequired,true);
        const [orphan] = await initialManager.repository.getReceiptObservations(id);
        assert.equal(orphan.orphaned,true); assert.equal(orphan.replacementBlockHash,replacement.hash);
        for (const field of ["observationId","transactionHash","blockNumber","blockHash","status","confirmedHead","confirmedAt"]) {
          assert.equal(orphan[field],history[0][field],`historical receipt ${field} must remain unchanged`);
        }
        console.log("VALID: normal Tx Manager observation stopped claiming the orphaned CONFIRMED receipt as current execution; original hash/block/status/confirmation evidence remain historical");
        console.log("VALID: every persisted same-intent candidate was rechecked and canonical Gateway replay was false before recovery resubmission");

        await verifyMessageQueryHTTP({ config: { ...config, validatorSets, destinationConfirmations: cfg.destinationConfirmations }, pool, states, records: validators,
          messageIds: [event.messageId], productionGateway: gateway, expectedExecution: "REORG_RECOVERY",
          destinationCheck: async () => ({ executed: await readGateway("isMessageExecuted", [event.messageId]),
            supplier: await readApp("isVerifiedSupplier", [supplier]) }), label: "historical orphan receipt with no current canonical winner" });

        freshPool = createDatabasePool(cfg);
        const freshQueue = createDeliveryRepository({ config: cfg,pool: freshPool });
        const restarted = createTransactionManager({ config: cfg,pool: freshPool,queue: freshQueue });
        assert.ok(isDeepStrictEqual(await restarted.repository.getTransaction(id),recovering),"fresh clients must read identical durable reorg recovery state");
        assert.deepEqual(await restarted.repository.getReceiptObservations(id),[orphan]);
        const resumed = createRelayerWorker({ config: cfg,pool: freshPool,queue: freshQueue,transactionManager: restarted });
        for (let round = 0; round < rounds && accepted.length < 2; round++) await resumed.runOnce();
        assert.deepEqual(accepted,[original.attempt.transactionHash,original.attempt.transactionHash]);
        const pending = await restarted.repository.getTransaction(id);
        assert.equal(pending.attempts.length,1); assert.equal(pending.attempt.broadcastAttemptCount,"2");
        for (const field of ["intentId","packageDigest","nonce","senderAddress","destinationGateway","value","calldata","createdAt"]) {
          assert.ok(pending.intent[field] === original.intent[field],`reorg recovery must preserve intent ${field}`);
        }
        for (const field of ["attemptId","attemptNumber","nonce","gasLimit","maxFeePerGas","maxPriorityFeePerGas","rawSignedTransaction","transactionHash","createdAt"]) {
          assert.ok(pending.attempt[field] === original.attempt[field],`reorg recovery must preserve signed ${field}`);
        }
        assert.equal(preparation(),beforePreparation,"reorg recovery must neither re-estimate target gas nor quote new fees");
        assert.equal(signatures,1); assert.deepEqual(await restarted.repository.getAccount(),account);
        const sent = observed.calls.filter(call => call.method === "eth_sendRawTransaction");
        assert.equal(sent.length,2); assert.ok(sent.every(call => call.params[0] === original.attempt.rawSignedTransaction));
        console.log("VALID: ordinary fenced Relayer/Tx Manager recovery resubmitted the same intent, message, package, nonce and exact signed bytes/hash; no new source proof, PBFT round, gas estimate, fee quote or signature");

        await client.request({ method: "anvil_mine",params: [toHex(cfg.destinationConfirmations)] });
        await restarted.checkReceiptsOnce();
        const final = await restarted.repository.getTransaction(id); assert.equal(final.intent.status,"CONFIRMED");
        const receipt = await client.request({ method: "eth_getTransactionReceipt",params: [original.attempt.transactionHash] });
        verifyRpcTransaction(final.intent,final.attempt,await client.request({ method: "eth_getTransactionByHash",params: [original.attempt.transactionHash] }),receipt);
        assert.equal(BigInt(receipt.status),1n); assert.notEqual(receipt.blockHash,oldReceipt.blockHash);
        assert.ok(BigInt(final.attempt.confirmedHead) - BigInt(receipt.blockNumber) + 1n >= cfg.destinationConfirmations);
        const finalHistory = await restarted.repository.getReceiptObservations(id);
        assert.equal(finalHistory.length,2); assert.deepEqual(finalHistory[0],orphan); assert.equal(finalHistory[1].orphaned,false);
        assert.equal(finalHistory[1].transactionHash,original.attempt.transactionHash);
        assert.equal(finalHistory[1].blockHash,receipt.blockHash);
        for (const [address,abi,eventName,args] of [
          [gateway,gatewayAbi,"CrossChainMessageExecuted",{ messageId: event.messageId }],
          [application,appAbi,"VerifiedSupplierGranted",{ messageId: event.messageId,supplier }],
        ]) {
          const logs = await client.getContractEvents({ address,abi,eventName,args,fromBlock: 0n,toBlock: "latest",strict: true });
          assert.equal(logs.length,1); assert.equal(logs[0].transactionHash,receipt.transactionHash); assert.equal(logs[0].blockHash,receipt.blockHash);
        }
        assert.equal(await readGateway("isMessageExecuted",[event.messageId]),true); assert.equal(await readApp("isVerifiedSupplier",[supplier]),true);
        assert.deepEqual((await restarted.repository.getBroadcastEvents(id)).slice(0,journal.length),journal);
        assert.deepEqual(await queue.getDeliveryEntries([id]),entry);
        assert.deepEqual(await lifecycle.readBatch({ batchRecordId: committed.record.batchRecordId }),committed);
        assert.deepEqual(await readMessages(pool,config.databaseSchema),source.rows);
        assert.deepEqual(await readIndexedSourceBlocks(pool,config.databaseSchema,config),source.blocks);
        assert.deepEqual(await readCursor(pool,config.databaseSchema,config),source.cursor);
        assert.deepEqual((await pool.query(`SELECT * FROM ${intents} WHERE delivery_job_id = ANY($1::text[]) ORDER BY delivery_job_id`,
          [previousIntents.map(row => row.delivery_job_id)])).rows,previousIntents);
        assert.deepEqual(await restarted.repository.getAccount(),account); assert.equal(observed.errors.length,0);
        console.log(`VALID: recovered transaction ${receipt.transactionHash} reached canonical confirmation depth at ${receipt.blockNumber}/${receipt.blockHash}; exactly one canonical Gateway execution and ApplicationB transition`);
        console.log("VALID: one historical orphaned receipt and one current canonical observation of the SAME transaction are preserved; source FINALIZED rows, batch membership/root/QC, READY authority, nonce allocator and historical executions remain unchanged");
      });
      for (const [position,index] of active.entries()) {
        assert.equal(validators[index].exited,false); assert.equal(validators[index].child.pid,pids[position]);
        assert.equal((await request(index,"/health")).body.ready,true);
      }
    } catch (error) { failure = error; throw error; }
    finally {
      const cleanup = await Promise.allSettled([freshPool?.end(),observed?.close()]);
      const failed = cleanup.filter(value => value.status === "rejected").map(value => value.reason);
      if (failed.length) throw new AggregateError([...(failure ? [failure] : []),...failed],"destination reorg cleanup failed");
    }
  }

  async function verifyDestinationRpcRecovery() {
    console.log("\n[Destination RPC Outage Recovery]");
    const suppliers = ["0x0000000000000000000000000000000000009071", "0x0000000000000000000000000000000000009072"];
    for (const supplier of suppliers) assert.equal(await readApp("isVerifiedSupplier", [supplier]), false);
    const sourceBatches = tableName(config.databaseSchema, "message_batches");
    const jobsTable = tableName(config.databaseSchema, "delivery_jobs");
    const intents = tableName(config.databaseSchema, "transaction_intents");
    const attempts = tableName(config.databaseSchema, "transaction_attempts");
    const journals = tableName(config.databaseSchema, "transaction_broadcast_events");
    const previousRows = await readMessages(pool, config.databaseSchema);
    const previousIds = new Set(previousRows.map(row => row.id));
    const previousBatches = [];
    for (const row of (await pool.query(`SELECT batch_record_id FROM ${sourceBatches}
      WHERE source_domain = $1 AND source_gateway = $2 ORDER BY epoch`,
    [config.chainDomain.toString(), config.sourceGateway])).rows) {
      previousBatches.push(await lifecycle.readBatch({ batchRecordId: row.batch_record_id }));
    }
    async function transportRows() {
      return { jobs: (await pool.query(`SELECT * FROM ${jobsTable} ORDER BY delivery_job_id`)).rows,
        intents: (await pool.query(`SELECT * FROM ${intents} ORDER BY delivery_job_id`)).rows,
        attempts: (await pool.query(`SELECT * FROM ${attempts} ORDER BY attempt_id`)).rows,
        journals: (await pool.query(`SELECT * FROM ${journals} ORDER BY event_id`)).rows };
    }
    const beforeTransport = await transportRows();
    const accountBefore = await manager.repository.getAccount();
    assert.ok(accountBefore);
    const pendingBefore = BigInt(await client.request({ method: "eth_getTransactionCount", params: [relayConfig.relayerAddress, "pending"] }));
    const validatorPids = new Map(active.map(index => [index, validators[index].child.pid]));
    async function assertHealthyValidators() {
      for (const index of active) {
        assert.equal(validators[index].exited, false); assert.equal(validators[index].child.pid, validatorPids.get(index));
        const health = await request(index, "/health");
        assert.equal(health.status, 200); assert.equal(health.body.ready, true);
      }
    }
    await assertHealthyValidators();
    const events = [];
    for (const supplier of suppliers) {
      events.push(await produceAndFinalize(encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "address" }], [1, 1, supplier])));
    }
    const committed = await commitFresh(events);
    assert.equal(committed.record.status, "COMMITTED"); assert.equal(committed.quorumCertificate.view, "0");
    const selected = validatorSets.resolveByValidatorEpoch(committed.consensusBinding.validatorEpoch);
    assert.equal(selected.validatorEpoch, validatorSets.resolveForBatchEpoch(committed.record.epoch).validatorEpoch);
    assert.equal(selected.committeeDigest, committed.consensusBinding.committeeDigest); assert.equal(selected.validators.length, 4);
    await certificateChecks.snapshot(committed, "healthy current committee committed both RPC-outage business messages");
    const projected = await projector.materializeBatch({ batchRecordId: committed.record.batchRecordId });
    assert.equal(projected.createdJobs, 2);
    const packages = await buildDeliveryPackages(committed, { validatorSets });
    assert.equal(packages.length, 2);
    assert.deepEqual(packages.map(pack => pack.message.messageId), events.map(event => event.messageId));
    const ids = packages.map(pack => pack.deliveryJobId);
    const jobs = await Promise.all(ids.map(id => queue.getDeliveryJob(id)));
    const rows = await rowsFor(events.map(event => event.messageId));
    assert.equal(rows.length, 2); assert.ok(rows.every(row => row.status === "FINALIZED"));
    for (const pack of packages) {
      assert.equal(pack.message.destinationGateway, gateway); assert.equal(pack.message.destinationReceiver, application);
      assert.deepEqual(await queue.getDeliveryPackage(pack.deliveryJobId), pack);
      await authenticate(pack, committed);
    }
    async function assertJobsAndSource() {
      assert.deepEqual(await queue.getDeliveryEntries(ids), jobs.map((job,index) => ({ job, package: packages[index] })));
      const stored = (await pool.query(`SELECT delivery_job_id,status FROM ${jobsTable}
        WHERE source_domain = $1 AND source_gateway = $2 AND message_id = ANY($3::text[]) ORDER BY message_index`,
      [config.chainDomain.toString(), config.sourceGateway, events.map(event => event.messageId)])).rows;
      assert.deepEqual(stored, ids.map(delivery_job_id => ({ delivery_job_id, status: "READY" })));
      assert.deepEqual(await rowsFor(events.map(event => event.messageId)), rows);
      assert.deepEqual(await lifecycle.readBatch({ batchRecordId: committed.record.batchRecordId }), committed);
    }
    async function assertNoDestinationExecution() {
      await assertJobsAndSource(); await assertHealthyValidators();
      for (const [index,event] of events.entries()) {
        assert.equal(await readGateway("isMessageExecuted", [event.messageId]), false);
        assert.equal(await readApp("isVerifiedSupplier", [suppliers[index]]), false);
      }
    }
    await assertNoDestinationExecution();
    console.log(`VALID: RPC-failure messages ${events.map(event => event.messageId).join(" / ")} originated from fresh exact-intent proofs and reached canonical COMMITTED/READY delivery jobs ${ids.join(" / ")}; batch ${committed.record.batchId}, root ${committed.tree.messageRoot}, QC ${committed.quorumCertificate.qcDigest}`);

    const paths = []; let observer; let relayers; let failure;
    try {
      const accepted = [];
      observer = await rpcObserver(rpcUrl, {
        async afterForward(message, reply) {
          if (message.method !== "eth_sendRawTransaction") return;
          assert.ok(reply && !reply.error, "recovered destination access must accept the exact retained transaction");
          accepted.push(reply.result);
        },
      });
      paths.push(await destinationAccessPath(observer.url));
      paths.push(await destinationAccessPath(observer.url));
      const environment = { ...process.env, DATABASE_URL: config.databaseUrl, INDEXER_DB_SCHEMA: config.databaseSchema,
        CHAIN_A_DOMAIN: config.chainDomain.toString(), SOURCE_GATEWAY_ADDRESS: config.sourceGateway,
        CHAIN_B_RPC_URL: paths[0].url, CHAIN_B_RPC_URLS: JSON.stringify(paths.map(path => path.url)),
        CHAIN_B_CHAIN_ID: relayConfig.destinationDomain.toString(), CHAIN_B_GENESIS_HASH: relayConfig.destinationGenesisHash,
        RELAYER_WORKER_ID: "relayer-a", RELAYER_MAX_JOBS_PER_RUN: "1", RELAYER_LEASE_MS: relayConfig.leaseMs.toString(),
        VALIDATOR_SET_HISTORY_FILE: "", VALIDATOR_SET_HISTORY: JSON.stringify(validatorSets.history) };
      const outageConfig = loadTransactionConfig(environment);
      assert.equal(outageConfig.relayerAddress, relayConfig.relayerAddress);
      relayers = createRelayerProcesses({ environment, pidFile: process.env.RELAYER_VERIFICATION_PID_FILE });
      const observedManager = createTransactionManager({ config: outageConfig, pool, queue });
      const result = await verifyDestinationRpcOutage({ processes: relayers, pool, config: outageConfig, manager: observedManager,
        queue, client, paths, observer, jobs, assertNoDestinationExecution });
      assert.equal(result.faultTarget.deliveryJobId, ids[0]); assert.equal(result.following.deliveryJobId, ids[1]);
      assert.deepEqual([...accepted].sort(), result.final.map(value => value.attempt.transactionHash).sort());
      assert.equal(accepted.length, 2); assert.equal(new Set(accepted).size, 2);
      const expectedFirstNonce = BigInt(accountBefore.nextNonce) > pendingBefore ? BigInt(accountBefore.nextNonce) : pendingBefore;
      for (const [index,value] of result.final.entries()) {
        const event = events[index]; const receipt = result.mined[index].receipt;
        assert.equal(value.intent.status, "CONFIRMED"); assert.equal(value.attempt.status, "CONFIRMED");
        assert.equal(value.intent.deliveryJobId, ids[index]); assert.equal(value.intent.senderAddress, relayConfig.relayerAddress);
        assert.equal(BigInt(value.intent.nonce), expectedFirstNonce + BigInt(index));
        assert.equal(value.intent.destinationGateway, gateway); assert.equal(value.intent.value, "0");
        assert.equal(value.intent.winningAttemptId, value.attempt.attemptId); assert.equal(value.attempt.receiptStatus, 1);
        assert.equal(value.attempt.receiptBlockNumber, BigInt(receipt.blockNumber).toString());
        assert.equal(value.attempt.receiptBlockHash, receipt.blockHash); assert.equal(value.attempt.transactionHash, receipt.transactionHash);
        assert.equal(value.attempts.length, 1); assert.equal(value.attempt.replacementOfAttemptId, null);
        const transaction = await client.request({ method: "eth_getTransactionByHash", params: [value.attempt.transactionHash] });
        verifyRpcTransaction(value.intent, value.attempt, transaction, receipt);
        const block = await client.request({ method: "eth_getBlockByNumber", params: [receipt.blockNumber, false] });
        assert.equal(block.hash, receipt.blockHash);
        assert.equal(await readGateway("isMessageExecuted", [event.messageId]), true);
        assert.equal(await readApp("isVerifiedSupplier", [suppliers[index]]), true);
        const executions = receipt.logs.filter(log => log.address.toLowerCase() === gateway).map(log => decodeEventLog({ abi: gatewayAbi, ...log }));
        const grants = receipt.logs.filter(log => log.address.toLowerCase() === application).map(log => decodeEventLog({ abi: appAbi, ...log }));
        assert.equal(executions.length, 1); assert.equal(executions[0].eventName, "CrossChainMessageExecuted");
        assert.equal(executions[0].args.messageId, event.messageId); assert.equal(executions[0].args.batchId, committed.record.batchId);
        assert.equal(executions[0].args.sourceDomain, config.chainDomain); assert.equal(executions[0].args.destinationReceiver.toLowerCase(), application);
        assert.equal(grants.length, 1); assert.equal(grants[0].eventName, "VerifiedSupplierGranted");
        assert.equal(grants[0].args.messageId, event.messageId); assert.equal(grants[0].args.supplier.toLowerCase(), suppliers[index]);
        for (const [address, abi, eventName, args] of [
          [gateway, gatewayAbi, "CrossChainMessageExecuted", { messageId: event.messageId }],
          [application, appAbi, "VerifiedSupplierGranted", { messageId: event.messageId, supplier: suppliers[index] }],
        ]) {
          const logs = await client.getContractEvents({ address, abi, eventName, args, fromBlock: 0n, toBlock: "latest", strict: true });
          assert.equal(logs.length, 1); assert.equal(logs[0].transactionHash, value.attempt.transactionHash);
        }
        const count = (await pool.query(`SELECT
          (SELECT COUNT(*) FROM ${intents} WHERE delivery_job_id = $1)::text AS intents,
          COUNT(*)::text AS attempts,COUNT(*) FILTER (WHERE replacement_of_attempt_id IS NOT NULL)::text AS replacements
          FROM ${attempts} WHERE delivery_job_id = $1`, [ids[index]])).rows[0];
        assert.deepEqual(count, { intents: "1", attempts: "1", replacements: "0" });
        console.log(`VALID: ${index === 0 ? "fault-target" : "retained following-job"} transaction ${value.attempt.transactionHash} reached canonical CONFIRMED state and executed production DestinationGateway/ApplicationB exactly once for ${event.messageId}; supplier ${suppliers[index]}`);
      }
      assert.equal(BigInt((await manager.repository.getAccount()).nextNonce), expectedFirstNonce + 2n);
      assert.equal(BigInt(result.final[1].attempt.receiptBlockNumber) >= BigInt(result.final[0].attempt.receiptBlockNumber), true);
      const failed = (await pool.query(`SELECT * FROM ${journals} WHERE event_id = $1`, [result.failedJournal[0].event_id])).rows;
      assert.deepEqual(failed, result.failedJournal, "successful continuation must retain the original RPC outage diagnostic");
      const repeated = await projector.materializeBatch({ batchRecordId: committed.record.batchRecordId });
      assert.equal(repeated.materialized, false); assert.equal(repeated.createdJobs, 0);
      await assertJobsAndSource(); await assertHealthyValidators();
      for (const previous of previousBatches) assert.deepEqual(await lifecycle.readBatch({ batchRecordId: previous.record.batchRecordId }), previous);
      assert.deepEqual((await readMessages(pool, config.databaseSchema)).filter(row => previousIds.has(row.id)), previousRows);
      const afterTransport = await transportRows(); const ownIds = new Set(ids);
      for (const name of ["jobs", "intents", "attempts"]) {
        assert.ok(isDeepStrictEqual(afterTransport[name].filter(row => !ownIds.has(row.delivery_job_id)), beforeTransport[name]), `historical ${name} remain unchanged`);
      }
      const ownAttempts = new Set(result.final.map(value => value.attempt.attemptId));
      assert.ok(isDeepStrictEqual(afterTransport.journals.filter(row => !ownAttempts.has(row.attempt_id)), beforeTransport.journals), "historical signed/broadcast evidence remains unchanged");
      console.log("VALID: destination RPC outage caused zero lost delivery jobs, zero duplicate business executions and zero corruption of source/batch/Merkle/QC/transaction history; both retained READY identities have successful canonical outcomes");
    } catch (error) { failure = error; throw error; }
    finally {
      const cleanupErrors = [];
      for (const path of paths) path.state.available = true;
      if (relayers) try { await relayers.close(); } catch (error) { cleanupErrors.push(error); }
      for (const path of paths) try { await path.close(); } catch (error) { cleanupErrors.push(error); }
      if (observer) try { await observer.close(); } catch (error) { cleanupErrors.push(error); }
      for (const path of paths) cleanupErrors.push(...path.errors);
      if (observer) cleanupErrors.push(...observer.errors);
      if (cleanupErrors.length) throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, "destination RPC-outage observation or cleanup failed");
    }
  }

  async function verifyDuplicateDelivery() {
    const targetSupplier = "0x0000000000000000000000000000000000009061";
    const targetPayload = encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "address" }], [1, 1, targetSupplier]);
    assert.equal(await readApp("isVerifiedSupplier", [targetSupplier]), false);
    assert.notEqual(normalizeAddress(alternate.address), relayConfig.relayerAddress);
    const sourceBatches = tableName(config.databaseSchema, "message_batches");
    const jobs = tableName(config.databaseSchema, "delivery_jobs");
    const intents = tableName(config.databaseSchema, "transaction_intents");
    const attempts = tableName(config.databaseSchema, "transaction_attempts");
    const journals = tableName(config.databaseSchema, "transaction_broadcast_events");
    const accounts = tableName(config.databaseSchema, "transaction_accounts");
    const previousRows = await readMessages(pool, config.databaseSchema);
    const previousIds = new Set(previousRows.map(row => row.id));
    const previousBatches = [];
    for (const row of (await pool.query(`SELECT batch_record_id FROM ${sourceBatches}
      WHERE source_domain = $1 AND source_gateway = $2 ORDER BY epoch`,
    [config.chainDomain.toString(), config.sourceGateway])).rows) {
      previousBatches.push(await lifecycle.readBatch({ batchRecordId: row.batch_record_id }));
    }
    async function transportRows() {
      return { jobs: (await pool.query(`SELECT * FROM ${jobs} ORDER BY delivery_job_id`)).rows,
        intents: (await pool.query(`SELECT * FROM ${intents} ORDER BY delivery_job_id`)).rows,
        attempts: (await pool.query(`SELECT * FROM ${attempts} ORDER BY attempt_id`)).rows,
        journals: (await pool.query(`SELECT * FROM ${journals} ORDER BY event_id`)).rows,
        accounts: (await pool.query(`SELECT * FROM ${accounts} ORDER BY chain_id,sender_address`)).rows };
    }
    const beforeTransport = await transportRows();
    const accountBefore = await manager.repository.getAccount();
    assert.ok(accountBefore);
    const pendingBefore = BigInt(await client.request({ method: "eth_getTransactionCount", params: [relayConfig.relayerAddress, "pending"] }));
    const validatorPids = new Map(active.map(index => [index, validators[index].child.pid]));
    async function assertHealthyValidators() {
      for (const index of active) {
        assert.equal(validators[index].exited, false); assert.equal(validators[index].child.pid, validatorPids.get(index));
        const health = await request(index, "/health");
        assert.equal(health.status, 200); assert.equal(health.body.ready, true);
      }
    }
    await assertHealthyValidators();
    const event = await produceAndFinalize(targetPayload);
    const committed = await commitFresh([event]);
    assert.equal(committed.record.status, "COMMITTED"); assert.equal(committed.quorumCertificate.view, "0");
    const selected = validatorSets.resolveByValidatorEpoch(committed.consensusBinding.validatorEpoch);
    assert.equal(selected.validatorEpoch, validatorSets.resolveForBatchEpoch(committed.record.epoch).validatorEpoch);
    assert.equal(selected.committeeDigest, committed.consensusBinding.committeeDigest); assert.equal(selected.validators.length, 4);
    await certificateChecks.snapshot(committed, "healthy current committee committed the duplicate-delivery target");
    const projected = await projector.materializeBatch({ batchRecordId: committed.record.batchRecordId });
    assert.equal(projected.createdJobs, 1);
    const packages = await buildDeliveryPackages(committed, { validatorSets });
    assert.equal(packages.length, 1);
    // This strict stored-package snapshot is shared evidence, independently
    // reloaded and checked by both child transport actors before signing.
    const pack = await queue.getDeliveryPackage(packages[0].deliveryJobId);
    assert.deepEqual(pack, packages[0]); assert.equal(pack.message.messageId, event.messageId);
    assert.equal(pack.message.payload, targetPayload); assert.equal(pack.message.destinationGateway, gateway);
    assert.equal(pack.message.destinationReceiver, application);
    const job = await queue.getDeliveryJob(pack.deliveryJobId);
    const sourceRows = await rowsFor([event.messageId]);
    assert.equal(sourceRows.length, 1); assert.equal(sourceRows[0].status, "FINALIZED");
    async function assertOneReady() {
      const rows = (await pool.query(`SELECT delivery_job_id,status FROM ${jobs}
        WHERE source_domain = $1 AND source_gateway = $2 AND message_id = $3`,
      [config.chainDomain.toString(), config.sourceGateway, event.messageId])).rows;
      assert.deepEqual(rows, [{ delivery_job_id: pack.deliveryJobId, status: "READY" }]);
      assert.deepEqual(await queue.getDeliveryJob(pack.deliveryJobId), job);
      assert.deepEqual(await queue.getDeliveryPackage(pack.deliveryJobId), pack);
    }
    await assertOneReady(); await authenticate(pack, committed);
    assert.equal(await readGateway("isMessageExecuted", [event.messageId]), false);
    assert.equal(await readApp("isVerifiedSupplier", [targetSupplier]), false);
    const encoded = await encodeGatewaySubmission(pack, { validatorSets });
    assert.equal(decodeFunctionData({ abi: DESTINATION_GATEWAY_ABI, data: encoded.calldata }).args[0], encoded.data);
    console.log(`VALID: duplicate-delivery target ${event.messageId} originated from a fresh exact-intent proof and reached one canonical COMMITTED/READY package ${pack.deliveryJobId}; batch ${committed.record.batchId}, root ${committed.tree.messageRoot}, QC ${committed.quorumCertificate.qcDigest}`);

    let observer; let relayers; let failure;
    try {
      const accepted = [];
      observer = await rpcObserver(rpcUrl, {
        async afterForward(message, reply) {
          if (message.method !== "eth_sendRawTransaction") return;
          assert.ok(reply && !reply.error, "both healthy destination RPC broadcasts must be accepted");
          accepted.push(reply.result);
        },
      });
      const environment = { ...process.env, DATABASE_URL: config.databaseUrl, INDEXER_DB_SCHEMA: config.databaseSchema,
        CHAIN_A_DOMAIN: config.chainDomain.toString(), SOURCE_GATEWAY_ADDRESS: config.sourceGateway,
        CHAIN_B_RPC_URL: observer.url, CHAIN_B_RPC_URLS: JSON.stringify([observer.url]),
        CHAIN_B_CHAIN_ID: relayConfig.destinationDomain.toString(), CHAIN_B_GENESIS_HASH: relayConfig.destinationGenesisHash,
        RELAYER_LEASE_MS: relayConfig.leaseMs.toString(), VALIDATOR_SET_HISTORY_FILE: "",
        VALIDATOR_SET_HISTORY: JSON.stringify(validatorSets.history) };
      const raceConfig = loadTransactionConfig(environment);
      relayers = createRelayerProcesses({ environment, pidFile: process.env.RELAYER_VERIFICATION_PID_FILE });
      const observedManager = createTransactionManager({ config: raceConfig, pool, queue });
      const race = await verifyDuplicateTransportRace({ processes: relayers, pool, config: raceConfig, manager: observedManager,
        queue, client, observer, id: pack.deliveryJobId, duplicatePrivateKey: developmentKeys(6)[5] });
      assert.equal(race.identities[0].intent.senderAddress, relayConfig.relayerAddress);
      assert.equal(race.identities[1].intent.senderAddress, normalizeAddress(alternate.address));
      assert.deepEqual([...accepted].sort(), race.identities.map(identity => identity.attempt.transactionHash).sort());
      assert.equal(accepted.length, 2); assert.equal(new Set(accepted).size, 2);
      const { winner, loser } = race;
      assert.equal(BigInt(winner.receipt.status), 1n); assert.equal(BigInt(loser.receipt.status), 0n);
      assert.equal(winner.transaction.input, loser.transaction.input); assert.equal(winner.transaction.input, encoded.calldata);
      assert.equal(winner.transaction.to.toLowerCase(), gateway); assert.equal(loser.transaction.to.toLowerCase(), gateway);
      assert.equal(BigInt(winner.transaction.value), 0n); assert.equal(BigInt(loser.transaction.value), 0n);
      const executed = winner.receipt.logs.filter(log => log.address.toLowerCase() === gateway).map(log => decodeEventLog({ abi: gatewayAbi, ...log }));
      const granted = winner.receipt.logs.filter(log => log.address.toLowerCase() === application).map(log => decodeEventLog({ abi: appAbi, ...log }));
      assert.equal(executed.length, 1); assert.equal(executed[0].eventName, "CrossChainMessageExecuted");
      assert.equal(executed[0].args.messageId, event.messageId); assert.equal(executed[0].args.batchId, committed.record.batchId);
      assert.equal(executed[0].args.sourceDomain, config.chainDomain); assert.equal(executed[0].args.destinationReceiver.toLowerCase(), application);
      assert.equal(granted.length, 1); assert.equal(granted[0].eventName, "VerifiedSupplierGranted");
      assert.equal(granted[0].args.messageId, event.messageId); assert.equal(granted[0].args.supplier.toLowerCase(), targetSupplier);
      assert.equal(loser.receipt.logs.length, 0);
      assert.equal(await readGateway("isMessageExecuted", [event.messageId]), true);
      assert.equal(await readApp("isVerifiedSupplier", [targetSupplier]), true);
      // Follow the existing exact custom-error replay checks, using the actual
      // loser's sender, calldata, gas and canonical receipt block. Both original
      // transactions are in that same block, with the winner ordered first.
      // A full-gas authentic loser must reach the consumed-ID guard, not fail
      // due to invalid upstream evidence, expiry, funds or nonce coordination.
      await authenticate(pack, committed);
      await expectError({ ...call(encoded.data), gas: BigInt(loser.transaction.gas),
        blockNumber: BigInt(loser.receipt.blockNumber) }, loser.intent.senderAddress, "MessageAlreadyExecuted", [event.messageId]);
      console.log(`VALID: one duplicate-delivery transaction successfully executed DestinationGateway and ApplicationB; winner ${winner.workerId}, tx ${winner.attempt.transactionHash}`);
      console.log(`EXPECTED FAILURE: the other authentic duplicate transaction ${loser.attempt.transactionHash} reverted with MessageAlreadyExecuted(${event.messageId}); precise same-calldata replay decoded at its canonical receipt block; loser ${loser.workerId}`);
      console.log("VALID: both packages retained valid QC/Merkle/domain/receiver/deadline evidence; the loser had gas remaining, accepted RPC transport and an independent funded sender/nonce");

      await client.request({ method: "anvil_mine", params: [toHex(relayConfig.destinationConfirmations)] });
      const confirmation = await observedManager.recoverTransactionsOnce({ deliveryJobId: pack.deliveryJobId });
      assert.equal(confirmation.scanned, 1); assert.equal(confirmation.finalized, 1); assert.equal(confirmation.rebroadcast, 0);
      const canonical = await manager.repository.getTransaction(pack.deliveryJobId);
      const canonicalOutcome = winner.workerId === "relayer-a" ? "CONFIRMED" : "REVERTED";
      const canonicalReceipt = winner.workerId === "relayer-a" ? winner.receipt : loser.receipt;
      assert.equal(canonical.intent.status, canonicalOutcome); assert.equal(canonical.attempt.status, canonicalOutcome);
      assert.equal(canonical.intent.winningAttemptId, race.canonical.attempt.attemptId);
      assert.equal(canonical.attempt.receiptStatus, canonicalOutcome === "CONFIRMED" ? 1 : 0);
      assert.equal(canonical.attempt.receiptBlockNumber, BigInt(canonicalReceipt.blockNumber).toString());
      assert.equal(canonical.attempt.receiptBlockHash, canonicalReceipt.blockHash);
      assert.ok(BigInt(canonical.attempt.confirmedHead) - BigInt(canonicalReceipt.blockNumber) + 1n >= relayConfig.destinationConfirmations);
      assert.equal(canonical.attempts.length, 1); assert.equal(canonical.attempt.attemptNumber, 0);
      assert.equal(canonical.attempt.replacementOfAttemptId, null); assert.equal(canonical.attempt.broadcastAttemptCount, "1");
      for (const field of ["nonce", "senderAddress", "destinationGateway", "value", "packageDigest", "calldata"]) {
        assert.ok(canonical.intent[field] === race.canonical.intent[field], `canonical delivery preserves original intent ${field}`);
      }
      for (const field of ["attemptId", "nonce", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "rawSignedTransaction", "transactionHash"]) {
        assert.ok(canonical.attempt[field] === race.canonical.attempt[field], `canonical delivery preserves original signed ${field}`);
      }
      const reserved = BigInt(accountBefore.nextNonce);
      const expectedNonce = reserved > pendingBefore ? reserved : pendingBefore;
      assert.equal(BigInt(canonical.intent.nonce), expectedNonce);
      assert.equal(BigInt((await manager.repository.getAccount()).nextNonce), expectedNonce + 1n);
      const lease = await createRelayerLeaseRepository({ config: raceConfig, pool, queue }).getLease(pack.deliveryJobId);
      assert.equal(lease.ownerId, "relayer-a"); assert.equal(lease.fencingToken, "1"); assert.notEqual(lease.releasedAt, null);
      const targetCounts = (await pool.query(`SELECT
        (SELECT COUNT(*) FROM ${intents} WHERE delivery_job_id = $1)::text AS intents,
        COUNT(*)::text AS attempts,COUNT(*) FILTER (WHERE replacement_of_attempt_id IS NOT NULL)::text AS replacements
        FROM ${attempts} WHERE delivery_job_id = $1`, [pack.deliveryJobId])).rows[0];
      assert.deepEqual(targetCounts, { intents: "1", attempts: "1", replacements: "0" });
      const journal = (await pool.query(`SELECT e.* FROM ${journals} e JOIN ${attempts} a USING (attempt_id)
        WHERE a.delivery_job_id = $1 ORDER BY e.event_id`, [pack.deliveryJobId])).rows;
      assert.equal(journal.length, 2);
      assert.equal(journal.filter(row => row.parent_event_id === null).length, 1);
      assert.equal(journal.filter(row => row.parent_event_id !== null).length, 1);
      for (const row of journal) {
        assert.notEqual(row.completed_at, null); assert.equal(row.result_class, "ACCEPTED");
        assert.equal(row.returned_tx_hash, canonical.attempt.transactionHash);
      }
      const confirmedHead = BigInt(await client.request({ method: "eth_blockNumber", params: [] }));
      const confirmedBlock = await client.request({ method: "eth_getBlockByNumber", params: [winner.receipt.blockNumber, false] });
      assert.equal(confirmedBlock.hash, winner.receipt.blockHash);
      for (const identity of [winner, loser]) {
        assert.ok(confirmedHead - BigInt(identity.receipt.blockNumber) + 1n >= relayConfig.destinationConfirmations);
        const receipt = await client.request({ method: "eth_getTransactionReceipt", params: [identity.attempt.transactionHash] });
        assert.ok(receipt); assert.equal(receipt.blockHash, confirmedBlock.hash);
        assert.equal(receipt.status, identity.receipt.status);
      }
      for (const [address, abi, eventName, args] of [
        [gateway, gatewayAbi, "CrossChainMessageExecuted", { messageId: event.messageId }],
        [application, appAbi, "VerifiedSupplierGranted", { messageId: event.messageId, supplier: targetSupplier }],
      ]) {
        const events = await client.getContractEvents({ address, abi, eventName, args, fromBlock: 0n, toBlock: "latest", strict: true });
        assert.equal(events.length, 1); assert.equal(events[0].transactionHash, winner.attempt.transactionHash);
      }
      const repeated = await projector.materializeBatch({ batchRecordId: committed.record.batchRecordId });
      assert.equal(repeated.materialized, false); assert.equal(repeated.createdJobs, 0);
      await assertOneReady();
      assert.deepEqual(await rowsFor([event.messageId]), sourceRows);
      assert.deepEqual(await lifecycle.readBatch({ batchRecordId: committed.record.batchRecordId }), committed);
      for (const previous of previousBatches) assert.deepEqual(await lifecycle.readBatch({ batchRecordId: previous.record.batchRecordId }), previous);
      assert.deepEqual((await readMessages(pool, config.databaseSchema)).filter(row => previousIds.has(row.id)), previousRows);
      const afterTransport = await transportRows();
      for (const name of ["jobs", "intents", "attempts"]) {
        assert.ok(isDeepStrictEqual(afterTransport[name].filter(row => row.delivery_job_id !== pack.deliveryJobId), beforeTransport[name]), `historical ${name} remain unchanged`);
      }
      assert.ok(isDeepStrictEqual(afterTransport.journals.filter(row => row.attempt_id !== canonical.attempt.attemptId), beforeTransport.journals), "historical broadcast journals remain unchanged");
      const otherAccounts = rows => rows.filter(row => row.chain_id !== relayConfig.destinationDomain.toString() || row.sender_address !== relayConfig.relayerAddress);
      assert.ok(isDeepStrictEqual(otherAccounts(afterTransport.accounts), otherAccounts(beforeTransport.accounts)), "duplicate contender must not create or modify a canonical nonce account");
      assert.equal(observer.calls.filter(message => message.method === "eth_sendRawTransaction").length, 2);
      assert.equal(observer.errors.length, 0); await assertHealthyValidators();
      console.log(`VALID: canonical operational A transaction finalized as ${canonicalOutcome} from its OWN receipt; intentional duplicate B never created another canonical intent, nonce account or replacement`);
      console.log("VALID: replay protection remained keyed by canonical messageId and was independent of the two relayer transaction senders");
      console.log(`VALID: DestinationGateway reports target ${event.messageId} consumed exactly once; ApplicationB emitted exactly one business event and target ${targetSupplier} transitioned false → true exactly once`);
      console.log("VALID: one canonical READY identity, two independent processes/senders, two actual broadcasts/hashes, one successful receipt, one exact replay rejection, one Gateway execution and one ApplicationB transition; historical source/QC/package/transaction evidence unchanged");
    } catch (error) { failure = error; throw error; }
    finally {
      const cleanupErrors = [];
      if (relayers) try { await relayers.close(); } catch (error) { cleanupErrors.push(error); }
      if (observer) try { await observer.close(); } catch (error) { cleanupErrors.push(error); }
      if (observer) cleanupErrors.push(...observer.errors);
      if (cleanupErrors.length) throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, "duplicate-delivery observation or cleanup failed");
    }
  }

  async function verifyRelayerFailure() {
    const targetSupplier = "0x0000000000000000000000000000000000009051";
    const targetPayload = encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "address" }], [1, 1, targetSupplier]);
    assert.equal(await readApp("isVerifiedSupplier", [targetSupplier]), false);
    const sourceBatches = tableName(config.databaseSchema, "message_batches");
    const jobs = tableName(config.databaseSchema, "delivery_jobs");
    const intents = tableName(config.databaseSchema, "transaction_intents");
    const attempts = tableName(config.databaseSchema, "transaction_attempts");
    const journals = tableName(config.databaseSchema, "transaction_broadcast_events");
    const leases = tableName(config.databaseSchema, "relayer_job_leases");
    const previousRows = await readMessages(pool, config.databaseSchema);
    const previousIds = new Set(previousRows.map(row => row.id));
    const previousBatches = [];
    for (const row of (await pool.query(`SELECT batch_record_id FROM ${sourceBatches}
      WHERE source_domain = $1 AND source_gateway = $2 ORDER BY epoch`,
    [config.chainDomain.toString(), config.sourceGateway])).rows) {
      previousBatches.push(await lifecycle.readBatch({ batchRecordId: row.batch_record_id }));
    }
    async function transportRows() {
      return { jobs: (await pool.query(`SELECT * FROM ${jobs} ORDER BY delivery_job_id`)).rows,
        intents: (await pool.query(`SELECT * FROM ${intents} ORDER BY delivery_job_id`)).rows,
        attempts: (await pool.query(`SELECT * FROM ${attempts} ORDER BY attempt_id`)).rows,
        journals: (await pool.query(`SELECT * FROM ${journals} ORDER BY event_id`)).rows };
    }
    const beforeTransport = await transportRows();
    const accountBefore = await manager.repository.getAccount();
    assert.ok(accountBefore);
    const pendingNonceBefore = BigInt(await client.request({ method: "eth_getTransactionCount", params: [relayConfig.relayerAddress, "pending"] }));
    const validatorPids = new Map(active.map(index => [index, validators[index].child.pid]));
    async function assertHealthyValidators() {
      for (const index of active) {
        assert.equal(validators[index].exited, false); assert.equal(validators[index].child.pid, validatorPids.get(index));
        const health = await request(index, "/health");
        assert.equal(health.status, 200); assert.equal(health.body.ready, true);
      }
    }
    await assertHealthyValidators();
    const event = await produceAndFinalize(targetPayload);
    const committed = await commitFresh([event]);
    assert.equal(committed.record.status, "COMMITTED");
    const selected = validatorSets.resolveByValidatorEpoch(committed.consensusBinding.validatorEpoch);
    assert.equal(selected.validatorEpoch, validatorSets.resolveForBatchEpoch(committed.record.epoch).validatorEpoch);
    assert.equal(selected.committeeDigest, committed.consensusBinding.committeeDigest);
    assert.equal(selected.validators.length, 4);
    assert.equal(committed.quorumCertificate.view, "0", "relayer failure must not introduce a consensus fault");
    await certificateChecks.snapshot(committed, "healthy pinned committee committed the relayer-failure target before transport failure");
    const projected = await projector.materializeBatch({ batchRecordId: committed.record.batchRecordId });
    assert.equal(projected.createdJobs, 1);
    const packs = await buildDeliveryPackages(committed, { validatorSets });
    assert.equal(packs.length, 1);
    const [pack] = packs;
    assert.equal(pack.message.messageId, event.messageId); assert.equal(pack.message.payload, targetPayload);
    assert.equal(pack.message.destinationGateway, gateway); assert.equal(pack.message.destinationReceiver, application);
    const job = await queue.getDeliveryJob(pack.deliveryJobId);
    assert.equal(job.status, "READY"); assert.deepEqual(await queue.getDeliveryPackage(pack.deliveryJobId), pack);
    const sourceRows = await rowsFor([event.messageId]);
    assert.equal(sourceRows.length, 1); assert.equal(sourceRows[0].status, "FINALIZED");
    async function assertOneReady() {
      const rows = (await pool.query(`SELECT delivery_job_id,status FROM ${jobs}
        WHERE source_domain = $1 AND source_gateway = $2 AND message_id = $3`,
      [config.chainDomain.toString(), config.sourceGateway, event.messageId])).rows;
      assert.deepEqual(rows, [{ delivery_job_id: pack.deliveryJobId, status: "READY" }]);
      assert.deepEqual(await queue.getDeliveryJob(pack.deliveryJobId), job);
      assert.deepEqual(await queue.getDeliveryPackage(pack.deliveryJobId), pack);
    }
    await assertOneReady();
    assert.equal(await readGateway("isMessageExecuted", [event.messageId]), false);
    assert.equal(await readApp("isVerifiedSupplier", [targetSupplier]), false);
    const encoded = await encodeGatewaySubmission(pack, { validatorSets });
    const decoded = decodeFunctionData({ abi: DESTINATION_GATEWAY_ABI, data: encoded.calldata });
    assert.equal(decoded.functionName, "execute"); assert.equal(decoded.args[0], encoded.data);
    console.log(`VALID: relayer-failure target ${event.messageId} reached one canonical READY job ${pack.deliveryJobId}; batch ${committed.record.batchId}, root ${committed.tree.messageRoot}, QC ${committed.quorumCertificate.qcDigest}, validator epoch ${selected.validatorEpoch}`);

    let observer; let relayers; let failure;
    try {
      const sendOwners = []; const replies = [];
      // Transparent observation only: the sole injected fault is A's SIGKILL.
      observer = await rpcObserver(rpcUrl, {
        async beforeForward(message) {
          if (message.method !== "eth_sendRawTransaction") return;
          const owner = (await pool.query(`SELECT owner_id,owner_session_id,fencing_token FROM ${leases}
            WHERE delivery_job_id = $1 AND released_at IS NULL AND lease_expires_at > clock_timestamp()`, [pack.deliveryJobId])).rows[0];
          assert.ok(owner, "broadcast must have a live database-time lease"); assert.equal(owner.owner_id, "relayer-b");
          const stored = await manager.repository.getTransaction(pack.deliveryJobId);
          assert.ok(message.params[0] === stored.attempt.rawSignedTransaction, "only the durable signed bytes may cross the healthy RPC observer");
          assert.equal(stored.attempt.status, "SIGNED"); assert.equal(stored.attempt.broadcastAttemptCount, "1");
          const started = (await pool.query(`SELECT e.* FROM ${journals} e JOIN ${attempts} a USING (attempt_id)
            WHERE a.delivery_job_id = $1 ORDER BY e.event_id`, [pack.deliveryJobId])).rows;
          // The journal persists both the logical send and its endpoint send
          // before external I/O; these are two rows for ONE broadcast.
          assert.equal(started.length, 2);
          const logical = started.filter(row => row.parent_event_id === null);
          const endpoints = started.filter(row => row.parent_event_id !== null);
          assert.equal(logical.length, 1); assert.equal(endpoints.length, 1);
          assert.equal(endpoints[0].parent_event_id, logical[0].event_id); assert.equal(endpoints[0].endpoint_label, "rpc-0");
          for (const row of started) { assert.equal(row.completed_at, null); assert.equal(row.attempt_id, stored.attempt.attemptId); }
          sendOwners.push(owner);
        },
        async afterForward(message, reply) {
          if (message.method !== "eth_sendRawTransaction") return;
          assert.ok(reply && !reply.error, "the healthy destination RPC must accept B's exact persisted transaction");
          replies.push(reply.result);
        },
      });
      const environment = { ...process.env, DATABASE_URL: config.databaseUrl, INDEXER_DB_SCHEMA: config.databaseSchema,
        CHAIN_A_DOMAIN: config.chainDomain.toString(), SOURCE_GATEWAY_ADDRESS: config.sourceGateway,
        CHAIN_B_RPC_URL: observer.url, CHAIN_B_RPC_URLS: JSON.stringify([observer.url]),
        CHAIN_B_CHAIN_ID: relayConfig.destinationDomain.toString(), CHAIN_B_GENESIS_HASH: relayConfig.destinationGenesisHash,
        RELAYER_LEASE_MS: relayConfig.leaseMs.toString(), VALIDATOR_SET_HISTORY_FILE: "",
        VALIDATOR_SET_HISTORY: JSON.stringify(validatorSets.history) };
      const takeoverConfig = loadTransactionConfig(environment);
      assert.equal(takeoverConfig.relayerAddress, relayConfig.relayerAddress);
      assert.equal(takeoverConfig.leaseMs, relayConfig.leaseMs);
      relayers = createRelayerProcesses({ environment, pidFile: process.env.RELAYER_VERIFICATION_PID_FILE });
      const observedManager = createTransactionManager({ config: takeoverConfig, pool, queue });
      const takeover = await verifySignedTakeoverAfterExpiry({ processes: relayers, pool, config: takeoverConfig,
        manager: observedManager, queue, client, observer, id: pack.deliveryJobId });
      const original = takeover.signed;
      const reserved = BigInt(accountBefore.nextNonce);
      const expectedNonce = reserved > pendingNonceBefore ? reserved : pendingNonceBefore;
      assert.equal(original.intent.nonce, expectedNonce.toString());
      assert.equal(original.intent.destinationGateway, gateway); assert.equal(original.intent.chainId, "2001");
      assert.equal(original.intent.senderAddress, relayConfig.relayerAddress); assert.equal(original.intent.value, "0");
      assert.equal(original.intent.packageDigest, encoded.packageDigest); assert.equal(original.intent.calldata, encoded.calldata);
      assert.equal(sendOwners.length, 1); assert.deepEqual(replies, [original.attempt.transactionHash]);
      assert.equal(sendOwners[0].fencing_token, takeover.fenceB.fencingToken);
      assert.equal(sendOwners[0].owner_session_id, takeover.fenceB.ownerSessionId);
      const receipt = await client.waitForTransactionReceipt({ hash: original.attempt.transactionHash });
      assert.equal(receipt.status, "success"); assert.equal(receipt.transactionHash, original.attempt.transactionHash);
      // Keep the RPC hex nonce full-width instead of passing through viem's
      // formatted transaction nonce (Number).
      const transaction = await client.request({ method: "eth_getTransactionByHash", params: [receipt.transactionHash] });
      assert.ok(transaction); assert.equal(transaction.hash, receipt.transactionHash);
      assert.equal(BigInt(transaction.type), 2n); assert.equal(BigInt(transaction.chainId), relayConfig.destinationDomain);
      assert.equal(transaction.from.toLowerCase(), original.intent.senderAddress);
      assert.equal(transaction.to.toLowerCase(), gateway); assert.equal(BigInt(transaction.value), 0n);
      assert.equal(BigInt(transaction.nonce), BigInt(original.intent.nonce)); assert.equal(transaction.input, encoded.calldata);
      assert.equal(BigInt(transaction.gas), BigInt(original.attempt.gasLimit));
      assert.equal(BigInt(transaction.maxFeePerGas), BigInt(original.attempt.maxFeePerGas));
      assert.equal(BigInt(transaction.maxPriorityFeePerGas), BigInt(original.attempt.maxPriorityFeePerGas));
      assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash, receipt.blockHash);
      const executions = receipt.logs.filter(log => log.address.toLowerCase() === gateway).map(log => decodeEventLog({ abi: gatewayAbi, ...log }));
      const grants = receipt.logs.filter(log => log.address.toLowerCase() === application).map(log => decodeEventLog({ abi: appAbi, ...log }));
      assert.equal(executions.length, 1); assert.equal(executions[0].eventName, "CrossChainMessageExecuted");
      assert.equal(executions[0].args.messageId, event.messageId); assert.equal(executions[0].args.batchId, committed.record.batchId);
      assert.equal(executions[0].args.sourceDomain, config.chainDomain); assert.equal(executions[0].args.destinationReceiver.toLowerCase(), application);
      assert.equal(grants.length, 1); assert.equal(grants[0].eventName, "VerifiedSupplierGranted");
      assert.equal(grants[0].args.messageId, event.messageId); assert.equal(grants[0].args.supplier.toLowerCase(), targetSupplier);
      assert.equal(await readGateway("isMessageExecuted", [event.messageId]), true);
      assert.equal(await readApp("isVerifiedSupplier", [targetSupplier]), true);
      await client.request({ method: "anvil_mine", params: [toHex(relayConfig.destinationConfirmations)] });
      // The architecture permits an independent receipt observer. Target only
      // this intent so the new closure cannot advance unrelated historical work.
      const confirmed = await observedManager.recoverTransactionsOnce({ deliveryJobId: pack.deliveryJobId });
      assert.equal(confirmed.scanned, 1); assert.equal(confirmed.finalized, 1); assert.equal(confirmed.rebroadcast, 0);
      assert.equal(confirmed.results[0].action, "FINALIZED"); assert.equal(confirmed.results[0].status, "CONFIRMED");
      const final = await manager.repository.getTransaction(pack.deliveryJobId);
      assert.equal(final.intent.status, "CONFIRMED"); assert.equal(final.attempt.status, "CONFIRMED");
      assert.equal(final.intent.winningAttemptId, original.attempt.attemptId); assert.equal(final.attempts.length, 1);
      assert.equal(final.attempt.replacementOfAttemptId, null); assert.equal(final.attempt.attemptNumber, 0);
      assert.equal(final.attempt.receiptBlockNumber, receipt.blockNumber.toString()); assert.equal(final.attempt.receiptBlockHash, receipt.blockHash);
      assert.equal(final.attempt.receiptStatus, 1); assert.equal(final.attempt.broadcastAttemptCount, "1");
      assert.ok(BigInt(final.attempt.confirmedHead) >= receipt.blockNumber + relayConfig.destinationConfirmations - 1n);
      for (const field of ["intentId", "nonce", "senderAddress", "destinationGateway", "calldata", "packageDigest", "value"]) {
        assert.ok(final.intent[field] === original.intent[field], `confirmation must preserve original intent ${field}`);
      }
      for (const field of ["attemptId", "nonce", "rawSignedTransaction", "transactionHash", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas"]) {
        assert.ok(final.attempt[field] === original.attempt[field], `confirmation must preserve original signed ${field}`);
      }
      assert.deepEqual(await manager.repository.getAccount(), takeover.accountSigned);
      assert.equal(BigInt(await client.request({ method: "eth_getTransactionCount", params: [relayConfig.relayerAddress, "pending"] })), expectedNonce + 1n);
      assert.equal(takeover.a.exited, true); assert.equal((await takeover.a.closed).signal, "SIGKILL");
      assert.equal(takeover.b.messages.filter(message => message.type === "lease").length, 1);
      const counts = (await pool.query(`SELECT
        (SELECT COUNT(*) FROM ${intents} WHERE delivery_job_id = $1)::text AS intents,
        COUNT(DISTINCT nonce)::text AS nonces,COUNT(*)::text AS attempts,
        COUNT(*) FILTER (WHERE attempt_number = 0)::text AS initial,
        COUNT(*) FILTER (WHERE replacement_of_attempt_id IS NOT NULL)::text AS replacements,
        COUNT(DISTINCT transaction_hash)::text AS hashes FROM ${attempts} WHERE delivery_job_id = $1`, [pack.deliveryJobId])).rows[0];
      assert.deepEqual(counts, { intents: "1", nonces: "1", attempts: "1", initial: "1", replacements: "0", hashes: "1" });
      await assertOneReady();
      for (const [address, abi, eventName] of [[gateway, gatewayAbi, "CrossChainMessageExecuted"], [application, appAbi, "VerifiedSupplierGranted"]]) {
        const events = await client.getContractEvents({ address, abi, eventName, args: { messageId: event.messageId }, fromBlock: 0n, toBlock: "latest", strict: true });
        assert.equal(events.length, 1); assert.equal(events[0].transactionHash, original.attempt.transactionHash);
      }
      const targetJournals = (await pool.query(`SELECT e.* FROM ${journals} e JOIN ${attempts} a USING (attempt_id)
        WHERE a.delivery_job_id = $1 ORDER BY e.event_id`, [pack.deliveryJobId])).rows;
      assert.equal(targetJournals.length, 2);
      assert.equal(targetJournals.filter(row => row.parent_event_id === null).length, 1);
      assert.equal(targetJournals.filter(row => row.parent_event_id !== null).length, 1);
      for (const row of targetJournals) {
        assert.notEqual(row.completed_at, null); assert.equal(row.result_class, "ACCEPTED");
        assert.equal(row.error_class, null); assert.equal(row.returned_tx_hash, original.attempt.transactionHash);
      }
      assert.equal(observer.calls.filter(call => call.method === "eth_sendRawTransaction").length, 1);
      assert.equal(observer.errors.length, 0);
      const repeated = await projector.materializeBatch({ batchRecordId: committed.record.batchRecordId });
      assert.equal(repeated.materialized, false); assert.equal(repeated.createdJobs, 0);
      assert.deepEqual(await lifecycle.readBatch({ batchRecordId: committed.record.batchRecordId }), committed);
      assert.deepEqual(await rowsFor([event.messageId]), sourceRows);
      for (const previous of previousBatches) assert.deepEqual(await lifecycle.readBatch({ batchRecordId: previous.record.batchRecordId }), previous);
      assert.deepEqual((await readMessages(pool, config.databaseSchema)).filter(row => previousIds.has(row.id)), previousRows);
      const afterTransport = await transportRows();
      const targetAttempts = new Set(afterTransport.attempts.filter(row => row.delivery_job_id === pack.deliveryJobId).map(row => row.attempt_id));
      for (const name of ["jobs", "intents", "attempts"]) {
        assert.ok(isDeepStrictEqual(afterTransport[name].filter(row => row.delivery_job_id !== pack.deliveryJobId), beforeTransport[name]), `historical ${name} remain unchanged`);
      }
      assert.ok(isDeepStrictEqual(afterTransport.journals.filter(row => !targetAttempts.has(row.attempt_id)), beforeTransport.journals), "historical broadcast evidence remains unchanged");
      await assertHealthyValidators();
      console.log(`VALID: Relayer B completed the persisted transaction ${receipt.transactionHash} through production Tx Manager, DestinationGateway and ApplicationB; CONFIRMED with configured canonical depth ${relayConfig.destinationConfirmations}`);
      console.log(`VALID: the target message ${event.messageId} was not lost across Relayer A process failure; A remained offline until confirmation and business execution`);
      console.log("VALID: one READY identity, one delivery intent, one nonce, one initial signed attempt, zero replacements, one canonical transaction and one business execution; source occurrence, batch/root, membership, pinned committee, QC and historical evidence unchanged");
    } catch (error) { failure = error; throw error; }
    finally {
      // Stop owned workers before their RPC observer. The outer cluster owns
      // the shared pool and validators; this closure must not close those.
      const cleanupErrors = [];
      if (relayers) try { await relayers.close(); } catch (error) { cleanupErrors.push(error); }
      if (observer) try { await observer.close(); } catch (error) { cleanupErrors.push(error); }
      if (observer) cleanupErrors.push(...observer.errors);
      if (cleanupErrors.length) throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, "relayer-failure observation or cleanup failed");
    }
  }

  async function verifyPrimaryFailure() {
    const targetSupplier = "0x0000000000000000000000000000000000009041";
    const grant = supplier => encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "address" }], [1, 1, supplier]);
    assert.equal(grant(supplier), payload);
    assert.equal(await readApp("isVerifiedSupplier", [targetSupplier]), false);
    const sourceBatches = tableName(config.databaseSchema, "message_batches");
    const certificates = tableName(config.databaseSchema, "batch_quorum_certificates");
    const projections = tableName(config.databaseSchema, "delivery_batches");
    const jobs = tableName(config.databaseSchema, "delivery_jobs");
    const intents = tableName(config.databaseSchema, "transaction_intents");
    const attempts = tableName(config.databaseSchema, "transaction_attempts");
    const journals = tableName(config.databaseSchema, "transaction_broadcast_events");
    const scope = [config.chainDomain.toString(), config.sourceGateway];
    const previousRows = await readMessages(pool, config.databaseSchema);
    const previousIds = new Set(previousRows.map(row => row.id));
    const previousBatches = [];
    for (const row of (await pool.query(`SELECT batch_record_id FROM ${sourceBatches}
      WHERE source_domain = $1 AND source_gateway = $2 ORDER BY epoch`, scope)).rows) {
      previousBatches.push(await lifecycle.readBatch({ batchRecordId: row.batch_record_id }));
    }
    async function transportEvidence() {
      return { account: await manager.repository.getAccount(),
        pendingNonce: BigInt(await client.request({ method: "eth_getTransactionCount", params: [relayConfig.relayerAddress, "pending"] })),
        intents: (await pool.query(`SELECT * FROM ${intents} ORDER BY delivery_job_id`)).rows,
        attempts: (await pool.query(`SELECT * FROM ${attempts} ORDER BY attempt_id`)).rows,
        journals: (await pool.query(`SELECT * FROM ${journals} ORDER BY event_id`)).rows };
    }
    const beforeTransport = await transportEvidence();
    assert.ok(beforeTransport.account);
    const event = await produceAndFinalize(grant(targetSupplier));
    const sealed = await sealFreshBatch([event]);
    assert.equal(sealed.record.status, "SEALED");
    const selected = validatorSets.resolveForBatchEpoch(sealed.record.epoch);
    assert.equal(selected.validators.length, 4);
    const members = selected.validators.map(address => peers.findIndex(peer => peer.address === address));
    assert.ok(members.every(index => index >= 0));
    assert.equal(new Set(members.map(index => states[index].config.databaseSchema)).size, 4);
    assert.deepEqual((await pool.query(`SELECT batch_record_id FROM ${sourceBatches}
      WHERE source_domain = $1 AND source_gateway = $2 AND status = 'CONSENSUS_PENDING'`, scope)).rows, []);

    // Configure the existing identities/stores while the new batch is still
    // SEALED. No live participant is restarted after the primary fault.
    assert.ok(Array.isArray(peerProxies), "the existing cluster must own proxy cleanup");
    const gate = createTransportGate(selected.validators);
    const links = new Map(members.map(index => [index, new Map()]));
    for (const from of members) for (const to of members) {
      if (from === to) continue;
      const proxy = await createPeerProxy({ from: peers[from].address, to: peers[to].address,
        targetUrl: peers[to].url, gate, signal: processes.signal });
      peerProxies.push(proxy); links.get(from).set(to, proxy);
    }
    for (const index of members) {
      environments[index].VALIDATOR_PEERS = JSON.stringify(peers.map((peer, to) => ({ ...peer,
        url: links.get(index).get(to)?.url ?? peer.url })));
      environments[index].PBFT_VIEW_TIMEOUT_MS = "30000";
      await processes.stop(validators[index]);
      validators[index] = await processes.start(environments[index]);
    }
    const originalPids = new Map(members.map(index => [index, validators[index].child.pid]));
    async function assertReady(indices) {
      for (const index of indices) {
        assert.equal(validators[index].exited, false);
        assert.equal(validators[index].child.pid, originalPids.get(index));
        const health = await request(index, "/health");
        assert.equal(health.status, 200); assert.equal(health.body.ready, true);
        assert.equal(health.body.pid, originalPids.get(index));
        assert.equal(health.body.validatorAddress, peers[index].address);
      }
    }
    await assertReady(members);
    const beforeMetrics = new Map(await Promise.all(members.map(async index => [index, await scrapeMetrics(peers[index].url)])));
    for (const body of beforeMetrics.values()) assert.equal(scrapeValue(body, "cross_chain_validator_available"), 1);
    const pending = await lifecycle.markConsensusPending({ batchRecordId: sealed.record.batchRecordId });
    assert.equal(pending.record.status, "CONSENSUS_PENDING");
    assert.equal(pending.consensusBinding.protocolVersion, "3");
    assert.equal(pending.consensusBinding.validatorEpoch, selected.validatorEpoch);
    assert.equal(pending.consensusBinding.committeeDigest, selected.committeeDigest);
    assert.deepEqual(validatorSets.resolveByValidatorEpoch(pending.consensusBinding.validatorEpoch), selected);
    const registered = await until("all four validators registered the primary-failure batch", async () => {
      const views = await Promise.all(members.map(index => states[index].store.readViewState(pending.record.epoch)));
      return views.every(Boolean) ? views : null;
    }, members);
    const oldView = registered[0].current_view;
    assert.equal(oldView, "0");
    const newView = (BigInt(oldView) + 1n).toString();
    const oldPrimaryAddress = deterministicPrimary(selected.validators, pending.record.epoch, oldView);
    const oldPrimary = peers.findIndex(peer => peer.address === oldPrimaryAddress);
    const live = members.filter(index => index !== oldPrimary);
    assert.ok(members.includes(oldPrimary)); assert.equal(live.length, 3);
    const liveAddresses = live.map(index => peers[index].address).sort();
    const recipient = live[0];
    const blocked = live.slice(1);
    const newPrimaryAddress = deterministicPrimary(selected.validators, pending.record.epoch, newView);
    const newPrimary = peers.findIndex(peer => peer.address === newPrimaryAddress);
    assert.notEqual(newPrimary, oldPrimary); assert.ok(live.includes(newPrimary));
    const oldStatement = expectedCommitStatement({ ...pending.consensusBinding, view: oldView,
      sourceDomain: config.chainDomain, sourceGateway: config.sourceGateway, epoch: pending.record.epoch,
      batchId: pending.record.batchId, messageRoot: pending.tree.messageRoot }, { peers, validatorSets });
    const canonical = proposalIdentity(oldStatement);
    function assertContext(state, view) {
      assert.equal(state.epoch, oldStatement.epoch); assert.equal(state.batch_id, oldStatement.batchId);
      assert.equal(state.message_root, oldStatement.messageRoot); assert.equal(state.protocol_version, 3);
      assert.equal(state.validator_epoch, selected.validatorEpoch); assert.equal(state.committee_digest, selected.committeeDigest);
      assert.equal(state.current_view, view); assert.equal(state.target_view, view); assert.equal(state.changing_view, false);
    }
    for (const state of registered) { assertContext(state, oldView); assert.equal(state.finalized, false); }
    console.log(`VALID: primary-failure message ${event.messageId}, batch ${oldStatement.batchId}, batch epoch ${oldStatement.epoch}, validator epoch ${selected.validatorEpoch}, committee digest ${selected.committeeDigest}, canonical root ${oldStatement.messageRoot}; pinned members ${selected.validators.join(", ")}; quorum 3; old view ${oldView}, primary ${oldPrimaryAddress}, next view ${newView}, primary ${newPrimaryAddress}`);
    for (const to of blocked) gate.blockRoute(oldPrimaryAddress, peers[to].address, "/pbft/pre-prepare");
    const proposed = await request(oldPrimary, "/pbft/propose", { batchId: oldStatement.batchId });
    assert.equal(proposed.status, 200); assert.equal(proposed.body.result, "ACCEPTED");
    assert.equal(proposed.body.proposalDigest, oldStatement.proposalDigest);
    assert.equal(proposed.body.deliveries.length, 3);
    for (const to of live) {
      const delivery = proposed.body.deliveries.find(entry => entry.peerAddress === peers[to].address);
      assert.ok(delivery);
      assert.equal(delivery.delivery, to === recipient ? "DELIVERED" : "FAILED");
      if (to === recipient) assert.equal(delivery.result, "ACCEPTED");
      const records = links.get(oldPrimary).get(to).records.filter(record => record.route === "/pbft/pre-prepare");
      assert.equal(records.length, 1);
      assert.equal(records[0].delivery, to === recipient ? "FORWARDED" : "BLOCKED");
    }
    const oldLocks = new Map();
    for (const index of members) {
      const accepted = await states[index].store.readPrePrepare(oldStatement.epoch, oldView);
      if (index === oldPrimary || index === recipient) {
        assert.ok(accepted);
        assert.equal(accepted.envelope.proposalDigest, oldStatement.proposalDigest);
        assert.equal(accepted.envelope.messageRoot, oldStatement.messageRoot);
        await authenticatePrePrepare(states[index].config, accepted.envelope);
      } else assert.equal(accepted, null);
      oldLocks.set(index, accepted);
      assertContext(await states[index].store.readViewState(oldStatement.epoch), oldView);
      assert.deepEqual(await states[index].store.readViewChanges(oldStatement.epoch, newView), []);
    }
    const oldProposal = oldLocks.get(oldPrimary).envelope;
    async function assertOldViewIncomplete() {
      for (const index of members) {
        assert.deepEqual(await states[index].store.readPrePrepare(oldStatement.epoch, oldView), oldLocks.get(index));
        const prepares = await states[index].store.readPrepareState(oldStatement.epoch, oldView);
        const commits = await states[index].store.readCommitState(oldStatement.epoch, oldView);
        assert.equal(prepares.voteCount, 0); assert.equal(prepares.prepared, null);
        assert.equal(commits.voteCount, 0); assert.equal(commits.quorum, null); assert.equal(commits.certificate, null);
      }
    }
    await assertReady(members); await assertOldViewIncomplete();
    assert.deepEqual(await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId }), pending);
    assert.ok(isDeepStrictEqual(await transportEvidence(), beforeTransport), "incomplete old view must not allocate transaction authority");
    assert.deepEqual((await pool.query(`SELECT batch_record_id FROM ${projections}
      WHERE source_domain = $1 AND source_gateway = $2 AND batch_epoch = $3`, [...scope, oldStatement.epoch])).rows, []);
    const offlineStore = states[oldPrimary].store;
    const offlinePool = states[oldPrimary].pool;
    const offlineSchema = states[oldPrimary].config.databaseSchema;
    async function primaryEvidence() {
      return { view: await offlineStore.readViewState(oldStatement.epoch),
        proposal: await offlineStore.readPrePrepare(oldStatement.epoch, oldView),
        prepares: await offlineStore.readPrepareState(oldStatement.epoch, oldView),
        commits: await offlineStore.readCommitState(oldStatement.epoch, oldView),
        viewChanges: await offlineStore.readViewChanges(oldStatement.epoch, newView),
        newView: await offlineStore.readNewView(oldStatement.epoch, newView),
        metadata: (await offlinePool.query(`SELECT * FROM ${tableName(offlineSchema, "validator_metadata")} WHERE singleton = true`)).rows,
        history: (await offlinePool.query(`SELECT * FROM ${tableName(offlineSchema, "validator_set_history")} ORDER BY validator_epoch`)).rows };
    }
    const beforeStop = await primaryEvidence();
    assertContext(beforeStop.view, oldView); assert.equal(beforeStop.view.finalized, false);
    const stopped = validators[oldPrimary];
    try { await processes.stop(stopped); }
    finally { gate.heal(); }
    async function assertOffline() {
      assert.equal(validators[oldPrimary], stopped); assert.equal(stopped.exited, true);
      const exit = await stopped.closed;
      assert.ok(exit.code === 0 || exit.signal === "SIGTERM" || exit.signal === "SIGKILL");
      await assertReady(live);
      assert.equal(members.filter(index => !validators[index].exited).length, 3);
      assert.deepEqual(await primaryEvidence(), beforeStop);
      for (const state of states) {
        const schema = state.config.databaseSchema;
        const predicate = "local_validator_identity = $1 AND epoch = $2 AND validator_epoch = $3 AND voter_identity = $4 AND protocol_version = 3";
        const counts = (await state.pool.query(`SELECT
          (SELECT COUNT(*) FROM ${tableName(schema, "pbft_prepare_votes")} WHERE ${predicate} AND batch_id = $5 AND view IN ($6,$7))::text AS prepares,
          (SELECT COUNT(*) FROM ${tableName(schema, "pbft_commit_votes")} WHERE ${predicate} AND batch_id = $5 AND view IN ($6,$7))::text AS commits,
          (SELECT COUNT(*) FROM ${tableName(schema, "pbft_view_change_votes")} WHERE ${predicate} AND target_view = $7)::text AS view_changes`,
        [state.config.validatorAddress, oldStatement.epoch, selected.validatorEpoch, oldPrimaryAddress,
          oldStatement.batchId, oldView, newView])).rows[0];
        assert.deepEqual(counts, { prepares: "0", commits: "0", view_changes: "0" });
      }
    }
    await assertOffline();
    await assert.rejects(() => request(oldPrimary, "/health"), error => error.cause?.code === "ECONNREFUSED");
    await assert.rejects(() => scrapeMetrics(peers[oldPrimary].url), error => error.cause?.code === "ECONNREFUSED");
    for (const index of live) assert.equal(scrapeValue(await scrapeMetrics(peers[index].url), "cross_chain_validator_available"), 1);
    console.log("VALID: ready validators expose availability=1; stopped validator availability is represented by scrape-target loss rather than committee mutation");
    await assertOldViewIncomplete();
    assert.deepEqual(await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId }), pending);
    console.log(`VALID: deterministic primary ${oldPrimaryAddress}, PID ${stopped.child.pid}, endpoint ${peers[oldPrimary].url}, store ${offlineSchema} stopped after durable PRE-PREPARE reached only backup ${peers[recipient].address}; view ${oldView} has zero PREPARE/COMMIT votes or QC; proposal locks and store preserved; gate healed and exactly three members remain ready`);
    for (const index of live) {
      const selection = await request(index, "/pbft/primary", { epoch: oldStatement.epoch, view: newView });
      assert.equal(selection.status, 200); assert.equal(selection.body.primaryIdentity, newPrimaryAddress);
      assert.equal(selection.body.validatorEpoch, selected.validatorEpoch);
      assert.equal(selection.body.committeeDigest, selected.committeeDigest);
      assert.deepEqual(selection.body.committee, selected.validators);
    }
    console.log("Waiting for real protocol progress timeout (30000 ms base), signed VIEW_CHANGE quorum and automatic higher-view consensus; no manual view or vote mutation");
    const committed = await until("primary failover and automatic higher-view COMMITTED", async () => {
      assert.equal(stopped.exited, true);
      const snapshot = await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId });
      return snapshot.record.status === "COMMITTED" ? snapshot : null;
    }, live, 90000);
    assert.equal(committed.quorumCertificate.view, newView);
    assert.deepEqual(committed.consensusBinding, pending.consensusBinding);
    assert.deepEqual(committed.batch, pending.batch); assert.deepEqual(committed.members, pending.members);
    assert.deepEqual(committed.tree, pending.tree);
    const newStatement = expectedCommitStatement({ ...oldStatement, view: newView, proposalDigest: undefined }, { peers, validatorSets });
    const qc = await verifyQuorumCertificate(committed.quorumCertificate, { peers, validatorSets, expected: newStatement });
    assert.deepEqual(qc, committed.quorumCertificate); assert.equal(qc.commits.length, 3);
    assert.deepEqual(qc.commits.map(vote => vote.voterIdentity).sort(), liveAddresses);
    await until("three live validators finalized in the certified higher view", async () => {
      const views = await Promise.all(live.map(index => states[index].store.readViewState(oldStatement.epoch)));
      return views.every(state => state?.current_view === newView && state.finalized) ? views : null;
    }, live);
    const established = await states[newPrimary].store.readNewView(oldStatement.epoch, newView);
    for (const index of live) {
      const body = await scrapeMetrics(peers[index].url); const before = beforeMetrics.get(index);
      for (const name of ["cross_chain_pbft_view_changes_total", "cross_chain_pbft_quorum_failures_total"]) {
        assert.equal(scrapeValue(body, name), scrapeValue(before, name) + 1);
      }
      const oldRoundCount = scrapeValue(body, "cross_chain_pbft_round_duration_seconds_count", { outcome: "view_change" });
      assert.equal(oldRoundCount, scrapeValue(before, "cross_chain_pbft_round_duration_seconds_count", { outcome: "view_change" }) + (index === recipient ? 1 : 0));
    }
    console.log("VALID: the deterministic primary-failure scenario records the real certified view transition and one failed old-view quorum without changing PBFT safety");
    assert.ok(established);
    assert.equal(established.primaryIdentity, newPrimaryAddress); assert.equal(established.viewChanges.length, 3);
    assert.deepEqual(established.viewChanges.map(vote => vote.voterIdentity).sort(), liveAddresses);
    const quorumNodes = [];
    for (const index of live) {
      const current = await states[index].store.readViewState(oldStatement.epoch);
      assertContext(current, newView); assert.equal(current.finalized, true);
      const acceptedView = await states[index].store.readNewView(oldStatement.epoch, newView);
      assert.deepEqual(await authenticateNewView(states[index].config, acceptedView, canonical), established);
      assert.deepEqual(acceptedView.selectedProposal, canonical);
      const ownIntent = (await states[index].store.readViewChanges(oldStatement.epoch, newView))
        .find(vote => vote.voterIdentity === peers[index].address);
      assert.ok(ownIntent);
      assert.deepEqual(await authenticateViewChange(states[index].config, ownIntent), ownIntent);
      assert.deepEqual(ownIntent, established.viewChanges.find(vote => vote.voterIdentity === peers[index].address));
      assert.equal(ownIntent.targetView, newView); assert.equal(ownIntent.preparedCertificate, null);
      assert.deepEqual(ownIntent.acceptedProposal, oldLocks.get(index)?.envelope ?? null);
      const accepted = await states[index].store.readPrePrepare(oldStatement.epoch, newView);
      assert.ok(accepted);
      await authenticatePrePrepare(states[index].config, accepted.envelope);
      assert.equal(accepted.envelope.primaryIdentity, newPrimaryAddress);
      for (const [field, value] of Object.entries(newStatement)) assert.equal(accepted.envelope[field], value);
      const prepared = await states[index].store.readPrepareState(oldStatement.epoch, newView);
      const commits = await states[index].store.readCommitState(oldStatement.epoch, newView);
      assert.equal(prepared.voteCount, 3); assert.ok(prepared.prepared);
      assert.deepEqual(prepared.votes.map(vote => vote.voterIdentity).sort(), liveAddresses);
      assert.deepEqual([...prepared.prepared.quorumVoters].sort(), liveAddresses);
      // An early COMMIT may reach a peer before its local PREPARED boundary.
      // Finality does not backfill that peer's missing received vote. Require
      // each genuine self-vote and an actual persisted quorum at its producer.
      assert.ok(commits.voteCount >= 1 && commits.voteCount <= 3);
      const ownCommit = commits.votes.find(vote => vote.voterIdentity === peers[index].address);
      assert.ok(ownCommit);
      assert.deepEqual(ownCommit, qc.commits.find(vote => vote.voterIdentity === peers[index].address));
      if (commits.certificate) {
        assert.equal(commits.voteCount, 3);
        assert.deepEqual(commits.votes.map(vote => vote.voterIdentity).sort(), liveAddresses);
        assert.deepEqual([...commits.quorum.quorumVoters].sort(), liveAddresses);
        assert.deepEqual(commits.certificate, qc);
        quorumNodes.push(peers[index].address);
      }
      for (const vote of [...prepared.votes, ...commits.votes]) {
        for (const [field, value] of Object.entries(newStatement)) assert.equal(vote[field], value);
        assert.ok(liveAddresses.includes(vote.voterIdentity));
      }
    }
    assert.ok(quorumNodes.length > 0, "the final QC must originate from real durable COMMIT quorum evidence");
    await assertOffline(); await assertOldViewIncomplete();
    await registryChecks.assertQcBinding(qc);
    await certificateChecks.snapshot(committed, "real primary failover QC binds the higher view and unchanged pinned canonical root");
    const stale = await request(live[0], "/pbft/pre-prepare", oldProposal);
    assert.equal(stale.status, 422); assert.equal(stale.body.reason, "STALE_VIEW");
    console.log(`EXPECTED FAILURE: authentic cached old-primary PRE-PREPARE from view ${oldView} returned STALE_VIEW after durable view ${newView}; old locks and final QC unchanged`);
    console.log(`VALID: genuine durable VIEW_CHANGE signers ${liveAddresses.join(", ")} formed quorum 3; same-committee primary ${newPrimaryAddress} issued independently verified NEW_VIEW ${newView}, preserving batch/root ${canonical.batchId}/${canonical.messageRoot} with no fabricated prepared certificate`);
    console.log(`VALID: three live PREPARE/COMMIT voters formed QC ${qc.qcDigest} in view ${newView}; durable COMMIT quorum at ${quorumNodes.join(", ")}; old primary contributed no new vote and remained offline; validator epoch ${qc.validatorEpoch} and committee digest ${qc.committeeDigest} unchanged`);
    async function assertOneCommittedRoot() {
      const context = [...scope, oldStatement.epoch];
      const roots = (await pool.query(`SELECT batch_record_id,batch_id,message_root FROM ${sourceBatches}
        WHERE source_domain = $1 AND source_gateway = $2 AND epoch = $3 AND status = 'COMMITTED'`, context)).rows;
      assert.deepEqual(roots, [{ batch_record_id: pending.record.batchRecordId, batch_id: canonical.batchId, message_root: canonical.messageRoot }]);
      const qcs = (await pool.query(`SELECT batch_id,message_root,protocol_version,validator_epoch,committee_digest,view,qc_digest
        FROM ${certificates} WHERE source_domain = $1 AND source_gateway = $2 AND epoch = $3`, context)).rows;
      assert.deepEqual(qcs, [{ batch_id: canonical.batchId, message_root: canonical.messageRoot, protocol_version: 3,
        validator_epoch: selected.validatorEpoch, committee_digest: selected.committeeDigest, view: newView, qc_digest: qc.qcDigest }]);
      assert.deepEqual(await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId }), committed);
    }
    await assertOneCommittedRoot();
    console.log(`VALID: protected source ${canonical.sourceDomain}/${canonical.sourceGateway}, batch epoch ${canonical.epoch} has exactly one durable committed root ${canonical.messageRoot} and one final QC in view ${newView}; old-view QC absent`);
    const projected = await projector.materializeBatch({ batchRecordId: committed.record.batchRecordId });
    assert.equal(projected.createdJobs, 1);
    const [pack] = await buildDeliveryPackages(committed, { validatorSets });
    assert.equal(pack.message.messageId, event.messageId); assert.equal(pack.messageRoot, canonical.messageRoot);
    assert.deepEqual(pack.quorumCertificate, qc); assert.equal(pack.quorumCertificate.view, newView);
    assert.equal((await queue.getDeliveryJob(pack.deliveryJobId)).status, "READY");
    assert.equal(await readGateway("isMessageExecuted", [event.messageId]), false);
    const encoded = await encodeGatewaySubmission(pack, { validatorSets });
    await worker.submitJob(pack.deliveryJobId);
    const sent = await manager.repository.getTransaction(pack.deliveryJobId);
    assert.equal(sent.attempts.length, 1);
    const receipt = await client.waitForTransactionReceipt({ hash: sent.attempt.transactionHash });
    assert.equal(receipt.status, "success");
    const transaction = await client.getTransaction({ hash: receipt.transactionHash });
    assert.equal(transaction.to.toLowerCase(), gateway); assert.equal(transaction.value, 0n);
    assert.equal(transaction.input, encoded.calldata); assert.equal(sent.intent.packageDigest, encoded.packageDigest);
    const reserved = BigInt(beforeTransport.account.nextNonce);
    const expectedNonce = reserved > beforeTransport.pendingNonce ? reserved : beforeTransport.pendingNonce;
    assert.equal(BigInt(sent.intent.nonce), expectedNonce); assert.equal(BigInt(transaction.nonce), expectedNonce);
    const executions = receipt.logs.filter(log => log.address.toLowerCase() === gateway).map(log => decodeEventLog({ abi: gatewayAbi, ...log }));
    const grants = receipt.logs.filter(log => log.address.toLowerCase() === application).map(log => decodeEventLog({ abi: appAbi, ...log }));
    assert.equal(executions.length, 1); assert.equal(executions[0].eventName, "CrossChainMessageExecuted");
    assert.equal(executions[0].args.messageId, event.messageId); assert.equal(executions[0].args.batchId, canonical.batchId);
    assert.equal(executions[0].args.sourceDomain, config.chainDomain); assert.equal(executions[0].args.destinationReceiver.toLowerCase(), application);
    assert.equal(grants.length, 1); assert.equal(grants[0].eventName, "VerifiedSupplierGranted");
    assert.equal(grants[0].args.messageId, event.messageId); assert.equal(grants[0].args.supplier.toLowerCase(), targetSupplier);
    assert.equal(await readGateway("isMessageExecuted", [event.messageId]), true);
    assert.equal(await readApp("isVerifiedSupplier", [targetSupplier]), true);
    await client.request({ method: "anvil_mine", params: [toHex(relayConfig.destinationConfirmations)] });
    await manager.checkReceiptsOnce();
    assert.equal((await manager.repository.getTransaction(pack.deliveryJobId)).intent.status, "CONFIRMED");
    await assertOffline(); await assertOldViewIncomplete(); await assertOneCommittedRoot();
    const targetJobs = (await pool.query(`SELECT j.delivery_job_id,j.message_id,d.message_root,q.view
      FROM ${jobs} j JOIN ${projections} d USING (batch_record_id) JOIN ${certificates} q USING (batch_record_id)
      WHERE d.source_domain = $1 AND d.source_gateway = $2 AND d.batch_epoch = $3`, [...scope, canonical.epoch])).rows;
    assert.deepEqual(targetJobs, [{ delivery_job_id: pack.deliveryJobId, message_id: event.messageId,
      message_root: canonical.messageRoot, view: newView }]);
    for (const [address, abi, eventName] of [[gateway, gatewayAbi, "CrossChainMessageExecuted"], [application, appAbi, "VerifiedSupplierGranted"]]) {
      assert.equal((await client.getContractEvents({ address, abi, eventName, args: { messageId: event.messageId },
        fromBlock: 0n, toBlock: "latest", strict: true })).length, 1);
    }
    const afterTransport = await transportEvidence();
    assert.equal(afterTransport.pendingNonce, expectedNonce + 1n);
    assert.equal(BigInt(afterTransport.account.nextNonce), expectedNonce + 1n);
    const targetAttempts = afterTransport.attempts.filter(row => row.delivery_job_id === pack.deliveryJobId);
    assert.equal(targetAttempts.length, 1);
    assert.equal(afterTransport.intents.filter(row => row.delivery_job_id === pack.deliveryJobId).length, 1);
    const targetAttemptIds = new Set(targetAttempts.map(row => row.attempt_id));
    assert.ok(isDeepStrictEqual(afterTransport.intents.filter(row => row.delivery_job_id !== pack.deliveryJobId), beforeTransport.intents), "historical transaction intents remain unchanged");
    assert.ok(isDeepStrictEqual(afterTransport.attempts.filter(row => row.delivery_job_id !== pack.deliveryJobId), beforeTransport.attempts), "historical signed Ethereum transaction bytes remain unchanged");
    assert.ok(isDeepStrictEqual(afterTransport.journals.filter(row => !targetAttemptIds.has(row.attempt_id)), beforeTransport.journals), "historical broadcast evidence remains unchanged");
    assert.deepEqual((await readMessages(pool, config.databaseSchema)).filter(row => previousIds.has(row.id)), previousRows);
    for (const previous of previousBatches) assert.deepEqual(await lifecycle.readBatch({ batchRecordId: previous.record.batchRecordId }), previous);
    console.log(`VALID: primary failover completed one READY job ${pack.deliveryJobId}, higher-view production Relayer/Tx Manager transaction ${receipt.transactionHash}, CONFIRMED Gateway/ApplicationB execution for ${event.messageId}; exactly one nonce/intent/attempt/business event; original primary stayed offline without restart`);
    console.log("VALID: source-reorg, non-primary recovery and Byzantine historical evidence preserved; one controlled primary failure, genuine timeout/view-change recovery, unchanged canonical root/committee and no duplicate destination authority");
  }

  async function verifyByzantineSafety() {
    const targetSupplier = "0x0000000000000000000000000000000000009031";
    const grant = supplier => encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "address" }], [1, 1, supplier]);
    assert.equal(grant(supplier), payload);
    assert.equal(await readApp("isVerifiedSupplier", [targetSupplier]), false);
    const sourceBatches = tableName(config.databaseSchema, "message_batches");
    const certificates = tableName(config.databaseSchema, "batch_quorum_certificates");
    const projections = tableName(config.databaseSchema, "delivery_batches");
    const jobs = tableName(config.databaseSchema, "delivery_jobs");
    const attempts = tableName(config.databaseSchema, "transaction_attempts");
    const intents = tableName(config.databaseSchema, "transaction_intents");
    const journals = tableName(config.databaseSchema, "transaction_broadcast_events");
    const scope = [config.chainDomain.toString(), config.sourceGateway];
    const previousRows = await readMessages(pool, config.databaseSchema);
    const previousIds = new Set(previousRows.map(row => row.id));
    const previousBatches = [];
    for (const row of (await pool.query(`SELECT batch_record_id FROM ${sourceBatches}
      WHERE source_domain = $1 AND source_gateway = $2 ORDER BY epoch`, scope)).rows) {
      previousBatches.push(await lifecycle.readBatch({ batchRecordId: row.batch_record_id }));
    }
    async function transportEvidence() {
      return { account: await manager.repository.getAccount(),
        pendingNonce: BigInt(await client.request({ method: "eth_getTransactionCount", params: [relayConfig.relayerAddress, "pending"] })),
        intents: (await pool.query(`SELECT * FROM ${intents} ORDER BY delivery_job_id`)).rows,
        attempts: (await pool.query(`SELECT * FROM ${attempts} ORDER BY attempt_id`)).rows,
        journals: (await pool.query(`SELECT * FROM ${journals} ORDER BY event_id`)).rows };
    }
    const beforeTransport = await transportEvidence();
    assert.ok(beforeTransport.account);
    const event = await produceAndFinalize(grant(targetSupplier));
    const pending = await prepareFreshBatch([event]);
    assert.equal(pending.record.status, "CONSENSUS_PENDING");
    assert.equal(pending.consensusBinding.protocolVersion, "3");
    const selected = validatorSets.resolveByValidatorEpoch(pending.consensusBinding.validatorEpoch);
    assert.equal(selected.validatorEpoch, validatorSets.resolveForBatchEpoch(pending.record.epoch).validatorEpoch);
    assert.equal(selected.committeeDigest, pending.consensusBinding.committeeDigest);
    assert.equal(selected.validators.length, 4);
    const members = selected.validators.map(address => peers.findIndex(peer => peer.address === address));
    assert.ok(members.every(index => index >= 0));
    assert.equal(new Set(members.map(index => states[index].config.databaseSchema)).size, 4);
    const originalPids = new Map(members.map(index => [index, validators[index].child.pid]));
    async function assertReady() {
      for (const index of members) {
        assert.equal(validators[index].exited, false);
        assert.equal(validators[index].child.pid, originalPids.get(index));
        const health = await request(index, "/health");
        assert.equal(health.status, 200); assert.equal(health.body.ready, true);
        assert.equal(health.body.pid, originalPids.get(index));
        assert.equal(health.body.validatorAddress, peers[index].address);
      }
    }
    await assertReady();
    const registered = await until("all four validators registered the Byzantine target batch", async () => {
      const views = await Promise.all(members.map(index => states[index].store.readViewState(pending.record.epoch)));
      return views.every(Boolean) ? views : null;
    }, members);
    const view = registered[0].current_view;
    assert.equal(view, "0", "an honest available primary must not need a view change here");
    const primaryAddress = deterministicPrimary(selected.validators, pending.record.epoch, view);
    const primary = peers.findIndex(peer => peer.address === primaryAddress);
    const adversaryAddress = selected.validators.find(address => address !== primaryAddress);
    const adversary = peers.findIndex(peer => peer.address === adversaryAddress);
    const honest = members.filter(index => index !== adversary);
    assert.ok(members.includes(adversary)); assert.notEqual(adversary, primary);
    assert.equal(honest.length, 3); assert.ok(honest.includes(primary));
    const honestAddresses = honest.map(index => peers[index].address).sort();
    const statement = expectedCommitStatement({ ...pending.consensusBinding, view,
      sourceDomain: config.chainDomain, sourceGateway: config.sourceGateway, epoch: pending.record.epoch,
      batchId: pending.record.batchId, messageRoot: pending.tree.messageRoot }, { peers, validatorSets });
    function assertContext(state) {
      assert.equal(state.epoch, statement.epoch); assert.equal(state.batch_id, statement.batchId);
      assert.equal(state.message_root, statement.messageRoot); assert.equal(state.protocol_version, 3);
      assert.equal(state.validator_epoch, statement.validatorEpoch); assert.equal(state.committee_digest, statement.committeeDigest);
      assert.equal(state.current_view, view); assert.equal(state.target_view, view); assert.equal(state.changing_view, false);
    }
    for (const state of registered) { assertContext(state); assert.equal(state.finalized, false); }
    console.log(`VALID: Byzantine target ${statement.batchId} is CONSENSUS_PENDING; source ${statement.sourceDomain}/${statement.sourceGateway}, batch epoch ${statement.epoch}, validator epoch ${statement.validatorEpoch}, view ${view}; canonical root ${statement.messageRoot}; committee digest ${statement.committeeDigest}; four pinned members ${selected.validators.join(", ")}; quorum 3`);
    console.log(`VALID: canonical-first non-primary Byzantine member ${adversaryAddress}, PID ${originalPids.get(adversary)}, endpoint ${peers[adversary].url}; honest primary ${primaryAddress}; three honest members ${honestAddresses.join(", ")}; all four processes stay online`);
    const proposed = await request(primary, "/pbft/propose", { batchId: statement.batchId });
    assert.equal(proposed.status, 200); assert.equal(proposed.body.result, "ACCEPTED");
    assert.equal(proposed.body.proposalDigest, statement.proposalDigest);
    const locks = new Map();
    for (const index of members) {
      const accepted = await states[index].store.readPrePrepare(statement.epoch, view);
      assert.ok(accepted); assert.equal(accepted.envelope.messageRoot, statement.messageRoot);
      assert.equal(accepted.envelope.proposalDigest, statement.proposalDigest);
      assert.equal(accepted.envelope.primaryIdentity, primaryAddress);
      locks.set(index, accepted);
      assert.ok((await states[index].store.readObservations()).some(row => row.batch_id === statement.batchId && row.result === "VALID"));
    }
    async function assertLocks() {
      await assertReady();
      for (const index of members) {
        assert.deepEqual(await states[index].store.readPrePrepare(statement.epoch, view), locks.get(index));
        assertContext(await states[index].store.readViewState(statement.epoch));
      }
    }
    async function reject(index, route, input, reason) {
      const response = await request(index, route, input);
      assert.equal(response.status, 422); assert.equal(response.body.validatorAddress, peers[index].address);
      assert.equal(response.body.result, "REJECTED"); assert.equal(response.body.reason, reason);
    }
    async function assertWeights(prepareVoters, commitVoters) {
      const expectedPrepares = prepareVoters.map(index => peers[index].address).sort();
      const expectedCommits = commitVoters.map(index => peers[index].address).sort();
      for (const index of members) {
        const prepared = await states[index].store.readPrepareState(statement.epoch, view);
        const committed = await states[index].store.readCommitState(statement.epoch, view);
        assert.equal(prepared.voteCount, prepareVoters.length); assert.equal(committed.voteCount, commitVoters.length);
        assert.deepEqual(prepared.votes.map(vote => vote.voterIdentity).sort(), expectedPrepares);
        assert.deepEqual(committed.votes.map(vote => vote.voterIdentity).sort(), expectedCommits);
        assert.equal(prepared.prepared !== null, prepareVoters.length === 3);
        assert.equal(committed.quorum !== null, commitVoters.length === 3);
        assert.equal(committed.certificate !== null, commitVoters.length === 3);
        if (prepared.prepared) assert.deepEqual([...prepared.prepared.quorumVoters].sort(), honestAddresses);
        if (committed.quorum) assert.deepEqual([...committed.quorum.quorumVoters].sort(), honestAddresses);
        for (const vote of [...prepared.votes, ...committed.votes]) {
          for (const [field, value] of Object.entries(statement)) assert.equal(vote[field], value);
          assert.ok(honestAddresses.includes(vote.voterIdentity));
        }
      }
    }
    async function assertDurableAuthority(isCommitted, isProjected = false) {
      await assertLocks();
      const context = [...scope, statement.epoch];
      const rows = (await pool.query(`SELECT batch_record_id,batch_id,message_root,status FROM ${sourceBatches}
        WHERE source_domain = $1 AND source_gateway = $2 AND epoch = $3`, context)).rows;
      assert.deepEqual(rows, [{ batch_record_id: pending.record.batchRecordId, batch_id: statement.batchId,
        message_root: statement.messageRoot, status: isCommitted ? "COMMITTED" : "CONSENSUS_PENDING" }]);
      const rootCount = (await pool.query(`SELECT COUNT(DISTINCT message_root)::text AS count FROM ${sourceBatches}
        WHERE source_domain = $1 AND source_gateway = $2 AND epoch = $3 AND status = 'COMMITTED'`, context)).rows[0].count;
      assert.equal(rootCount, isCommitted ? "1" : "0");
      const qcs = (await pool.query(`SELECT batch_id,message_root,protocol_version,validator_epoch,view,committee_digest,qc_digest
        FROM ${certificates} WHERE source_domain = $1 AND source_gateway = $2 AND epoch = $3`, context)).rows;
      assert.deepEqual(qcs, isCommitted ? [{ batch_id: statement.batchId, message_root: statement.messageRoot,
        protocol_version: 3, validator_epoch: statement.validatorEpoch, view, committee_digest: statement.committeeDigest,
        qc_digest: qcDigest(statement) }] : []);
      const projected = (await pool.query(`SELECT batch_record_id,batch_id,message_root,validator_epoch,committee_digest,qc_digest
        FROM ${projections} WHERE source_domain = $1 AND source_gateway = $2 AND batch_epoch = $3`, context)).rows;
      assert.deepEqual(projected, isProjected ? [{ batch_record_id: pending.record.batchRecordId,
        batch_id: statement.batchId, message_root: statement.messageRoot, validator_epoch: statement.validatorEpoch,
        committee_digest: statement.committeeDigest, qc_digest: qcDigest(statement) }] : []);
      for (const state of states) {
        // Read the complete protected epoch, then inspect each binding/view/root.
        // Filtering by the expected root would hide exactly the evidence under attack.
        const schema = state.config.databaseSchema;
        const references = (await state.pool.query(["pbft_epoch_views", "pbft_pre_prepares", "pbft_prepare_votes", "pbft_prepared_states",
          "pbft_commit_votes", "pbft_commit_quorums"].map(name =>
          `SELECT batch_id,message_root,protocol_version,validator_epoch,committee_digest,${name === "pbft_epoch_views" ? "current_view" : "view"} AS view FROM ${tableName(schema, name)}
            WHERE local_validator_identity = $1 AND epoch = $2`).join(" UNION ALL "),
        [state.config.validatorAddress, statement.epoch])).rows;
        for (const row of references) assert.deepEqual(row, { batch_id: statement.batchId, message_root: statement.messageRoot,
          protocol_version: 3, validator_epoch: statement.validatorEpoch, committee_digest: statement.committeeDigest, view });
        const predicate = "local_validator_identity = $1 AND epoch = $2 AND batch_id = $3 AND validator_epoch = $4 AND view = $5 AND voter_identity = $6 AND protocol_version = 3";
        const counts = (await state.pool.query(`SELECT
          (SELECT COUNT(*) FROM ${tableName(schema, "pbft_prepare_votes")} WHERE ${predicate})::text AS prepares,
          (SELECT COUNT(*) FROM ${tableName(schema, "pbft_commit_votes")} WHERE ${predicate})::text AS commits`,
        [state.config.validatorAddress, statement.epoch, statement.batchId, statement.validatorEpoch, view, adversaryAddress])).rows[0];
        assert.deepEqual(counts, { prepares: "0", commits: "0" });
      }
    }
    await assertWeights([], []);
    // Reuse the existing adversarial signer with ONLY this member's own key.
    const signingContext = { peers, keys: { [adversary]: environments[adversary].VALIDATOR_PRIVATE_KEY } };
    const roots = [1n, 2n].map(mask => `0x${(BigInt(statement.messageRoot) ^ mask).toString(16).padStart(64, "0")}`);
    assert.equal(new Set([statement.messageRoot, ...roots]).size, 3);
    const badStatements = roots.map(messageRoot => expectedCommitStatement({ ...statement, messageRoot,
      proposalDigest: undefined }, { peers, validatorSets }));
    const badProposal = await signAdversarial(signingContext, adversary, { messageType: "PRE_PREPARE",
      protocolVersion: "3", sourceDomain: statement.sourceDomain, sourceGateway: statement.sourceGateway,
      epoch: statement.epoch, view, validatorEpoch: statement.validatorEpoch, committeeDigest: statement.committeeDigest,
      batchId: statement.batchId, messageRoot: roots[0], primaryIdentity: adversaryAddress }, prePrepareDigest);
    for (const index of honest) await reject(index, "/pbft/pre-prepare", badProposal, "WRONG_PRIMARY");
    await assertLocks(); await assertWeights([], []);
    console.log(`EXPECTED FAILURE: genuine Byzantine PRE-PREPARE from ${adversaryAddress} rejected by every honest member with WRONG_PRIMARY; canonical proposal locks unchanged`);
    const badPrepares = [];
    const badCommits = [];
    for (const bad of badStatements) {
      const prepare = await signAdversarial(signingContext, adversary,
        { messageType: "PREPARE", ...bad, voterIdentity: adversaryAddress }, prepareDigest);
      const commit = await signAdversarial(signingContext, adversary,
        { messageType: "COMMIT", ...bad, voterIdentity: adversaryAddress }, commitDigest);
      // Prove valid recovered membership/signatures separately from rejection
      // by the receiving process's canonical proposal and PREPARED state.
      assert.deepEqual(await authenticatePrepare(states[honest[0]].config, prepare), prepare);
      assert.deepEqual(await authenticateCommit(states[honest[0]].config, commit), commit);
      badPrepares.push(prepare); badCommits.push(commit);
    }
    for (const field of ["voterIdentity", "sourceDomain", "sourceGateway", "epoch", "view", "batchId", "validatorEpoch", "committeeDigest"]) {
      assert.equal(badPrepares[0][field], badPrepares[1][field]);
    }
    assert.notEqual(badPrepares[0].messageRoot, badPrepares[1].messageRoot);
    assert.notEqual(badPrepares[0].prepareDigest, badPrepares[1].prepareDigest);
    await reject(honest[0], "/pbft/prepare", badPrepares[0], "WRONG_ROOT");
    await reject(honest[1], "/pbft/prepare", badPrepares[1], "WRONG_ROOT");
    await assertLocks(); await assertWeights([], []);
    console.log(`EXPECTED FAILURE: ${adversaryAddress} equivocated in batch epoch ${statement.epoch}, validator epoch ${statement.validatorEpoch}, view ${view}: root ${roots[0]} to ${peers[honest[0]].address}, root ${roots[1]} to ${peers[honest[1]].address}; both returned WRONG_ROOT and retained canonical locks`);
    for (const index of honest.slice(0, 2)) {
      assert.equal((await request(index, "/pbft/prepare/cast", { epoch: statement.epoch })).status, 200);
    }
    for (const index of honest) for (const bad of badPrepares) {
      await reject(index, "/pbft/prepare", bad, "WRONG_ROOT");
    }
    await reject(honest[0], "/pbft/prepare", badPrepares[0], "WRONG_ROOT");
    await assertWeights(honest.slice(0, 2), []);
    await assertDurableAuthority(false);
    assert.deepEqual(await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId }), pending);
    assert.ok(isDeepStrictEqual(await transportEvidence(), beforeTransport), "malicious evidence must not allocate a nonce, intent, signed attempt or broadcast");
    console.log("EXPECTED FAILURE: conflicting and repeated Byzantine PREPARE evidence added zero weight; two honest voters remained unprepared, with zero QC, COMMITTED root, READY projection or transaction allocation");
    assert.equal((await request(honest[2], "/pbft/prepare/cast", { epoch: statement.epoch })).status, 200);
    await assertWeights(honest, []);
    const preparedBefore = new Map();
    for (const index of members) preparedBefore.set(index, await states[index].store.readPrepareState(statement.epoch, view));
    for (const index of honest) for (const bad of badCommits) {
      await reject(index, "/pbft/commit", bad, "WRONG_ROOT");
    }
    await reject(honest[0], "/pbft/commit", badCommits[0], "WRONG_ROOT");
    for (const index of members) assert.deepEqual(await states[index].store.readPrepareState(statement.epoch, view), preparedBefore.get(index));
    await assertWeights(honest, []);
    console.log("EXPECTED FAILURE: genuine conflicting-root COMMIT signatures returned WRONG_ROOT after honest PREPARED; duplicate malicious evidence added zero COMMIT weight and preserved PREPARED locks");
    const forged = { messageType: "QUORUM_CERTIFICATE", ...badStatements[0], qcDigest: qcDigest(badStatements[0]), commits: [badCommits[0]] };
    const duplicate = { ...forged, commits: [badCommits[0], badCommits[0], badCommits[0]] };
    for (const [certificate, reason] of [[forged, "INSUFFICIENT_OR_INVALID_QC_EVIDENCE"], [duplicate, "DUPLICATE_QC_SIGNER"]]) {
      await assert.rejects(() => verifyQuorumCertificate(certificate, { peers, validatorSets, expected: badStatements[0] }), { code: reason });
      await reject(honest[0], "/pbft/qc/verify", certificate, reason);
      await reject(honest[0], "/pbft/qc/submit", certificate, "WRONG_QC_MESSAGEROOT");
    }
    await assertDurableAuthority(false); await assertWeights(honest, []);
    assert.deepEqual(await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId }), pending);
    assert.ok(isDeepStrictEqual(await transportEvidence(), beforeTransport), "invalid QCs must not create transport authority or spend a nonce");
    console.log("EXPECTED FAILURE: single-signer and repeated-signer malicious QCs failed exact production evidence checks and could not commit the conflicting root");
    const committed = await commitPrepared(pending, honest);
    const verified = await verifyQuorumCertificate(committed.quorumCertificate, { peers, validatorSets, expected: statement });
    assert.deepEqual(verified, committed.quorumCertificate);
    assert.equal(verified.commits.length, 3);
    assert.deepEqual(verified.commits.map(vote => vote.voterIdentity).sort(), honestAddresses);
    await assertWeights(honest, honest); await assertDurableAuthority(true);
    await certificateChecks.snapshot(committed, "three honest signers committed the sole canonical root despite genuine Byzantine messages");
    const reused = { ...forged, commits: verified.commits };
    await assert.rejects(() => verifyQuorumCertificate(reused, { peers, validatorSets, expected: badStatements[0] }), { code: "MISMATCHED_COMMIT" });
    await reject(honest[0], "/pbft/qc/verify", reused, "MISMATCHED_COMMIT");
    await reject(honest[0], "/pbft/qc/submit", reused, "WRONG_QC_MESSAGEROOT");
    assert.deepEqual(await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId }), committed);
    console.log("EXPECTED FAILURE: canonical honest signatures reused under a conflicting QC statement returned MISMATCHED_COMMIT / WRONG_QC_MESSAGEROOT; the first durable QC stayed unchanged");
    console.log(`VALID: exactly three honest PREPARE/COMMIT voters ${honestAddresses.join(", ")} formed QC ${verified.qcDigest}; sole committed root ${statement.messageRoot} in unchanged view ${view}; malicious roots ${roots.join(", ")} have zero QC or COMMITTED state`);
    const projected = await projector.materializeBatch({ batchRecordId: committed.record.batchRecordId });
    assert.equal(projected.createdJobs, 1);
    const [pack] = await buildDeliveryPackages(committed, { validatorSets });
    assert.equal(pack.message.messageId, event.messageId); assert.equal(pack.messageRoot, statement.messageRoot);
    assert.deepEqual(pack.quorumCertificate, verified);
    assert.equal((await queue.getDeliveryJob(pack.deliveryJobId)).status, "READY");
    assert.equal(await readGateway("isMessageExecuted", [event.messageId]), false);
    const encoded = await encodeGatewaySubmission(pack, { validatorSets });
    await worker.submitJob(pack.deliveryJobId);
    const sent = await manager.repository.getTransaction(pack.deliveryJobId);
    assert.equal(sent.attempts.length, 1);
    const receipt = await client.waitForTransactionReceipt({ hash: sent.attempt.transactionHash });
    assert.equal(receipt.status, "success");
    const transaction = await client.getTransaction({ hash: receipt.transactionHash });
    assert.equal(transaction.to.toLowerCase(), gateway); assert.equal(transaction.value, 0n);
    assert.equal(transaction.input, encoded.calldata); assert.equal(sent.intent.packageDigest, encoded.packageDigest);
    const reserved = BigInt(beforeTransport.account.nextNonce);
    const expectedNonce = reserved > beforeTransport.pendingNonce ? reserved : beforeTransport.pendingNonce;
    assert.equal(BigInt(sent.intent.nonce), expectedNonce); assert.equal(BigInt(transaction.nonce), expectedNonce);
    const executions = receipt.logs.filter(log => log.address.toLowerCase() === gateway).map(log => decodeEventLog({ abi: gatewayAbi, ...log }));
    const grants = receipt.logs.filter(log => log.address.toLowerCase() === application).map(log => decodeEventLog({ abi: appAbi, ...log }));
    assert.equal(executions.length, 1); assert.equal(executions[0].eventName, "CrossChainMessageExecuted");
    assert.equal(executions[0].args.messageId, event.messageId); assert.equal(executions[0].args.batchId, statement.batchId);
    assert.equal(executions[0].args.sourceDomain, config.chainDomain); assert.equal(executions[0].args.destinationReceiver.toLowerCase(), application);
    assert.equal(grants.length, 1); assert.equal(grants[0].eventName, "VerifiedSupplierGranted");
    assert.equal(grants[0].args.messageId, event.messageId); assert.equal(grants[0].args.supplier.toLowerCase(), targetSupplier);
    assert.equal(await readGateway("isMessageExecuted", [event.messageId]), true);
    assert.equal(await readApp("isVerifiedSupplier", [targetSupplier]), true);
    await client.request({ method: "anvil_mine", params: [toHex(relayConfig.destinationConfirmations)] });
    await manager.checkReceiptsOnce();
    assert.equal((await manager.repository.getTransaction(pack.deliveryJobId)).intent.status, "CONFIRMED");
    await assertDurableAuthority(true, true); await assertWeights(honest, honest);
    assert.deepEqual(await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId }), committed);
    const targetJobs = (await pool.query(`SELECT j.delivery_job_id,j.message_id FROM ${jobs} j JOIN ${projections} p USING (batch_record_id)
      WHERE p.source_domain = $1 AND p.source_gateway = $2 AND p.batch_epoch = $3`, [...scope, statement.epoch])).rows;
    assert.deepEqual(targetJobs, [{ delivery_job_id: pack.deliveryJobId, message_id: event.messageId }]);
    for (const [address, abi, eventName] of [[gateway, gatewayAbi, "CrossChainMessageExecuted"], [application, appAbi, "VerifiedSupplierGranted"]]) {
      assert.equal((await client.getContractEvents({ address, abi, eventName, args: { messageId: event.messageId },
        fromBlock: 0n, toBlock: "latest", strict: true })).length, 1);
    }
    const afterTransport = await transportEvidence();
    assert.equal(afterTransport.pendingNonce, expectedNonce + 1n);
    assert.equal(BigInt(afterTransport.account.nextNonce), expectedNonce + 1n);
    const targetAttempts = afterTransport.attempts.filter(row => row.delivery_job_id === pack.deliveryJobId);
    assert.equal(targetAttempts.length, 1);
    assert.equal(afterTransport.intents.filter(row => row.delivery_job_id === pack.deliveryJobId).length, 1);
    const targetAttemptIds = new Set(targetAttempts.map(row => row.attempt_id));
    assert.ok(isDeepStrictEqual(afterTransport.intents.filter(row => row.delivery_job_id !== pack.deliveryJobId), beforeTransport.intents), "historical transaction intents stay unchanged");
    assert.ok(isDeepStrictEqual(afterTransport.attempts.filter(row => row.delivery_job_id !== pack.deliveryJobId), beforeTransport.attempts), "historical signed transaction bytes stay unchanged");
    assert.ok(isDeepStrictEqual(afterTransport.journals.filter(row => !targetAttemptIds.has(row.attempt_id)), beforeTransport.journals), "historical broadcast journals stay unchanged");
    assert.deepEqual((await readMessages(pool, config.databaseSchema)).filter(row => previousIds.has(row.id)), previousRows);
    for (const previous of previousBatches) assert.deepEqual(await lifecycle.readBatch({ batchRecordId: previous.record.batchRecordId }), previous);
    console.log(`VALID: one canonical READY job ${pack.deliveryJobId} and transaction lineage ${receipt.transactionHash} completed production Relayer/Tx Manager/Gateway/ApplicationB grant for ${event.messageId}; CONFIRMED; conflicting roots allocated zero extra nonce, intent, signed attempt, broadcast or destination execution`);
    console.log("VALID: exactly one durable committed root for the protected target scope; four original processes remained online, honest primary/view and canonical QC stayed unchanged, historical source/QC/signed-transaction evidence preserved");
  }

  async function verifyValidatorFailureRecovery() {
    const failureSupplier = "0x0000000000000000000000000000000000009021";
    const laterSupplier = "0x0000000000000000000000000000000000009022";
    const grant = supplier => encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "address" }], [1, 1, supplier]);
    assert.equal(grant(supplier), payload);
    assert.equal(await readApp("isVerifiedSupplier", [failureSupplier]), false);
    assert.equal(await readApp("isVerifiedSupplier", [laterSupplier]), false);
    const previousRows = await readMessages(pool, config.databaseSchema);
    const previousIds = new Set(previousRows.map(row => row.id));
    const sourceBatches = tableName(config.databaseSchema, "message_batches");
    const previousBatches = [];
    for (const row of (await pool.query(`SELECT batch_record_id FROM ${sourceBatches}
      WHERE source_domain = $1 AND source_gateway = $2 ORDER BY epoch`,
    [config.chainDomain.toString(), config.sourceGateway])).rows) {
      previousBatches.push(await lifecycle.readBatch({ batchRecordId: row.batch_record_id }));
    }
    const attemptsTable = tableName(config.databaseSchema, "transaction_attempts");
    const intentsTable = tableName(config.databaseSchema, "transaction_intents");
    const journalsTable = tableName(config.databaseSchema, "transaction_broadcast_events");
    const beforeAttempts = (await pool.query(`SELECT * FROM ${attemptsTable} ORDER BY attempt_id`)).rows;
    const beforeIntents = (await pool.query(`SELECT * FROM ${intentsTable} ORDER BY delivery_job_id`)).rows;
    const beforeJournals = (await pool.query(`SELECT * FROM ${journalsTable} ORDER BY event_id`)).rows;

    const event = await produceAndFinalize(grant(failureSupplier));
    const pending = await prepareFreshBatch([event]);
    assert.equal(pending.record.status, "CONSENSUS_PENDING");
    assert.equal(pending.consensusBinding.protocolVersion, "3");
    const selected = validatorSets.resolveByValidatorEpoch(pending.consensusBinding.validatorEpoch);
    assert.equal(selected.validatorEpoch, validatorSets.resolveForBatchEpoch(pending.record.epoch).validatorEpoch);
    assert.equal(selected.committeeDigest, pending.consensusBinding.committeeDigest);
    assert.equal(selected.validators.length, 4);
    const members = selected.validators.map(address => {
      const index = peers.findIndex(peer => peer.address === address);
      assert.ok(index >= 0); return index;
    });
    assert.equal(new Set(members.map(index => states[index].config.databaseSchema)).size, 4);
    const originalPids = new Map(members.map(index => [index, validators[index].child.pid]));
    async function assertReady(indices) {
      for (const index of indices) {
        assert.equal(validators[index].exited, false);
        const health = await request(index, "/health");
        assert.equal(health.status, 200); assert.equal(health.body.ready, true);
        assert.equal(health.body.validatorAddress, peers[index].address);
        assert.equal(health.body.pid, validators[index].child.pid);
      }
    }
    await assertReady(members);
    // Wait for production discovery to register each durable epoch, before any
    // proposal/vote. No test call initializes or rewrites validator state.
    const registered = await until("all four validators independently registered the pending batch", async () => {
      const views = await Promise.all(members.map(index => states[index].store.readViewState(pending.record.epoch)));
      return views.every(Boolean) ? views : null;
    }, members);
    const view = registered[0].current_view;
    assert.equal(view, "0", "ordinary validator failure must not require a view change");
    function assertContext(state, expected = pending) {
      assert.equal(state.batch_id, expected.record.batchId); assert.equal(state.message_root, expected.tree.messageRoot);
      assert.equal(state.epoch, expected.record.epoch.toString()); assert.equal(state.protocol_version, 3);
      assert.equal(state.validator_epoch, expected.consensusBinding.validatorEpoch);
      assert.equal(state.committee_digest, expected.consensusBinding.committeeDigest);
      assert.equal(state.current_view, view); assert.equal(state.target_view, view); assert.equal(state.changing_view, false);
    }
    for (const [position, index] of members.entries()) {
      assertContext(registered[position]); assert.equal(registered[position].finalized, false);
      assert.equal(await states[index].store.readPrePrepare(pending.record.epoch, view), null);
      assert.equal((await states[index].store.readPrepareState(pending.record.epoch, view)).voteCount, 0);
      assert.equal((await states[index].store.readCommitState(pending.record.epoch, view)).voteCount, 0);
    }
    const primaryAddress = deterministicPrimary(selected.validators, pending.record.epoch, view);
    const primary = peers.findIndex(peer => peer.address === primaryAddress);
    const offlineAddress = selected.validators.find(address => address !== primaryAddress);
    const offline = peers.findIndex(peer => peer.address === offlineAddress);
    assert.ok(members.includes(primary) && members.includes(offline)); assert.notEqual(offline, primary);
    const live = members.filter(index => index !== offline);
    assert.equal(live.length, 3); assert.ok(live.includes(primary));
    console.log(`VALID: target ${pending.record.batchId} is CONSENSUS_PENDING; batch epoch ${pending.record.epoch}, validator epoch ${selected.validatorEpoch}, view ${view}; Message Root ${pending.tree.messageRoot}; committee digest ${selected.committeeDigest}; four pinned members ${selected.validators.join(", ")}; quorum 3`);
    const stopped = validators[offline];
    const offlineStore = states[offline].store;
    const offlinePool = states[offline].pool;
    const offlineSchema = states[offline].config.databaseSchema;
    const metadataTable = tableName(offlineSchema, "validator_metadata");
    const historyTable = tableName(offlineSchema, "validator_set_history");
    const metadataBefore = (await offlinePool.query(`SELECT * FROM ${metadataTable} WHERE singleton = true`)).rows;
    const historyBefore = (await offlinePool.query(`SELECT * FROM ${historyTable} ORDER BY validator_epoch`)).rows;
    const priorViews = await offlineStore.readViewStates();
    const identityBefore = await request(offline, "/identity");
    assert.equal(identityBefore.status, 200);
    const offlineView = await offlineStore.readViewState(pending.record.epoch);

    async function assertNoOfflineVotes() {
      for (const state of states) {
        const values = [state.config.validatorAddress, pending.record.epoch.toString(), pending.record.batchId,
          selected.validatorEpoch, view, offlineAddress];
        const predicate = "local_validator_identity = $1 AND epoch = $2 AND batch_id = $3 AND validator_epoch = $4 AND view = $5 AND voter_identity = $6 AND protocol_version = 3";
        const counts = (await state.pool.query(`SELECT
          (SELECT COUNT(*) FROM ${tableName(state.config.databaseSchema, "pbft_prepare_votes")} WHERE ${predicate})::text AS prepares,
          (SELECT COUNT(*) FROM ${tableName(state.config.databaseSchema, "pbft_commit_votes")} WHERE ${predicate})::text AS commits`, values)).rows[0];
        assert.deepEqual(counts, { prepares: "0", commits: "0" });
      }
      assert.equal(await offlineStore.readPrePrepare(pending.record.epoch, view), null);
      assert.equal((await offlineStore.readPrepareState(pending.record.epoch, view)).prepared, null);
      const local = await offlineStore.readCommitState(pending.record.epoch, view);
      assert.equal(local.voteCount, 0); assert.equal(local.quorum, null); assert.equal(local.certificate, null);
    }
    async function assertStillOffline() {
      assert.equal(validators[offline], stopped); assert.equal(stopped.exited, true);
      const exit = await stopped.closed;
      assert.ok(exit.code === 0 || exit.signal === "SIGTERM" || exit.signal === "SIGKILL", "controlled validator stop must actually complete");
      await assertReady(live);
      for (const index of live) assert.equal(validators[index].child.pid, originalPids.get(index));
      assert.equal(members.filter(index => !validators[index].exited).length, 3);
      await assertNoOfflineVotes();
    }

    await assertNoOfflineVotes();
    await processes.stop(stopped);
    await assertStillOffline();
    await assert.rejects(() => request(offline, "/health"), error => error.cause?.code === "ECONNREFUSED");
    assert.deepEqual(await offlineStore.readViewState(pending.record.epoch), offlineView);
    console.log(`VALID: canonical-first non-primary ${offlineAddress} (committee position ${selected.validators.indexOf(offlineAddress)}, PID ${stopped.child.pid}, endpoint ${peers[offline].url}, store ${offlineSchema}) stopped before target votes; batch epoch ${pending.record.epoch}, validator epoch ${selected.validatorEpoch}, batch ${pending.record.batchId}, view ${view}; primary ${primaryAddress} remains ready`);

    const committed = await commitPending(pending, live);
    await assertStillOffline();
    const expectedSigners = live.map(index => peers[index].address).sort();
    const firstQc = committed.quorumCertificate;
    assert.equal(firstQc.protocolVersion, "3"); assert.equal(firstQc.view, view);
    assert.equal(firstQc.validatorEpoch, selected.validatorEpoch); assert.equal(firstQc.committeeDigest, selected.committeeDigest);
    assert.equal(firstQc.commits.length, 3);
    assert.deepEqual(firstQc.commits.map(vote => vote.voterIdentity).sort(), expectedSigners);
    function assertVote(vote, expected) {
      assert.equal(vote.protocolVersion, "3"); assert.equal(vote.sourceDomain, config.chainDomain.toString());
      assert.equal(vote.sourceGateway, config.sourceGateway); assert.equal(vote.epoch, expected.record.epoch.toString());
      assert.equal(vote.view, view); assert.equal(vote.batchId, expected.record.batchId); assert.equal(vote.messageRoot, expected.tree.messageRoot);
      assert.equal(vote.validatorEpoch, expected.consensusBinding.validatorEpoch);
      assert.equal(vote.committeeDigest, expected.consensusBinding.committeeDigest);
    }
    for (const index of live) {
      assertContext(await states[index].store.readViewState(pending.record.epoch));
      const prepares = await states[index].store.readPrepareState(pending.record.epoch, view);
      assert.equal(prepares.voteCount, 3); assert.ok(prepares.prepared);
      assert.deepEqual(prepares.votes.map(vote => vote.voterIdentity).sort(), expectedSigners);
      assert.deepEqual([...prepares.prepared.quorumVoters].sort(), expectedSigners);
      const commits = await states[index].store.readCommitState(pending.record.epoch, view);
      assert.equal(commits.voteCount, 3); assert.ok(commits.certificate);
      assert.deepEqual(commits.votes.map(vote => vote.voterIdentity).sort(), expectedSigners);
      for (const vote of [...prepares.votes, ...commits.votes]) assertVote(vote, pending);
    }
    await certificateChecks.snapshot(committed, "three live members independently verify the same-view QC while the non-primary stays offline");
    console.log(`VALID: exactly three live PREPARE/COMMIT voters ${expectedSigners.join(", ")} formed QC ${firstQc.qcDigest}; offline validator has zero target votes; batch COMMITTED in unchanged view ${view}`);

    const projected = await projector.materializeBatch({ batchRecordId: committed.record.batchRecordId });
    assert.equal(projected.createdJobs, 1);
    const [pack] = await buildDeliveryPackages(committed, { validatorSets });
    assert.equal(pack.message.messageId, event.messageId);
    assert.equal((await queue.getDeliveryJob(pack.deliveryJobId)).status, "READY");
    assert.equal(await readGateway("isMessageExecuted", [event.messageId]), false);
    const encoded = await encodeGatewaySubmission(pack, { validatorSets });
    await worker.submitJob(pack.deliveryJobId);
    const sent = await manager.repository.getTransaction(pack.deliveryJobId);
    assert.equal(sent.attempts.length, 1);
    const receipt = await client.waitForTransactionReceipt({ hash: sent.attempt.transactionHash });
    assert.equal(receipt.status, "success");
    const transaction = await client.getTransaction({ hash: receipt.transactionHash });
    assert.equal(transaction.to.toLowerCase(), gateway); assert.equal(transaction.value, 0n);
    assert.equal(transaction.input, encoded.calldata); assert.equal(sent.intent.packageDigest, encoded.packageDigest);
    const executions = receipt.logs.filter(log => log.address.toLowerCase() === gateway).map(log => decodeEventLog({ abi: gatewayAbi, ...log }));
    const grants = receipt.logs.filter(log => log.address.toLowerCase() === application).map(log => decodeEventLog({ abi: appAbi, ...log }));
    assert.equal(executions.length, 1); assert.equal(executions[0].eventName, "CrossChainMessageExecuted");
    assert.equal(executions[0].args.messageId, event.messageId); assert.equal(executions[0].args.batchId, committed.record.batchId);
    assert.equal(executions[0].args.sourceDomain, config.chainDomain); assert.equal(executions[0].args.destinationReceiver.toLowerCase(), application);
    assert.equal(grants.length, 1); assert.equal(grants[0].eventName, "VerifiedSupplierGranted");
    assert.equal(grants[0].args.messageId, event.messageId); assert.equal(grants[0].args.supplier.toLowerCase(), failureSupplier);
    assert.equal(await readGateway("isMessageExecuted", [event.messageId]), true);
    assert.equal(await readApp("isVerifiedSupplier", [failureSupplier]), true);
    await client.request({ method: "anvil_mine", params: [toHex(relayConfig.destinationConfirmations)] });
    await manager.checkReceiptsOnce();
    assert.equal((await manager.repository.getTransaction(pack.deliveryJobId)).intent.status, "CONFIRMED");
    await assertStillOffline();
    const repeated = await projector.materializeBatch({ batchRecordId: committed.record.batchRecordId });
    assert.equal(repeated.materialized, false); assert.equal(repeated.createdJobs, 0);
    console.log(`VALID: validator ${offlineAddress} remained offline through READY ${pack.deliveryJobId}, production Relayer/Tx Manager tx ${receipt.transactionHash}, confirmation and atomic Gateway/ApplicationB grant for ${event.messageId}`);

    // Startup must discover the committed QC itself. Do not submit a cached QC,
    // replay an old proposal or cast a missing historical vote at this node.
    assert.equal(environments[offline].VALIDATOR_DB_SCHEMA, offlineSchema);
    validators[offline] = await processes.start(environments[offline]);
    assert.notEqual(validators[offline].child.pid, stopped.child.pid);
    await assertReady(members);
    assert.deepEqual((await request(offline, "/identity")).body, identityBefore.body);
    assert.deepEqual((await request(offline, "/validator-sets")).body.history, validatorSets.history);
    assert.deepEqual((await offlinePool.query(`SELECT * FROM ${metadataTable} WHERE singleton = true`)).rows, metadataBefore);
    assert.deepEqual((await offlinePool.query(`SELECT * FROM ${historyTable} ORDER BY validator_epoch`)).rows, historyBefore);
    const recovered = await until("restarted validator recognized the committed batch during startup", async () => {
      const response = await request(offline, "/pbft/views");
      assert.equal(response.status, 200);
      const state = response.body.states.find(state => state.epoch === pending.record.epoch.toString());
      return state?.finalized ? state : null;
    }, members);
    assertContext(recovered); assert.equal(recovered.finalized, true);
    for (const previous of priorViews) {
      const current = await offlineStore.readViewState(previous.epoch);
      assert.ok(current); assert.equal(current.batch_id, previous.batch_id); assert.equal(current.message_root, previous.message_root);
      assert.equal(current.validator_epoch, previous.validator_epoch); assert.equal(current.committee_digest, previous.committee_digest);
      assert.equal(current.protocol_version, previous.protocol_version);
      assert.ok(BigInt(current.current_view) >= BigInt(previous.current_view));
      assert.ok(BigInt(current.target_view) >= BigInt(previous.target_view));
      if (previous.finalized) assert.equal(current.finalized, true);
    }
    await assertNoOfflineVotes();
    const recognized = await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId });
    assert.deepEqual(recognized, committed);
    await certificateChecks.snapshot(recognized, "restarted validator recognized the unchanged three-signer committed QC");
    console.log(`VALID: validator ${offlineAddress} restarted with PID ${validators[offline].child.pid}, same identity/endpoint/store/history; runtime recognized QC ${firstQc.qcDigest} without historical PREPARE/COMMIT fabrication or view rollback`);

    const laterEvent = await produceAndFinalize(grant(laterSupplier));
    const laterPending = await prepareFreshBatch([laterEvent]);
    const laterSet = validatorSets.resolveByValidatorEpoch(laterPending.consensusBinding.validatorEpoch);
    assert.equal(laterSet.validatorEpoch, validatorSets.resolveForBatchEpoch(laterPending.record.epoch).validatorEpoch);
    assert.ok(laterSet.validators.includes(offlineAddress), "the recovered validator must be a legitimate member of the later batch");
    const laterMembers = laterSet.validators.map(address => peers.findIndex(peer => peer.address === address));
    assert.ok(laterMembers.every(index => index >= 0)); await assertReady(laterMembers);
    const laterPrimary = peers.findIndex(peer => peer.address === deterministicPrimary(laterSet.validators, laterPending.record.epoch, view));
    const laterParticipants = [...new Set([offline, laterPrimary, ...laterMembers])].slice(0, 3);
    assert.equal(laterParticipants.length, 3);
    const laterCommitted = await commitPending(laterPending, laterParticipants);
    const laterPrepares = await offlineStore.readPrepareState(laterPending.record.epoch, view);
    const laterCommits = await offlineStore.readCommitState(laterPending.record.epoch, view);
    const selfPrepare = laterPrepares.votes.find(vote => vote.voterIdentity === offlineAddress);
    const selfCommit = laterCommits.votes.find(vote => vote.voterIdentity === offlineAddress);
    assert.ok(selfPrepare && selfCommit); assertVote(selfPrepare, laterPending); assertVote(selfCommit, laterPending);
    assert.ok(laterCommitted.quorumCertificate.commits.some(vote => vote.voterIdentity === offlineAddress));
    const observations = await offlineStore.readObservations();
    assert.ok(observations.some(row => row.batch_id === laterPending.record.batchId && row.result === "VALID"));
    await assertNoOfflineVotes();
    assert.deepEqual(await lifecycle.readBatch({ batchRecordId: committed.record.batchRecordId }), committed);
    await assertReady(laterMembers);
    for (const [address, abi, eventName] of [[gateway, gatewayAbi, "CrossChainMessageExecuted"], [application, appAbi, "VerifiedSupplierGranted"]]) {
      assert.equal((await client.getContractEvents({ address, abi, eventName, args: { messageId: event.messageId },
        fromBlock: 0n, toBlock: "latest", strict: true })).length, 1);
    }
    assert.deepEqual((await readMessages(pool, config.databaseSchema)).filter(row => previousIds.has(row.id)), previousRows);
    for (const previous of previousBatches) assert.deepEqual(await lifecycle.readBatch({ batchRecordId: previous.record.batchRecordId }), previous);
    // Compare historical signed bytes without printing their contents on failure.
    const afterAttempts = (await pool.query(`SELECT * FROM ${attemptsTable} ORDER BY attempt_id`)).rows;
    const afterIntents = (await pool.query(`SELECT * FROM ${intentsTable} ORDER BY delivery_job_id`)).rows;
    const afterJournals = (await pool.query(`SELECT * FROM ${journalsTable} ORDER BY event_id`)).rows;
    const targetAttemptIds = new Set(afterAttempts.filter(row => row.delivery_job_id === pack.deliveryJobId).map(row => row.attempt_id));
    assert.ok(isDeepStrictEqual(afterAttempts.filter(row => row.delivery_job_id !== pack.deliveryJobId), beforeAttempts), "historical signed transaction attempts remain unchanged");
    assert.ok(isDeepStrictEqual(afterIntents.filter(row => row.delivery_job_id !== pack.deliveryJobId), beforeIntents), "historical transaction intents remain unchanged");
    assert.ok(isDeepStrictEqual(afterJournals.filter(row => !targetAttemptIds.has(row.attempt_id)), beforeJournals), "historical broadcast journals remain unchanged");
    console.log(`VALID: recovered validator ${offlineAddress} independently validated later source message ${laterEvent.messageId}, cast genuine PREPARE/COMMIT in epoch ${laterSet.validatorEpoch}, and joined QC ${laterCommitted.quorumCertificate.qcDigest} for batch ${laterCommitted.record.batchId}`);
    console.log("VALID: one non-primary process failure preserved same-view 3-of-4 liveness through production destination execution; original QC/signers, source-reorg evidence and historical transactions stayed unchanged");
  }

  async function verifySourceReorgRecovery() {
    // Reuse the live cluster, deployed contracts and this same durable schema.
    // Only Chain A is rewound; no destination snapshot or process fault is used.
    const recoveryPool = createDatabasePool(config);
    let primaryError;
    try {
      const scope = { chainDomain: config.chainDomain, sourceGateway: config.sourceGateway };
      const recoveryLifecycle = createBatchLifecycle({ config, pool: recoveryPool, validatorSets });
      const recoveryQueue = createDeliveryRepository({ config: deliveryConfig, pool: recoveryPool });
      const recoveryProjector = createDeliveryProjector({ config: deliveryConfig, pool: recoveryPool });
      const recoveryManager = createTransactionManager({ config: relayConfig, pool: recoveryPool, queue: recoveryQueue });
      const recoveryWorker = createRelayerWorker({ config: relayConfig, pool: recoveryPool,
        queue: recoveryQueue, transactionManager: recoveryManager });
      const sourceTable = tableName(config.databaseSchema, "source_messages");
      const batchTable = tableName(config.databaseSchema, "message_batches");
      const members = tableName(config.databaseSchema, "message_batch_members");
      const certificates = tableName(config.databaseSchema, "batch_quorum_certificates");
      const jobs = tableName(config.databaseSchema, "delivery_jobs");
      const intents = tableName(config.databaseSchema, "transaction_intents");
      const attempts = tableName(config.databaseSchema, "transaction_attempts");
      const journals = tableName(config.databaseSchema, "transaction_broadcast_events");
      const orphanSupplier = "0x0000000000000000000000000000000000009011";
      const replacementSupplier = "0x0000000000000000000000000000000000009012";
      const grant = supplier => encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "address" }], [1, 1, supplier]);
      assert.equal(grant(supplier), payload, "reorg commands retain the frozen ApplicationB encoding");
      for (const supplier of [orphanSupplier, replacementSupplier]) assert.equal(await readApp("isVerifiedSupplier", [supplier]), false);
      const activePids = active.map(index => validators[index].child.pid);
      async function assertLiveValidators() {
        for (const [position, index] of active.entries()) {
          assert.equal(validators[index].child.pid, activePids[position]);
          assert.equal(validators[index].exited, false);
          const health = await request(index, "/health");
          assert.equal(health.status, 200); assert.equal(health.body.ready, true);
        }
      }
      async function readOccurrence(event) {
        const result = await recoveryPool.query(`SELECT * FROM ${sourceTable}
          WHERE source_domain = $1 AND source_gateway = $2 AND source_block_hash = $3
            AND source_tx_hash = $4 AND source_log_index = $5`,
        [config.chainDomain.toString(), config.sourceGateway, event.sourceBlockHash,
          event.sourceTransactionHash, event.sourceLogIndex.toString()]);
        assert.equal(result.rowCount, 1, "exact source occurrence must remain durable");
        assert.equal(result.rows[0].message_id, event.messageId);
        return result.rows[0];
      }
      async function readBatches() {
        const records = (await recoveryPool.query(`SELECT batch_record_id FROM ${batchTable}
          WHERE source_domain = $1 AND source_gateway = $2 ORDER BY epoch`,
        [config.chainDomain.toString(), config.sourceGateway])).rows;
        const result = [];
        for (const row of records) result.push(await recoveryLifecycle.readBatch({ batchRecordId: row.batch_record_id }));
        return result;
      }
      async function transportEvidence() {
        return { ...await evidence(),
          journals: (await recoveryPool.query(`SELECT * FROM ${journals} ORDER BY event_id`)).rows,
          pendingNonce: BigInt(await client.request({ method: "eth_getTransactionCount", params: [relayConfig.relayerAddress, "pending"] })) };
      }
      const applicationAddress = normalizeAddress(process.env.IDENTITY_APPLICATION_ADDRESS);
      const identityAbi = artifact("IdentityApplicationA").abi;
      const sourceAbi = parseAbi(["function nextNonce() view returns (uint256)"]);
      const sourceNonce = () => chainA.readContract({ address: config.sourceGateway, abi: sourceAbi, functionName: "nextNonce" });
      const usedNullifier = nullifier => chainA.readContract({ address: applicationAddress, abi: identityAbi,
        functionName: "usedNullifiers", args: [nullifier] });
      async function sourceAuthorization(event) {
        const receipt = await chainA.getTransactionReceipt({ hash: event.sourceTransactionHash });
        assert.equal(receipt.status, "success"); assert.equal(receipt.blockHash.toLowerCase(), event.sourceBlockHash);
        assert.equal(receipt.blockNumber, event.sourceBlockNumber);
        assert.equal((await chainA.getBlock({ blockNumber: event.sourceBlockNumber })).hash.toLowerCase(), event.sourceBlockHash);
        const links = receipt.logs.filter(log => log.address.toLowerCase() === applicationAddress)
          .map(log => decodeEventLog({ abi: identityAbi, ...log }))
          .filter(log => log.eventName === "AuthorizedMessageForwarded" && log.args.messageId === event.messageId);
        assert.equal(links.length, 1);
        assert.equal(await usedNullifier(links[0].args.nullifier), true);
        return links[0].args.nullifier;
      }

      await assertLiveValidators();
      await indexer.catchUpOnce(); await finality.runFinalityPass();
      const historicalRows = await readMessages(recoveryPool, config.databaseSchema);
      const historicalBlocks = await readIndexedSourceBlocks(recoveryPool, config.databaseSchema, scope);
      const historicalBatches = await readBatches();
      const beforeTransport = await transportEvidence();
      assert.ok(beforeTransport.account, "the existing E2E manager already owns durable nonce state");
      const commonAncestor = await chainA.getBlock({ blockTag: "latest" });
      const branchSnapshot = await chainA.request({ method: "evm_snapshot" });
      const nonceBefore = await sourceNonce();
      const orphan = await produceSourceMessage(grant(orphanSupplier));
      assert.equal(orphan.sourceBlockNumber, commonAncestor.number + 1n);
      const orphanNullifier = await sourceAuthorization(orphan);
      assert.equal(await sourceNonce(), nonceBefore + 1n);
      await indexer.catchUpOnce();
      assert.equal((await readOccurrence(orphan)).status, "OBSERVED");
      await finality.runFinalityPass();
      const beforeReorg = await readOccurrence(orphan);
      assert.equal(beforeReorg.status, "FINALIZING");
      assert.ok(beforeReorg.finalizing_at instanceof Date); assert.equal(beforeReorg.finalized_at, null);
      await chainA.request({ method: "anvil_mine", params: ["0x1"] });
      await indexer.catchUpOnce();
      const oldHead = await chainA.getBlock({ blockTag: "latest" });
      assert.ok(oldHead.number - orphan.sourceBlockNumber < config.finalityBlockDepth, "fault must precede source finality");
      assert.equal(oldHead.transactions.length, 0, "the old branch includes a persisted eventless block");
      const oldBlocks = await readIndexedSourceBlocks(recoveryPool, config.databaseSchema, scope);
      assert.equal(oldBlocks.at(-1).block_number, oldHead.number.toString());
      assert.equal(oldBlocks.at(-1).block_hash, oldHead.hash.toLowerCase());

      async function assertExcluded(expectedOccurrence) {
        assert.deepEqual(await readOccurrence(orphan), expectedOccurrence);
        const counts = (await recoveryPool.query(`WITH orphan_jobs AS (
          SELECT delivery_job_id FROM ${jobs} WHERE source_message_id = $1 OR message_id = $2
        ), orphan_attempts AS (
          SELECT * FROM ${attempts} WHERE delivery_job_id IN (SELECT delivery_job_id FROM orphan_jobs)
        ) SELECT
          (SELECT COUNT(*) FROM ${members} WHERE source_message_id = $1 OR message_id = $2)::text AS membership,
          (SELECT COUNT(*) FROM ${certificates} q JOIN ${members} m USING (batch_record_id)
            WHERE m.source_message_id = $1 OR m.message_id = $2)::text AS qc_membership,
          (SELECT COUNT(*) FROM orphan_jobs)::text AS ready,
          (SELECT COUNT(*) FROM ${intents} WHERE delivery_job_id IN (SELECT delivery_job_id FROM orphan_jobs))::text AS intents,
          (SELECT COUNT(*) FROM orphan_attempts)::text AS signed_attempts,
          (SELECT COUNT(*) FROM ${journals} WHERE attempt_id IN (SELECT attempt_id FROM orphan_attempts))::text AS broadcasts,
          (SELECT COUNT(*) FROM orphan_attempts WHERE receipt_block_number IS NOT NULL)::text AS receipts`,
        [beforeReorg.id, orphan.messageId])).rows[0];
        assert.deepEqual(counts, { membership: "0", qc_membership: "0", ready: "0", intents: "0",
          signed_attempts: "0", broadcasts: "0", receipts: "0" });
        const eligible = await createFinalityStore(recoveryPool, config.databaseSchema).listBatchEligibleMessages(scope);
        assert.ok(eligible.every(row => row.id !== beforeReorg.id && row.message_id !== orphan.messageId));
        // Authenticate every referenced batch from current durable membership/QC,
        // rather than looking for the message ID in consensus log strings.
        const batches = new Map();
        for (const current of await readBatches()) {
          assert.ok(current.members.every(member => member.sourceMessageId !== beforeReorg.id && member.messageId !== orphan.messageId));
          if (current.batch) {
            assert.ok(!current.batch.messageIds.includes(orphan.messageId));
            batches.set(current.batch.batchId, current);
          }
        }
        const consensusTables = ["validated_batch_bindings", "pbft_epoch_views", "pbft_pre_prepares",
          "pbft_prepare_votes", "pbft_prepared_states", "pbft_commit_votes", "pbft_commit_quorums"];
        for (const state of states) {
          const references = (await state.pool.query(consensusTables.map(name =>
            `SELECT batch_id,message_root FROM ${tableName(state.config.databaseSchema, name)}`).join(" UNION "))).rows;
          for (const reference of references) {
            const current = batches.get(reference.batch_id);
            assert.ok(current, "durable validator weight must reference an actual sealed source batch");
            assert.equal(reference.message_root, current.tree.messageRoot);
          }
        }
        assert.equal(await readGateway("isMessageExecuted", [orphan.messageId]), false);
        assert.equal(await readApp("isVerifiedSupplier", [orphanSupplier]), false);
        for (const [address, abi, eventName] of [[gateway, gatewayAbi, "CrossChainMessageExecuted"], [application, appAbi, "VerifiedSupplierGranted"]]) {
          assert.equal((await client.getContractEvents({ address, abi, eventName, args: { messageId: orphan.messageId },
            fromBlock: 0n, toBlock: "latest", strict: true })).length, 0);
        }
        await assertLiveValidators();
      }

      await assertExcluded(beforeReorg);
      console.log(`VALID: real source event ${orphan.messageId} persisted FINALIZING below depth ${config.finalityBlockDepth}; no batch/QC/READY/intent before reorg`);
      assert.equal(await chainA.request({ method: "evm_revert", params: [branchSnapshot] }), true);
      assert.equal(BigInt(await chainA.request({ method: "eth_blockNumber" })), commonAncestor.number);
      assert.equal(await sourceNonce(), nonceBefore);
      assert.equal(await usedNullifier(orphanNullifier), false, "orphaned source authorization rolls back with its EVM transaction");
      const replacement = await produceSourceMessage(grant(replacementSupplier));
      assert.equal(replacement.sourceBlockNumber, orphan.sourceBlockNumber);
      assert.equal(replacement.nonce, orphan.nonce);
      assert.notEqual(replacement.sourceBlockHash, orphan.sourceBlockHash);
      assert.notEqual(replacement.messageId, orphan.messageId);
      assert.notEqual(await sourceAuthorization(replacement), orphanNullifier);
      assert.equal(await usedNullifier(orphanNullifier), false);
      console.log("VALID: real source EVM rollback restored Gateway nonce and cleared the orphan's nullifier; replacement used a fresh intent-bound proof");
      await chainA.request({ method: "anvil_mine", params: ["0x1"] });
      const replacementEmpty = await chainA.getBlock({ blockTag: "latest" });
      assert.equal(replacementEmpty.number, oldHead.number);
      assert.equal(replacementEmpty.transactions.length, 0);
      assert.notEqual(replacementEmpty.hash.toLowerCase(), oldHead.hash.toLowerCase());
      assert.notEqual((await chainA.getBlock({ blockNumber: orphan.sourceBlockNumber })).hash.toLowerCase(), orphan.sourceBlockHash);
      assert.equal(await chainA.request({ method: "eth_getTransactionReceipt", params: [orphan.sourceTransactionHash] }), null);

      const reconciliation = [];
      const recoveryLogger = { log: message => reconciliation.push(message), error: message => console.error(message) };
      const recoveredWatcher = createFinalityWatcher({ config, pool: recoveryPool, publicClient: chainA, logger: recoveryLogger });
      const recoveredIndexer = createIndexer({ config, pool: recoveryPool, publicClient: chainA, logger: recoveryLogger });
      const reorgedBefore = await metricValue("messages_reorged_total");
      await recoveredWatcher.runFinalityPass();
      assert.equal(await metricValue("messages_reorged_total"), reorgedBefore + 1);
      assert.ok(reconciliation.includes(`Common ancestor: ${commonAncestor.number}`));
      assert.ok(reconciliation.includes("Unfinalized messages marked REORGED: 1"));
      const orphaned = await readOccurrence(orphan);
      assert.equal(orphaned.status, "REORGED"); assert.ok(orphaned.reorged_at instanceof Date);
      assert.deepEqual({ ...orphaned, status: beforeReorg.status, reorged_at: beforeReorg.reorged_at }, beforeReorg);
      assert.equal(BigInt((await readCursor(recoveryPool, config.databaseSchema, scope)).next_block), commonAncestor.number + 1n);
      assert.deepEqual(await readIndexedSourceBlocks(recoveryPool, config.databaseSchema, scope), historicalBlocks);
      const reindexed = await recoveredIndexer.catchUpOnce();
      assert.equal(reindexed.initialNextBlock, commonAncestor.number + 1n);
      assert.equal(reindexed.nextBlock, replacementEmpty.number + 1n);
      const canonicalBlocks = await readIndexedSourceBlocks(recoveryPool, config.databaseSchema, scope);
      assert.equal(canonicalBlocks.at(-1).block_hash, replacementEmpty.hash.toLowerCase());
      assert.equal(canonicalBlocks.at(-1).block_number, replacementEmpty.number.toString());
      assert.equal((await readOccurrence(replacement)).status, "OBSERVED");
      await recoveredWatcher.runFinalityPass();
      assert.equal((await readOccurrence(replacement)).status, "FINALIZING");
      const emptyCollection = await recoveryLifecycle.collectEligible();
      assert.equal(emptyCollection.assignedCount, 0);
      assert.equal(emptyCollection.snapshot.members.length, 0);
      const beforeRepeat = await readMessages(recoveryPool, config.databaseSchema);
      const repeated = await recoveredIndexer.catchUpOnce();
      assert.equal(repeated.insertedRows, 0);
      await recoveredWatcher.runFinalityPass();
      assert.deepEqual(await readMessages(recoveryPool, config.databaseSchema), beforeRepeat);
      assert.equal(await metricValue("messages_reorged_total"), reorgedBefore + 1);
      console.log("VALID: one real source occurrence transitioning to REORGED increments the reorg counter once while repeated reconciliation adds no duplicate event");
      // Actually drive the existing downstream workers while the replacement is
      // still unfinalized. Old unrelated READY/deferred jobs may exist.
      await recoveryWorker.runOnce();
      assert.deepEqual(await transportEvidence(), beforeTransport, "the orphan must reserve/sign/broadcast no transaction or nonce");
      await assertExcluded(orphaned);
      console.log(`VALID: real Chain A branch replaced after ancestor ${commonAncestor.number}; original occurrence ${beforeReorg.id} preserved terminal REORGED with unchanged provenance`);
      console.log("VALID: orphaned occurrence has zero batch/Merkle/PBFT/QC/READY/intent/signed-attempt/broadcast/receipt/destination evidence with live validators and Relayer/Tx Manager");

      await chainA.request({ method: "anvil_mine", params: [toHex(config.finalityBlockDepth)] });
      await recoveredIndexer.catchUpOnce(); await recoveredWatcher.runFinalityPass();
      assert.equal((await readOccurrence(replacement)).status, "FINALIZED");
      const committed = await commitFresh([replacement]);
      assert.equal(committed.quorumCertificate.commits.length, 3);
      assert.equal(new Set(committed.quorumCertificate.commits.map(vote => vote.voterIdentity)).size, 3);
      const projection = await recoveryProjector.materializeBatch({ batchRecordId: committed.record.batchRecordId });
      assert.equal(projection.createdJobs, 1);
      const [pack] = await buildDeliveryPackages(committed, { validatorSets });
      assert.equal(pack.message.messageId, replacement.messageId);
      assert.equal((await recoveryQueue.getDeliveryJob(pack.deliveryJobId)).status, "READY");
      const encoded = await encodeGatewaySubmission(pack, { validatorSets });
      await recoveryWorker.submitJob(pack.deliveryJobId);
      const sent = await recoveryManager.repository.getTransaction(pack.deliveryJobId);
      assert.equal(sent.attempts.length, 1);
      const receipt = await client.waitForTransactionReceipt({ hash: sent.attempt.transactionHash });
      assert.equal(receipt.status, "success");
      const transaction = await client.getTransaction({ hash: receipt.transactionHash });
      assert.equal(transaction.to.toLowerCase(), gateway); assert.equal(transaction.value, 0n);
      assert.equal(transaction.input, encoded.calldata); assert.equal(sent.intent.packageDigest, encoded.packageDigest);
      const nextReserved = BigInt(beforeTransport.account.nextNonce);
      const expectedNonce = nextReserved > beforeTransport.pendingNonce ? nextReserved : beforeTransport.pendingNonce;
      assert.equal(BigInt(sent.intent.nonce), expectedNonce); assert.equal(BigInt(transaction.nonce), expectedNonce);
      const executions = receipt.logs.filter(log => log.address.toLowerCase() === gateway).map(log => decodeEventLog({ abi: gatewayAbi, ...log }));
      const grants = receipt.logs.filter(log => log.address.toLowerCase() === application).map(log => decodeEventLog({ abi: appAbi, ...log }));
      assert.equal(executions.length, 1); assert.equal(executions[0].eventName, "CrossChainMessageExecuted");
      assert.equal(executions[0].args.messageId, replacement.messageId); assert.equal(executions[0].args.batchId, committed.record.batchId);
      assert.equal(executions[0].args.sourceDomain, config.chainDomain); assert.equal(executions[0].args.destinationReceiver.toLowerCase(), application);
      assert.equal(grants.length, 1); assert.equal(grants[0].eventName, "VerifiedSupplierGranted");
      assert.equal(grants[0].args.messageId, replacement.messageId); assert.equal(grants[0].args.supplier.toLowerCase(), replacementSupplier);
      assert.equal(await readGateway("isMessageExecuted", [replacement.messageId]), true);
      assert.equal(await readApp("isVerifiedSupplier", [replacementSupplier]), true);
      await client.request({ method: "anvil_mine", params: [toHex(relayConfig.destinationConfirmations)] });
      await recoveryManager.checkReceiptsOnce();
      assert.equal((await recoveryManager.repository.getTransaction(pack.deliveryJobId)).intent.status, "CONFIRMED");
      assert.equal(BigInt((await recoveryManager.repository.getAccount()).nextNonce), expectedNonce + 1n);
      const repeatProjection = await recoveryProjector.materializeBatch({ batchRecordId: committed.record.batchRecordId });
      assert.equal(repeatProjection.materialized, false); assert.equal(repeatProjection.createdJobs, 0);
      await recoveredIndexer.catchUpOnce(); await recoveredWatcher.runFinalityPass();
      await assertExcluded(orphaned);
      const rowsAfter = await readMessages(recoveryPool, config.databaseSchema);
      assert.deepEqual(rowsAfter.filter(row => historicalRows.some(previous => previous.id === row.id)), historicalRows);
      for (const previous of historicalBatches) assert.deepEqual(await recoveryLifecycle.readBatch({ batchRecordId: previous.record.batchRecordId }), previous);
      const afterTransport = await transportEvidence();
      assert.equal(afterTransport.pendingNonce, expectedNonce + 1n, "only the legitimate replacement consumes a destination nonce");
      assert.deepEqual(afterTransport.intents.filter(row => row.delivery_job_id !== pack.deliveryJobId), beforeTransport.intents);
      assert.deepEqual(afterTransport.attempts.filter(row => row.delivery_job_id !== pack.deliveryJobId), beforeTransport.attempts);
      const newAttemptIds = new Set((await recoveryManager.repository.getTransaction(pack.deliveryJobId)).attempts.map(attempt => attempt.attemptId));
      assert.deepEqual(afterTransport.journals.filter(row => !newAttemptIds.has(row.attempt_id)), beforeTransport.journals);
      console.log(`VALID: canonical source recovery completed real E2E: message ${replacement.messageId}; batch ${committed.record.batchId}; root ${committed.tree.messageRoot}; validator epoch ${committed.quorumCertificate.validatorEpoch}; QC ${committed.quorumCertificate.qcDigest}; job ${pack.deliveryJobId}; destination tx ${receipt.transactionHash}`);
      console.log("VALID: replacement reached production Gateway/ApplicationB; original orphan remained REORGED and unexecuted; historical source/batch/QC/signed-transaction evidence unchanged");
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try { await recoveryPool.end(); }
      catch (error) {
        if (!primaryError) throw error;
        console.error(`Source reorg client cleanup also failed (${error.code ?? error.name})`);
      }
    }
  }
}
