import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { validatorAccount } from "../../src/identity.mjs";
import { deterministicPrimary } from "../../src/committee.mjs";
import { createValidatorSetResolver } from "../../src/validator-sets.mjs";
import { createValidatorStore } from "../../src/db.mjs";
import { loadValidatorConfig } from "../../src/config.mjs";
import { prepareDigest } from "../../src/prepare.mjs";
import { viewChangeDigest, authenticateNewView } from "../../src/view-change.mjs";
import { proposalIdentity } from "../../src/prepared-certificate.mjs";
import { expectedCommitStatement, verifyQuorumCertificate } from "../../src/quorum-certificate.mjs";
import { applyMigrations, createDatabasePool, readMessages, resetIndexerTables, tableName } from "../../../indexer/src/db.mjs";
import { createIndexer } from "../../../indexer/src/indexer.mjs";
import { createFinalityWatcher } from "../../../indexer/src/finality-watcher.mjs";
import { createBatchLifecycle } from "../../../indexer/src/batch-lifecycle.mjs";
import { developmentKeys } from "./fixtures.mjs";
import { signedCommitFixture } from "./commit-fixtures.mjs";
import { closeScenarioResources, createValidatorProcesses, initializeValidatorState, reservePort, rpcObserver } from "./process-cluster.mjs";
import { sourceState } from "./four-process.mjs";
import { verifyDeliveryQueue } from "../../../indexer/test/helpers/delivery-integration.mjs";
import { verifySingleRelayer } from "../../../indexer/test/helpers/relayer-integration.mjs";
import { createValidatorRegistryChecks } from "./validator-set-registry.mjs";
import { createCertificateChecks } from "./pbft-certificate-contract.mjs";
import { encodeCertificate, snapshotContext } from "./pbft-certificate.mjs";
import { createMerkleInclusionChecks, snapshotInclusions, forgedPathRoot, flipMerkleHash } from "../../../indexer/test/helpers/merkle-inclusion-contract.mjs";
import { createActualMessageDomainChecks } from "./message-domain-scenarios.mjs";
import { createMessageReplayChecks } from "./message-replay-scenarios.mjs";
import { verifyDestinationExecution } from "./destination-execution-scenarios.mjs";

const quiet = { log() {},warn() {},error() {} };

export async function verifyValidatorRotation({ sourceConfig,sourcePool,snapshot,nextMessageId,pidFile,registryAddress,registryRpcUrl,certificateVerifierAddress,merkleInclusionVerifierAddress,messageDomainContext,replayContext,produceBusinessMessage }) {
  const original = await sourceState(sourcePool,sourceConfig.databaseSchema);
  const config = { ...sourceConfig,databaseSchema: "cross_chain_rotation_source",
    sourceGatewayStartBlock: snapshot.batch.messages.reduce((first,message) => message.sourceBlockNumber < first ? message.sourceBlockNumber : first,snapshot.batch.messages[0].sourceBlockNumber) };
  const keys = developmentKeys(5);
  const reservations = []; const rpcProxies = []; const peerProxies = []; const pools = [];
  const processes = createValidatorProcesses({ keys,pidFile });
  const validators = []; const states = []; const environments = [];
  let failed = false;
  try {
    const pool = createDatabasePool(config); pools.push(pool);
    await applyMigrations(pool,config.databaseSchema); await resetIndexerTables(pool,config.databaseSchema);
    await createIndexer({ config,pool,logger: quiet }).catchUpOnce();
    await createFinalityWatcher({ config,pool,logger: quiet }).runFinalityPass();
    const messages = await readMessages(pool,config.databaseSchema);
    const oldMessages = messages.filter((row) => snapshot.batch.messageIds.includes(row.message_id));
    const newMessages = messages.filter((row) => row.message_id === nextMessageId);
    assert.equal(oldMessages.length,3); assert.equal(newMessages.length,1);
    assert.ok([...oldMessages,...newMessages].every((row) => row.status === "FINALIZED"));
    for (let index = 0; index < 5; index++) { reservations.push(await reservePort()); rpcProxies.push(await rpcObserver(config.chainRpcUrl)); }
    const peers = keys.map((key,index) => ({ address: validatorAccount(key).address.toLowerCase(),url: `http://127.0.0.1:${reservations[index].port}` }));
    // Keep V5 live through the focused rotated-primary crash, so its signature
    // must be needed in the remaining three-member quorum.
    let oldEpoch = snapshot.record.epoch + 40n;
    while (deterministicPrimary(peers.slice(1),oldEpoch + 1n) === peers[4].address) oldEpoch += 1n;
    const newEpoch = oldEpoch + 1n;
    const validatorSets = createValidatorSetResolver([
      { validatorEpoch: "7",activationBatchEpoch: "0",validators: peers.slice(0,4).map((peer) => peer.address) },
      { validatorEpoch: "8",activationBatchEpoch: newEpoch.toString(),validators: peers.slice(1).map((peer) => peer.address) },
    ]);
    const registryChecks = await createValidatorRegistryChecks({
      registryAddress, rpcUrl: registryRpcUrl, history: validatorSets.history,
    });
    const certificateChecks = await createCertificateChecks({ client: registryChecks.client,
      address: certificateVerifierAddress, registryAddress });
    const merkleChecks = await createMerkleInclusionChecks({ client: registryChecks.client,
      address: merkleInclusionVerifierAddress });
    const domainChecks = await createActualMessageDomainChecks({ client: registryChecks.client,
      rpcUrl: registryRpcUrl, sourceConfig: config, context: messageDomainContext });
    const lifecycle = createBatchLifecycle({ config,pool,committee: peers,validatorSets });
    async function seal(expectedEpoch,rows) {
      // initialEpoch anchors the complete batch history. Subsequent batches
      // advance through the lifecycle without changing that initial value.
      const building = await lifecycle.getOrCreateBuilding({ initialEpoch: oldEpoch });
      assert.equal(building.record.epoch,expectedEpoch);
      await lifecycle.assignMessages({ batchRecordId: building.record.batchRecordId,sourceMessageIds: rows.map((row) => row.id) });
      await lifecycle.sealBatch({ batchRecordId: building.record.batchRecordId });
      return lifecycle.markConsensusPending({ batchRecordId: building.record.batchRecordId });
    }
    const oldBatch = await seal(oldEpoch,oldMessages);
    const newBatch = await seal(newEpoch,newMessages);
    assert.equal(newBatch.record.epoch,oldBatch.record.epoch + 1n);
    assert.equal(oldBatch.consensusBinding.validatorEpoch,"7");
    assert.equal(newBatch.consensusBinding.validatorEpoch,"8");
    assert.deepEqual(await lifecycle.readBatch({ batchRecordId: oldBatch.record.batchRecordId }),oldBatch);
    console.log("VALID: fixed initial batch epoch produced consecutive pending batches with immutable validator epoch 7 and 8 bindings");
    const sourceBefore = await sourceState(pool,config.databaseSchema);
    for (let index = 0; index < 5; index++) {
      environments.push({ VALIDATOR_PRIVATE_KEY: keys[index],VALIDATOR_LISTEN_HOST: "127.0.0.1",VALIDATOR_LISTEN_PORT: String(reservations[index].port),
        VALIDATOR_PEERS: JSON.stringify(peers),VALIDATOR_SET_HISTORY_FILE: "",VALIDATOR_SET_HISTORY: JSON.stringify(index % 2 ? [...validatorSets.history].reverse() : validatorSets.history),
        SOURCE_DATABASE_URL: config.databaseUrl,SOURCE_DB_SCHEMA: config.databaseSchema,
        VALIDATOR_DATABASE_URL: process.env.VALIDATOR_VERIFICATION_DATABASE_URL || config.databaseUrl,VALIDATOR_DB_SCHEMA: `cross_chain_rotation_v${index + 1}`,
        CHAIN_A_DOMAIN: config.chainDomain.toString(),SOURCE_GATEWAY_ADDRESS: config.sourceGateway,
        CHAIN_A_RPC_URL: rpcProxies[index].url,FINALITY_BLOCK_DEPTH: config.finalityBlockDepth.toString(),PBFT_VIEW_TIMEOUT_MS: "3600000" });
      states.push(await initializeValidatorState(environments[index],(localPool) => pools.push(localPool)));
      await reservations[index].release(); validators.push(await processes.start(environments[index]));
    }
    assert.equal(new Set(validators.map((record) => record.child.pid)).size,5);
    assert.equal(new Set(peers.map((peer) => peer.address)).size,5);
    assert.equal(new Set(states.map((state) => state.config.databaseSchema)).size,5);
    const request = (index,route,body) => processes.request(peers[index].url,route,body);
    async function until(label,predicate,live,timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      do {
        for (const index of live) {
          assert.equal(validators[index].exited,false);
          assert.ok(!validators[index].stderr.includes("PBFT scheduler halted:"), `validator ${index + 1} scheduler halted`);
        }
        const result = await predicate(); if (result) return result;
        await pause(25);
      } while (Date.now() < deadline);
      assert.fail(`rotation timed out waiting for ${label}`);
    }
    for (let index = 0; index < 5; index++) {
      assert.deepEqual((await request(index,"/validator-sets")).body.history,validatorSets.history);
      for (const epoch of [oldEpoch,newEpoch]) {
        const selected = await request(index,"/pbft/primary",{ epoch: epoch.toString(),view: "0" });
        assert.equal(selected.status,200);
        assert.equal(selected.body.validatorEpoch,validatorSets.resolveForBatchEpoch(epoch).validatorEpoch);
      }
    }
    assert.ok(!(await states[4].store.readObservations()).some((row) => row.batch_id === oldBatch.record.batchId));
    assert.equal(await states[4].store.readPrePrepare(oldEpoch),null);
    assert.ok(!(await states[0].store.readViewStates()).some((row) => row.epoch === newEpoch.toString()));
    const stolen = loadValidatorConfig({ ...environments[0],VALIDATOR_DB_SCHEMA: states[4].config.databaseSchema });
    await assert.rejects(createValidatorStore({ pool: states[4].pool,config: stolen }).bindIdentity(), /identity or source context mismatch/);

    const oldPrimary = peers.findIndex((peer) => peer.address === deterministicPrimary(validatorSets.history[0].validators,oldEpoch));
    assert.equal((await request(oldPrimary,"/pbft/propose",{ batchId: oldBatch.record.batchId })).status,200);
    const oldProposal = (await states[oldPrimary].store.readPrePrepare(oldEpoch)).envelope;
    assert.equal(oldProposal.validatorEpoch,"7");
    // The future batch is already pinned to epoch 8; the in-flight old batch
    // retains epoch 7 at every node and cannot be rebound by that schedule.
    for (let index = 0; index < 4; index++) {
      const row = (await states[index].store.readViewStates()).find((row) => row.epoch === oldEpoch.toString());
      assert.equal(row.validator_epoch,"7");
      await assert.rejects(states[index].store.registerEpoch({ ...oldProposal,validatorEpoch: "8",committeeDigest: validatorSets.history[1].committeeDigest }), /WRONG_VALIDATOR_EPOCH/);
    }
    for (const index of [0,1,2]) assert.equal((await request(index,"/pbft/prepare/cast",{ epoch: oldEpoch.toString() })).status,200);
    for (const index of [0,1,2]) assert.equal((await request(index,"/pbft/commit/cast",{ epoch: oldEpoch.toString() })).status,200);
    const oldQc = (await request(0,"/pbft/qc",{ epoch: oldEpoch.toString() })).body.certificate;
    await registryChecks.assertQcBinding(oldQc);
    assert.equal((await request(0,"/pbft/qc/submit",oldQc)).status,200);
    const oldCommitted = await lifecycle.readBatch({ batchRecordId: oldBatch.record.batchRecordId });
    assert.equal(oldCommitted.record.status,"COMMITTED"); assert.equal(oldQc.validatorEpoch,"7");
    assert.equal(oldQc.commits.length,3);
    const oldContext = snapshotContext(oldCommitted);
    const oldEncoded = encodeCertificate(oldCommitted.quorumCertificate);
    await certificateChecks.accept(oldEncoded, oldContext, "actual epoch 7 A/B/D quorum");
    // These exact expectations have just been authenticated; proof metadata supplies no authority.
    const oldInclusions = snapshotInclusions(oldCommitted, oldContext);
    await merkleChecks.members(oldInclusions, "QC-authenticated actual epoch 7 A/B/D batch");
    await domainChecks.members(oldCommitted, oldInclusions, "actual epoch 7 A/B/D after QC and Merkle authentication");

    const active = [1,2,3,4];
    const newPrimary = peers.findIndex((peer) => peer.address === deterministicPrimary(validatorSets.history[1].validators,newEpoch));
    assert.ok(active.includes(newPrimary)); assert.notEqual(newPrimary,4);
    const proposed = await request(newPrimary,"/pbft/propose",{ batchId: newBatch.record.batchId });
    assert.equal(proposed.status,200);
    assert.ok(proposed.body.deliveries.every((delivery) => delivery.peerAddress !== peers[0].address));
    const proposal = (await states[newPrimary].store.readPrePrepare(newEpoch)).envelope;
    const statement = expectedCommitStatement(proposal,states[newPrimary].config);
    const removedPrepare = { messageType: "PREPARE",...statement,voterIdentity: peers[0].address };
    removedPrepare.prepareDigest = prepareDigest(removedPrepare);
    removedPrepare.signature = await validatorAccount(keys[0]).signMessage({ message: { raw: removedPrepare.prepareDigest } });
    const removedCommit = await signedCommitFixture(statement,states[0].config);
    const removedView = { messageType: "VIEW_CHANGE",protocolVersion: "3",sourceDomain: statement.sourceDomain,sourceGateway: statement.sourceGateway,
      epoch: statement.epoch,validatorEpoch: statement.validatorEpoch,committeeDigest: statement.committeeDigest,targetView: "1",voterIdentity: peers[0].address,
      acceptedProposal: null,preparedCertificate: null };
    removedView.viewChangeDigest = viewChangeDigest(removedView);
    removedView.signature = await validatorAccount(keys[0]).signMessage({ message: { raw: removedView.viewChangeDigest } });
    for (const [route,vote] of [["prepare",removedPrepare],["commit",removedCommit],["view-change",removedView]]) {
      const rejected = await request(4,`/pbft/${route}`,vote);
      assert.equal(rejected.status,422); assert.equal(rejected.body.reason,"UNKNOWN_VALIDATOR");
    }
    const futureVote = await signedCommitFixture(expectedCommitStatement(oldProposal,states[4].config),states[4].config);
    const rejected = await request(1,"/pbft/commit",futureVote);
    assert.equal(rejected.status,422); assert.equal(rejected.body.reason,"UNKNOWN_VALIDATOR");
    assert.equal((await states[4].store.readPrepareState(newEpoch)).voteCount,0);
    // V1 remains online. Correct membership does not depend on stopping it.
    assert.equal((await request(0,"/health")).status,200);
    await processes.stop(validators[newPrimary]);
    const backups = active.filter((index) => index !== newPrimary);
    for (const index of backups) {
      await processes.stop(validators[index]); environments[index].PBFT_VIEW_TIMEOUT_MS = "3000";
      validators[index] = await processes.start(environments[index]);
    }
    const newCommitted = await until("rotated committee COMMITTED",async () => {
      const value = await lifecycle.readBatch({ batchRecordId: newBatch.record.batchRecordId });
      return value.record.status === "COMMITTED" ? value : null;
    },[0,...backups]);
    const qc = newCommitted.quorumCertificate;
    assert.equal(qc.validatorEpoch,"8"); assert.ok(BigInt(qc.view) >= 1n);
    assert.equal(qc.commits.length,3); assert.ok(qc.commits.some((vote) => vote.voterIdentity === peers[4].address));
    assert.ok(qc.commits.every((vote) => vote.voterIdentity !== peers[0].address && vote.voterIdentity !== peers[newPrimary].address));
    await verifyQuorumCertificate(qc,{ peers,validatorSets,expected: { ...statement,view: qc.view,proposalDigest: undefined } });
    const newContext = snapshotContext(newCommitted);
    const newEncoded = encodeCertificate(newCommitted.quorumCertificate);
    await certificateChecks.accept(newEncoded, newContext, "actual epoch 8 quorum includes V5 after view recovery");
    const newInclusions = snapshotInclusions(newCommitted, newContext);
    await merkleChecks.members(newInclusions, "QC-authenticated actual epoch 8 Message E batch");
    await domainChecks.members(newCommitted, newInclusions, "actual epoch 8 Message E after QC and Merkle authentication");
    for (const index of backups) {
      const accepted = await states[index].store.readNewView(newEpoch,qc.view);
      await authenticateNewView(states[index].config,accepted,proposalIdentity(statement));
      assert.equal(accepted.validatorEpoch,"8"); assert.equal(accepted.committeeDigest,validatorSets.history[1].committeeDigest);
      const votes = await states[index].store.readViewChanges(newEpoch,qc.view);
      assert.ok(votes.every((vote) => vote.validatorEpoch === "8" && vote.voterIdentity !== peers[0].address));
    }
    for (const index of [0,...backups]) for (const certificate of [oldQc,qc]) {
      const result = await request(index,"/pbft/qc/verify",certificate);
      assert.equal(result.status,200); assert.equal(result.body.qcDigest,certificate.qcDigest);
    }
    await processes.stop(validators[0]);
    assert.equal((await request(4,"/pbft/qc/verify",oldQc)).status,200);
    await registryChecks.assertHistory();
    await registryChecks.assertQcBinding(oldQc);
    await registryChecks.assertQcBinding(qc);
    const oldAfterRotation = await lifecycle.readBatch({ batchRecordId: oldBatch.record.batchRecordId });
    const newAfterRotation = await lifecycle.readBatch({ batchRecordId: newBatch.record.batchRecordId });
    assert.deepEqual(oldAfterRotation, oldCommitted);
    assert.deepEqual(newAfterRotation, newCommitted);
    const oldAfterInclusions = snapshotInclusions(oldAfterRotation, oldContext);
    const newAfterInclusions = snapshotInclusions(newAfterRotation, newContext);
    assert.deepEqual(oldAfterInclusions, oldInclusions);
    assert.deepEqual(newAfterInclusions, newInclusions);
    await certificateChecks.accept(oldEncoded, oldContext, "old epoch 7 QC still verifies after rotation and V1 shutdown");
    await merkleChecks.members(oldAfterInclusions, "unchanged authenticated old proofs after rotation and V1 shutdown");
    await domainChecks.members(oldAfterRotation, oldAfterInclusions, "unchanged historical full messages after V1 shutdown");
    await certificateChecks.accept(newEncoded, newContext, "epoch 8 QC still verifies after V1 shutdown");
    await merkleChecks.members(newAfterInclusions, "authenticated rotated Message E proof after V1 shutdown");
    await domainChecks.members(newAfterRotation, newAfterInclusions, "rotated full Message E after V1 shutdown");
    await merkleChecks.negatives(oldInclusions, "actual epoch 7 A/B/D batch");
    await merkleChecks.negatives(newInclusions, "actual epoch 8 Message E batch");
    const standalone = oldInclusions[0];
    const forgedProof = { ...standalone.proof, siblings: [...standalone.proof.siblings] };
    forgedProof.siblings[0] = flipMerkleHash(forgedProof.siblings[0]);
    const unauthenticatedRoot = forgedPathRoot(standalone, forgedProof);
    assert.notEqual(unauthenticatedRoot, oldContext.messageRoot);
    await certificateChecks.reject(oldEncoded, { ...oldContext, messageRoot: unauthenticatedRoot },
      "ContextMismatch", "unauthenticated different root is rejected before combined membership acceptance");
    await merkleChecks.accept({ ...standalone, proof: forgedProof, messageRoot: unauthenticatedRoot },
      "standalone membership only under different root; original QC gives it no authorization");
    console.log("VALID: QC authentication and Merkle inclusion remain independent; a valid self-selected path supplies no batch authorization");
    await certificateChecks.reject(oldEncoded, { ...oldContext, messageRoot: qc.messageRoot },
      "ContextMismatch", "actual QC / wrong trusted message root");
    await certificateChecks.reject(oldEncoded, { ...oldContext, authorityEpoch: "8" },
      "ContextMismatch", "actual old QC / rotated authority context");
    const changedEpoch = { ...oldQc, validatorEpoch: "8" };
    await certificateChecks.reject(encodeCertificate(changedEpoch), { ...oldContext, authorityEpoch: "8" },
      "CommitteeDigestMismatch", "old signatures cannot be relabeled as epoch 8 evidence");
    await certificateChecks.reject(encodeCertificate({ ...oldQc, commits: oldQc.commits.slice(0,2) }), oldContext,
      "InvalidEvidenceCount", "actual QC / insufficient evidence");
    const duplicate = structuredClone(oldQc);
    duplicate.commits[1] = structuredClone(duplicate.commits[0]);
    await certificateChecks.reject(encodeCertificate(duplicate), oldContext,
      "NoncanonicalSigners", "actual QC / duplicate recovered identity");
    const tampered = structuredClone(oldQc);
    tampered.commits[0].signature = `0x${"00".repeat(65)}`;
    await certificateChecks.reject(encodeCertificate(tampered), oldContext,
      "InvalidSignature", "actual QC / tampered signature");
    // This is a correctly signed COMMIT by V5, who has no authority in historical epoch 7.
    const nonmember = structuredClone(oldQc);
    nonmember.commits[2] = futureVote;
    nonmember.commits.sort((a,b) => a.voterIdentity < b.voterIdentity ? -1 : 1);
    await certificateChecks.reject(encodeCertificate(nonmember), oldContext,
      "NonmemberSigner", "actual old QC / correctly signed nonmember V5");
    console.log("VALID: Chain B historical epoch 7 stayed unchanged through real epoch 8 consensus, view recovery and V1 shutdown");
    assert.deepEqual(oldAfterRotation,oldCommitted);
    assert.deepEqual(newCommitted.batch,newBatch.batch); assert.deepEqual(newCommitted.members,newBatch.members); assert.deepEqual(newCommitted.tree,newBatch.tree);
    const deliveryPackages = await verifyDeliveryQueue({ config, pool, snapshots: [oldCommitted,newCommitted], validatorSets,
      orphanMessageIds: original.source_messages.filter((row) => row.status === "REORGED").map((row) => row.message_id) });
    const domainEntries = [
      { snapshot: oldCommitted, inputs: oldInclusions, context: oldContext, encoded: oldEncoded },
      { snapshot: newCommitted, inputs: newInclusions, context: newContext, encoded: newEncoded },
    ];
    await domainChecks.packages(domainEntries, deliveryPackages);
    await domainChecks.negatives(oldCommitted, oldInclusions, merkleChecks, "actual epoch 7 A/B/D full message");
    await domainChecks.negatives(newCommitted, newInclusions, merkleChecks, "actual epoch 8 Message E full message");
    for (const orphan of original.source_messages.filter((row) => row.status === "REORGED")) {
      const input = oldInclusions[0];
      await merkleChecks.reject({ ...input, messageId: orphan.message_id }, "MemberMessageIdMismatch",
        [BigInt(input.index), orphan.message_id, input.messageId], "REORGED C has no authenticated committed membership");
    }
    await verifySingleRelayer({ config, pool, snapshots: [oldCommitted,newCommitted], validatorSets,
      orphanMessageIds: original.source_messages.filter((row) => row.status === "REORGED").map((row) => row.message_id) });
    // Transport workers have stopped: isolate policy mutations/time in a reversible destination snapshot.
    const beforeDomainPolicy = await sourceState(pool,config.databaseSchema);
    const replayChecks = await createMessageReplayChecks({ client: registryChecks.client, rpcUrl: registryRpcUrl,
      context: replayContext, domainContext: messageDomainContext, certificateVerifierAddress,
      merkleInclusionVerifierAddress, certificateChecks, merkleChecks, domainChecks });
    await replayChecks.run(domainEntries);
    await domainChecks.policyLifecycle(domainEntries, certificateChecks, merkleChecks, replayChecks);
    await replayChecks.assertState("after restoring temporary registry/time changes");
    assert.deepEqual(await sourceState(pool,config.databaseSchema), beforeDomainPolicy);
    const after = await sourceState(pool,config.databaseSchema);
    for (const table of ["source_messages","indexed_source_blocks","indexer_cursors","message_batch_members","batch_consensus_bindings"]) assert.deepEqual(after[table],sourceBefore[table]);
    assert.equal(after.batch_quorum_certificates.length,2);
    assert.equal((await pool.query(`SELECT COUNT(DISTINCT message_root)::int AS roots FROM ${tableName(config.databaseSchema,"message_batches")} WHERE status = 'COMMITTED' AND epoch = $1`,[oldEpoch.toString()])).rows[0].roots,1);
    console.log("VALID: five independent validator identities/PIDs/endpoints/stores resolved the same immutable history; each epoch retained exactly four active members");
    console.log("VALID: validator epoch 8 used V2/V3/V4/V5, rejected online V1, and required V5 in its rotated view-change quorum and final QC");
    console.log("VALID: historical epoch 7 QC remained valid after rotation and V1 shutdown; old and new votes never mixed and both committed batches retained their immutable roots");
    // All old-history equality assertions above remain intact. New business history is additive.
    await verifyDestinationExecution({ config, pool, lifecycle, validatorSets, peers, states, environments,
      validators, processes, peerProxies, request, until, produceMessage: produceBusinessMessage,
      historical: [oldCommitted, newCommitted], rpcUrl: registryRpcUrl, registryChecks,
      certificateChecks, merkleChecks, domainVerifierAddress: messageDomainContext.verifierAddress });
  } catch (error) {
    failed = true;
    console.error(`ROTATION FAILED before cleanup: ${error.message}`);
    for (let index = 0; index < states.length; index++) {
      try {
        const rows = await states[index].store.readViewStates();
        console.error(JSON.stringify({ validator: states[index].config.validatorAddress,states: rows.map((row) => ({ batchEpoch: row.epoch,validatorEpoch: row.validator_epoch,view: row.current_view,target: row.target_view,finalized: row.finalized })) }));
      } catch (diagnostic) { console.error(`Rotation state unavailable (${diagnostic.code ?? diagnostic.name})`); }
    }
    throw error;
  } finally {
    try { await closeScenarioResources({ processes,peerProxies,rpcProxies,reservations,pools }); }
    catch (error) { if (!failed) throw error; console.error(`Cleanup also failed: ${error.message}`); }
  }
  assert.deepEqual(await sourceState(sourcePool,sourceConfig.databaseSchema),original);
}
