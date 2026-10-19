import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { deterministicPrimary } from "../../src/committee.mjs";
import { developmentKeys } from "./fixtures.mjs";
import { snapshotContext, encodeCertificate } from "./pbft-certificate.mjs";
import { snapshotInclusions } from "../../../indexer/test/helpers/merkle-inclusion-contract.mjs";
import { canonicalDomainMessage } from "../../../indexer/test/helpers/message-domain-contract.mjs";

const artifact = name => JSON.parse(readFileSync(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
const normalizeError = value => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : value;
const quiet = { log() {}, warn() {}, error() {} };

// Extends the existing real rotation cluster after its historical/fault assertions have completed.
export async function verifyDestinationExecution({ config, pool, lifecycle, validatorSets, peers, states, environments,
  validators, processes, request, until, produceMessage, historical, rpcUrl, registryChecks,
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

  async function produceSourceMessage(payload, target = application) {
    const event = await produceMessage(payload, { destinationGateway: gateway, destinationReceiver: target,
      deadlineFloor: (await client.getBlock()).timestamp + 3600n });
    const sourceAbi = parseAbi(["function computeMessageId(address,uint256,address,address,uint256,bytes32,uint256) view returns (bytes32)"]);
    assert.equal(await chainA.readContract({ address: config.sourceGateway, abi: sourceAbi, functionName: "computeMessageId",
      args: [event.sourceSender, event.destinationDomain, event.destinationGateway, event.destinationReceiver,
        event.nonce, event.payloadHash, event.deadline] }), event.messageId);
    assert.ok(event.deadline > (await client.getBlock()).timestamp);
    return event;
  }

  async function produceAndFinalize(payload, target = application) {
    const event = await produceSourceMessage(payload, target);
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
    console.log(`VALID: fresh exact-intent credential proof and Application A → SourceGateway ${event.messageId}; Indexer OBSERVED → FINALIZING → FINALIZED`);
    return event;
  }

  async function commitFresh(events) {
    const collected = await lifecycle.collectEligible();
    assert.equal(collected.assignedCount, events.length);
    const sealed = await lifecycle.sealBatch({ batchRecordId: collected.snapshot.record.batchRecordId });
    assert.deepEqual(sealed.batch.messageIds, events.map(event => event.messageId));
    const pending = await lifecycle.markConsensusPending({ batchRecordId: sealed.record.batchRecordId });
    const selected = validatorSets.resolveForBatchEpoch(pending.record.epoch);
    assert.equal(pending.consensusBinding.validatorEpoch, selected.validatorEpoch);
    const primary = peers.findIndex(peer => peer.address === deterministicPrimary(selected.validators, pending.record.epoch));
    assert.ok(active.includes(primary));
    assert.equal((await request(primary, "/pbft/propose", { batchId: pending.record.batchId })).status, 200);
    for (const index of active) assert.equal((await request(index, "/pbft/prepare/cast", { epoch: pending.record.epoch.toString() })).status, 200);
    for (const index of active.slice(0, 3)) assert.equal((await request(index, "/pbft/commit/cast", { epoch: pending.record.epoch.toString() })).status, 200);
    const qc = (await request(active[0], "/pbft/qc", { epoch: pending.record.epoch.toString() })).body.certificate;
    assert.ok(qc);
    assert.equal((await request(active[0], "/pbft/qc/submit", qc)).status, 200);
    const committed = await until("fresh business batch COMMITTED", async () => {
      const value = await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId });
      return value.record.status === "COMMITTED" ? value : null;
    }, active);
    await registryChecks.assertQcBinding(committed.quorumCertificate);
    console.log(`VALID: bounded canonical batch ${committed.record.batchId}; Message Root ${committed.record.messageRoot}; validator epoch ${selected.validatorEpoch}; real PBFT QC → COMMITTED`);
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
  for (const pack of packages) prepared.push(await manager.prepareDeliveryTransaction(pack.deliveryJobId));
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
  await manager.checkReceiptsOnce();
  assert.equal((await manager.repository.getTransaction(successPack.deliveryJobId)).intent.status, "CONFIRMED");
  assert.equal((await manager.repository.getTransaction(failurePack.deliveryJobId)).intent.status, "REVERTED");
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
  console.log("COMPLETE END-TO-END EXECUTION EVIDENCE RECORDED: fresh ZK intent → source event → real finality/batch/PBFT/READY → production Relayer/Tx Manager → atomic Gateway/ApplicationB; duplicate rejection and business rollback; historical snapshots unchanged");

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
      await recoveredWatcher.runFinalityPass();
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
