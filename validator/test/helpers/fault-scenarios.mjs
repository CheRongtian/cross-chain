import assert from "node:assert/strict";
import { recoverMessageAddress } from "viem";
import { committeeDigest } from "../../src/committee.mjs";
import { createValidatorSetResolver } from "../../src/validator-sets.mjs";
import { validatorAccount } from "../../src/identity.mjs";
import { deterministicPrimary } from "../../src/committee.mjs";
import { prePrepareDigest } from "../../src/pre-prepare.mjs";
import { authenticatePrepare, prepareDigest } from "../../src/prepare.mjs";
import { authenticateCommit, commitDigest } from "../../src/commit.mjs";
import { expectedCommitStatement, qcDigest, verifyQuorumCertificate } from "../../src/quorum-certificate.mjs";
import { applyMigrations, createDatabasePool, readMessages, resetIndexerTables, tableName } from "../../../indexer/src/db.mjs";
import { createIndexer } from "../../../indexer/src/indexer.mjs";
import { createFinalityWatcher } from "../../../indexer/src/finality-watcher.mjs";
import { createBatchLifecycle } from "../../../indexer/src/batch-lifecycle.mjs";
import { normalizeBatchEpoch } from "../../../indexer/src/batch-lifecycle-policy.mjs";
import { developmentKeys } from "./fixtures.mjs";
import { closeScenarioResources, createValidatorProcesses, initializeValidatorState, reservePort, rpcObserver } from "./process-cluster.mjs";
import { createPeerProxy, createTransportGate } from "./fault-transport.mjs";
import { sourceState } from "./four-process.mjs";

const quiet = { log() {}, warn() {}, error() {} };

export async function createScenario({ name, epoch, sourceConfig, template, orphanIds, pidFile, viewTimeoutMs = "3600000" }) {
  const prefix = `cross_chain_fault_${name}`;
  const config = { ...sourceConfig, databaseSchema: `${prefix}_source`,
    sourceGatewayStartBlock: template.batch.messages.reduce((first, message) =>
      message.sourceBlockNumber < first ? message.sourceBlockNumber : first, template.batch.messages[0].sourceBlockNumber) };
  const keys = developmentKeys();
  const pools = [];
  const reservations = [];
  const rpcProxies = [];
  const peerProxies = [];
  const processes = createValidatorProcesses({ keys, pidFile });
  let closing;
  function close() {
    if (!closing) closing = closeScenarioResources({ processes, peerProxies, rpcProxies, reservations, pools });
    return closing;
  }
  try {
    const sourcePool = createDatabasePool(config); pools.push(sourcePool);
    await applyMigrations(sourcePool, config.databaseSchema);
    await resetIndexerTables(sourcePool, config.databaseSchema);
    await createIndexer({ config, pool: sourcePool, logger: quiet }).catchUpOnce();
    await createFinalityWatcher({ config, pool: sourcePool, logger: quiet }).runFinalityPass();
    const messages = await readMessages(sourcePool, config.databaseSchema);
    const selected = messages.filter((row) => template.batch.messageIds.includes(row.message_id));
    assert.equal(selected.length, 3);
    assert.ok(selected.every((row) => row.status === "FINALIZED" && !orphanIds.has(row.message_id)));

    for (let index = 0; index < 4; index++) {
      reservations.push(await reservePort()); rpcProxies.push(await rpcObserver(config.chainRpcUrl));
    }
    const peers = keys.map((key, index) => ({ address: validatorAccount(key).address.toLowerCase(),
      url: `http://127.0.0.1:${reservations[index].port}` }));
    const gate = createTransportGate(peers.map((peer) => peer.address));
    const links = Array.from({ length: 4 }, () => new Map());
    for (let from = 0; from < 4; from++) for (let to = 0; to < 4; to++) {
      if (from === to) continue;
      const proxy = await createPeerProxy({ from: peers[from].address, to: peers[to].address,
        targetUrl: peers[to].url, gate, signal: processes.signal });
      peerProxies.push(proxy); links[from].set(to, proxy);
    }
    const validatorSets = createValidatorSetResolver([{ validatorEpoch: "0", activationBatchEpoch: "0", validators: peers.map((peer) => peer.address), committeeDigest: committeeDigest(peers) }]);
    const lifecycle = createBatchLifecycle({ config, pool: sourcePool, committee: peers, validatorSets });
    const building = await lifecycle.getOrCreateBuilding({ initialEpoch: epoch });
    await lifecycle.assignMessages({ batchRecordId: building.record.batchRecordId, sourceMessageIds: selected.map((row) => row.id) });
    await lifecycle.sealBatch({ batchRecordId: building.record.batchRecordId });
    const pending = await lifecycle.markConsensusPending({ batchRecordId: building.record.batchRecordId });
    assert.deepEqual(pending.batch.messageIds, template.batch.messageIds);
    assert.ok(pending.batch.messageIds.every((id) => !orphanIds.has(id)));
    const before = await sourceState(sourcePool, config.databaseSchema);
    const environments = peers.map((peer, index) => ({
      VALIDATOR_PRIVATE_KEY: keys[index], VALIDATOR_LISTEN_HOST: "127.0.0.1", VALIDATOR_LISTEN_PORT: String(reservations[index].port),
      VALIDATOR_SET_HISTORY_FILE: "", VALIDATOR_SET_HISTORY: JSON.stringify(validatorSets.history),
      VALIDATOR_PEERS: JSON.stringify(peers.map((entry, other) => ({ address: entry.address,
        url: index === other ? entry.url : links[index].get(other).url })).reverse()),
      VALIDATOR_DATABASE_URL: process.env.VALIDATOR_VERIFICATION_DATABASE_URL || config.databaseUrl,
      VALIDATOR_DB_SCHEMA: `${prefix}_v${index + 1}`, SOURCE_DATABASE_URL: config.databaseUrl,
      SOURCE_DB_SCHEMA: config.databaseSchema, CHAIN_A_DOMAIN: config.chainDomain.toString(),
      SOURCE_GATEWAY_ADDRESS: config.sourceGateway, CHAIN_A_RPC_URL: rpcProxies[index].url,
      FINALITY_BLOCK_DEPTH: config.finalityBlockDepth.toString(), PBFT_VIEW_TIMEOUT_MS: String(viewTimeoutMs),
    }));
    const states = [];
    const validators = [];
    for (let index = 0; index < 4; index++) {
      states.push(await initializeValidatorState(environments[index], (pool) => pools.push(pool)));
      await reservations[index].release();
      validators.push(await processes.start(environments[index]));
    }
    const primary = peers.findIndex((peer) => peer.address === deterministicPrimary(peers, epoch));
    assert.ok(primary >= 0);
    const backups = peers.map((_peer, index) => index).filter((index) => index !== primary);
    const statement = expectedCommitStatement({ sourceDomain: config.chainDomain, sourceGateway: config.sourceGateway,
      epoch, ...pending.consensusBinding, batchId: pending.record.batchId, messageRoot: pending.record.messageRoot }, peers, validatorSets);
    const options = { peers, expected: statement };
    async function request(index, route, body) { return processes.request(peers[index].url, route, body); }
    async function send(from, to, route, body) { return processes.request(links[from].get(to).url, route, body); }
    async function assertAlive(indices) {
      const pids = [];
      for (const index of indices) {
        assert.equal(validators[index].exited, false);
        process.kill(validators[index].child.pid, 0);
        const health = await request(index, "/health");
        assert.equal(health.status, 200); assert.equal(health.body.ready, true);
        assert.equal(health.body.pid, validators[index].child.pid); pids.push(health.body.pid);
      }
      assert.equal(new Set(pids).size, indices.length);
    }
    async function stop(index) {
      const pid = validators[index].child.pid;
      await processes.stop(validators[index]);
      assert.equal(validators[index].exited, true);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await assert.rejects(request(index, "/health"));
    }
    async function restart(index) {
      const previousPid = validators[index].child.pid;
      validators[index] = await processes.start(environments[index]);
      assert.notEqual(validators[index].child.pid, previousPid);
      await assertAlive([index]);
    }
    async function propose(participants) {
      const result = await request(primary, "/pbft/propose", { batchId: pending.record.batchId });
      assert.equal(result.status, 200); assert.equal(result.body.result, "ACCEPTED");
      assert.equal(result.body.proposalDigest, statement.proposalDigest);
      for (const index of participants) {
        const accepted = await states[index].store.readPrePrepare(epoch);
        assert.equal(accepted.envelope.proposalDigest, statement.proposalDigest);
        assert.ok(rpcProxies[index].calls.some((call) => call.method === "eth_getTransactionReceipt"), "source validation must use real Chain A receipts");
      }
      return result;
    }
    async function cast(index, phase) {
      const result = await request(index, `/pbft/${phase}/cast`, { epoch: epoch.toString() });
      assert.equal(result.status, 200); assert.equal(result.body.result, "ACCEPTED");
      return result.body;
    }
    async function assertPrepared(participants, voters) {
      for (const index of participants) {
        const state = await states[index].store.readPrepareState(epoch);
        assert.equal(state.voteCount, voters.length); assert.ok(state.prepared);
        assert.deepEqual(state.votes.map((vote) => vote.voterIdentity).sort(), voters.map((voter) => peers[voter].address).sort());
      }
    }
    async function finish(participants) {
      await assertPrepared(participants, participants);
      const commits = [];
      for (const index of participants) {
        commits.push(await cast(index, "commit"));
        if (commits.length === 2) {
          for (const receiver of participants) {
            const state = await states[receiver].store.readCommitState(epoch);
            assert.equal(state.voteCount, 2); assert.equal(state.quorum, null); assert.equal(state.certificate, null);
          }
          assert.equal((await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId })).record.status, "CONSENSUS_PENDING");
        }
      }
      for (const index of participants) {
        const state = await states[index].store.readCommitState(epoch);
        assert.equal(state.voteCount, participants.length); assert.ok(state.quorum);
        assert.deepEqual(state.votes.map((vote) => vote.voterIdentity).sort(), participants.map((voter) => peers[voter].address).sort());
      }
      const result = await request(participants[0], "/pbft/qc", { epoch: epoch.toString() });
      assert.equal(result.status, 200);
      const certificate = await verifyQuorumCertificate(result.body.certificate, options);
      assert.equal(certificate.commits.length, 3);
      const submit = await request(participants[0], "/pbft/qc/submit", certificate);
      assert.equal(submit.status, 200); assert.equal(submit.body.status, "COMMITTED");
      const committed = await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId });
      assert.equal(committed.record.status, "COMMITTED");
      assert.deepEqual(committed.batch, pending.batch); assert.deepEqual(committed.tree, pending.tree);
      assert.deepEqual(committed.members, pending.members);
      await verifyQuorumCertificate(committed.quorumCertificate, options);
      const retry = await cast(participants[0], "commit");
      assert.deepEqual(retry.record.vote, commits[0].record.vote);
      assert.deepEqual(await lifecycle.readBatch({ batchRecordId: pending.record.batchRecordId }), committed);
      return committed;
    }
    async function assertSource(committed, conflictingRoot) {
      const after = await sourceState(sourcePool, config.databaseSchema);
      for (const name of ["source_messages", "indexer_cursors", "indexed_source_blocks", "message_batch_members", "batch_consensus_bindings"]) {
        assert.deepEqual(after[name], before[name]);
      }
      assert.deepEqual(after.message_batches.map((row) => committed && row.batch_record_id === pending.record.batchRecordId
        ? { ...row, status: "CONSENSUS_PENDING", committed_at: null } : row), before.message_batches);
      const rootCount = (await sourcePool.query(`SELECT COUNT(DISTINCT message_root)::int AS count
        FROM ${tableName(config.databaseSchema, "message_batches")}
        WHERE source_domain = $1 AND source_gateway = $2 AND epoch = $3 AND status = 'COMMITTED'`,
      [config.chainDomain.toString(), config.sourceGateway, epoch.toString()])).rows[0].count;
      assert.ok(rootCount <= 1); assert.equal(rootCount, committed ? 1 : 0);
      assert.equal(after.batch_quorum_certificates.length, committed ? 1 : 0);
      assert.equal(after.batch_quorum_certificate_signatures.length, committed ? 3 : 0);
      if (conflictingRoot) {
        assert.equal(after.batch_quorum_certificates.filter((row) => row.message_root === conflictingRoot).length, 0);
        assert.equal(after.message_batches.filter((row) => row.status === "COMMITTED" && row.message_root === conflictingRoot).length, 0);
      }
    }
    await assertAlive([0, 1, 2, 3]);
    console.log(`Fault scenario: ${name}; epoch=${epoch}; primary=${peers[primary].address}; real finalized A/B/D reconstructed`);
    return { config, sourcePool, lifecycle, pending, peers, keys, states, validators, environments, gate, links, peerProxies,
      primary, backups, statement, options, validatorSets, request, send, stop, restart, assertAlive, propose, cast, assertPrepared, finish, assertSource, close };
  } catch (error) { await close(); throw error; }
}

async function nonPrimaryCrash(ctx) {
  const offline = ctx.backups.at(-1);
  assert.notEqual(offline, ctx.primary);
  const live = [0, 1, 2, 3].filter((index) => index !== offline);
  await ctx.stop(offline); await ctx.assertAlive(live);
  await ctx.states[offline].store.checkIdentity();
  assert.deepEqual(await ctx.states[offline].store.readPrePrepares(), []);
  await ctx.propose(live);
  for (const index of live) {
    const result = await ctx.cast(index, "prepare");
    assert.equal(result.deliveries.find((entry) => entry.peerAddress === ctx.peers[offline].address).delivery, "FAILED");
  }
  const committed = await ctx.finish(live);
  assert.deepEqual(committed.quorumCertificate.commits.map((vote) => vote.voterIdentity).sort(), live.map((index) => ctx.peers[index].address).sort());
  assert.ok(committed.quorumCertificate.commits.every((vote) => vote.voterIdentity !== ctx.peers[offline].address));
  assert.deepEqual(await ctx.states[offline].store.readPrePrepares(), []);
  assert.deepEqual(await ctx.states[offline].store.readCommitStates(), []);
  await ctx.restart(offline);
  const recovered = await ctx.request(offline, "/pbft/qc/submit", committed.quorumCertificate);
  assert.equal(recovered.status, 200); assert.equal(recovered.body.qcDigest, committed.quorumCertificate.qcDigest);
  assert.deepEqual(await ctx.states[offline].store.readPrePrepares(), []);
  assert.deepEqual(await ctx.states[offline].store.readPrepareStates(), []);
  assert.deepEqual(await ctx.states[offline].store.readCommitStates(), []);
  await ctx.assertSource(true);
  console.log("VALID: one dynamically selected non-primary process was offline; exactly three live validators produced the QC without its signature");
  console.log("VALID: restarted offline validator independently verified the committed QC without claiming historical votes");
}

async function signAdversarial(ctx, index, fields, digestFunction) {
  const digest = digestFunction(fields);
  const signature = await validatorAccount(ctx.keys[index]).signMessage({ message: { raw: digest } });
  const signer = (await recoverMessageAddress({ message: { raw: digest }, signature })).toLowerCase();
  assert.equal(signer, ctx.peers[index].address);
  return { ...fields, signature,
    [fields.messageType === "PRE_PREPARE" ? "proposalDigest" : fields.messageType === "PREPARE" ? "prepareDigest" : "commitDigest"]: digest };
}

async function byzantineBackup(ctx) {
  const adversary = ctx.backups.at(-1);
  const honest = [0, 1, 2, 3].filter((index) => index !== adversary);
  const rootB = `0x${(BigInt(ctx.statement.messageRoot) ^ 1n).toString(16).padStart(64, "0")}`;
  assert.notEqual(rootB, ctx.statement.messageRoot);
  const badStatement = expectedCommitStatement({ ...ctx.statement, messageRoot: rootB, proposalDigest: undefined }, ctx.peers);
  const proposal = await signAdversarial(ctx, adversary, { messageType: "PRE_PREPARE", protocolVersion: "3", view: "0", validatorEpoch: ctx.statement.validatorEpoch, committeeDigest: ctx.statement.committeeDigest,
    sourceDomain: ctx.statement.sourceDomain, sourceGateway: ctx.statement.sourceGateway, epoch: ctx.statement.epoch,
    batchId: ctx.statement.batchId, messageRoot: rootB, primaryIdentity: ctx.peers[adversary].address }, prePrepareDigest);
  for (const index of honest) {
    const response = await ctx.send(adversary, index, "/pbft/pre-prepare", proposal);
    assert.equal(response.status, 422); assert.equal(response.body.reason, "WRONG_PRIMARY");
  }
  await ctx.propose([0, 1, 2, 3]);
  const acceptedBefore = await Promise.all(ctx.states.map((state) => state.store.readPrePrepares()));
  const badPrepare = await signAdversarial(ctx, adversary, { messageType: "PREPARE", protocolVersion: "3", view: "0",
    validatorEpoch: ctx.statement.validatorEpoch,committeeDigest: ctx.statement.committeeDigest,
    sourceDomain: badStatement.sourceDomain, sourceGateway: badStatement.sourceGateway, epoch: badStatement.epoch,
    batchId: badStatement.batchId, messageRoot: rootB, proposalDigest: badStatement.proposalDigest,
    voterIdentity: ctx.peers[adversary].address }, prepareDigest);
  const badCommit = await signAdversarial(ctx, adversary, { messageType: "COMMIT", ...badStatement,
    voterIdentity: ctx.peers[adversary].address }, commitDigest);
  // These are valid committee signatures. Accepted-proposal matching must reject them separately.
  await authenticatePrepare(ctx.states[honest[0]].config, badPrepare);
  await authenticateCommit(ctx.states[honest[0]].config, badCommit);
  for (const index of honest.slice(0, 2)) await ctx.cast(index, "prepare");
  for (const index of honest) {
    const rejection = await ctx.send(adversary, index, "/pbft/prepare", badPrepare);
    assert.equal(rejection.status, 422); assert.equal(rejection.body.reason, "WRONG_ROOT");
    const state = await ctx.states[index].store.readPrepareState(ctx.statement.epoch);
    assert.equal(state.voteCount, 2); assert.equal(state.prepared, null);
  }
  await ctx.cast(honest[2], "prepare"); await ctx.assertPrepared(honest, honest);
  const locksBefore = await Promise.all(honest.map((index) => ctx.states[index].store.readPrepareState(ctx.statement.epoch)));
  for (const index of honest) {
    assert.equal((await ctx.send(adversary, index, "/pbft/prepare", badPrepare)).status, 422);
    const rejection = await ctx.send(adversary, index, "/pbft/commit", badCommit);
    assert.equal(rejection.status, 422); assert.equal(rejection.body.reason, "WRONG_ROOT");
    assert.equal((await ctx.states[index].store.readCommitState(ctx.statement.epoch)).voteCount, 0);
  }
  const forged = { messageType: "QUORUM_CERTIFICATE", ...badStatement, qcDigest: qcDigest(badStatement), commits: [badCommit] };
  const duplicate = { ...forged, commits: [badCommit, badCommit, badCommit] };
  for (const certificate of [forged, duplicate]) {
    await assert.rejects(verifyQuorumCertificate(certificate, { peers: ctx.peers, expected: badStatement }));
    const response = await ctx.request(honest[0], "/pbft/qc/submit", certificate);
    assert.equal(response.status, 422);
  }
  const committed = await ctx.finish(honest);
  assert.deepEqual(committed.quorumCertificate.commits.map((vote) => vote.voterIdentity).sort(), honest.map((index) => ctx.peers[index].address).sort());
  const reused = { ...forged, commits: committed.quorumCertificate.commits };
  await assert.rejects(verifyQuorumCertificate(reused, { peers: ctx.peers, expected: badStatement }));
  assert.equal((await ctx.request(honest[0], "/pbft/qc/submit", reused)).status, 422);
  for (let position = 0; position < honest.length; position++) {
    const index = honest[position];
    assert.equal((await ctx.send(adversary, index, "/pbft/commit", badCommit)).status, 422);
    assert.deepEqual(await ctx.states[index].store.readPrepareState(ctx.statement.epoch), locksBefore[position]);
    assert.equal((await ctx.states[index].store.readCommitState(ctx.statement.epoch)).voteCount, 3);
    assert.deepEqual(await ctx.states[index].store.readPrePrepares(), acceptedBefore[index]);
  }
  assert.deepEqual(await ctx.lifecycle.readBatch({ batchRecordId: ctx.pending.record.batchRecordId }), committed);
  await ctx.assertSource(true, rootB);
  console.log("VALID: cryptographically valid conflicting-root messages from one backup had zero quorum weight; three honest processes committed only the canonical root");
  console.log("VALID: durable source queries found one committed root for this epoch and no conflicting certificate");
}

async function partitionAndHeal(ctx) {
  const indices = [0, 1, 2, 3];
  await ctx.propose(indices);
  const acceptedBefore = await Promise.all(ctx.states.map((state) => state.store.readPrePrepares()));
  for (const state of ctx.states) assert.equal((await state.store.readPrepareState(ctx.statement.epoch)).voteCount, 0);
  assert.ok(ctx.peerProxies.every((proxy) => proxy.records.every((record) => record.delivery !== "PENDING")));
  const initialPids = ctx.validators.map((record) => record.child.pid);
  ctx.gate.partition([ctx.peers.slice(0, 2).map((peer) => peer.address), ctx.peers.slice(2).map((peer) => peer.address)]);
  const savedVotes = [];
  for (const index of indices) {
    const result = await ctx.cast(index, "prepare"); savedVotes.push(result.record.vote);
    assert.equal(result.deliveries.filter((delivery) => delivery.delivery === "FAILED").length, 2);
  }
  for (const index of indices) {
    const state = await ctx.states[index].store.readPrepareState(ctx.statement.epoch);
    assert.equal(state.voteCount, 2); assert.equal(state.prepared, null);
    const group = index < 2 ? ctx.peers.slice(0, 2) : ctx.peers.slice(2);
    assert.deepEqual(state.votes.map((vote) => vote.voterIdentity).sort(), group.map((peer) => peer.address).sort());
    const rejected = await ctx.request(index, "/pbft/commit/cast", { epoch: ctx.statement.epoch });
    assert.equal(rejected.status, 422); assert.equal(rejected.body.reason, "NOT_PREPARED");
    const commits = await ctx.states[index].store.readCommitState(ctx.statement.epoch);
    assert.equal(commits.voteCount, 0); assert.equal(commits.quorum, null); assert.equal(commits.certificate, null);
    assert.equal((await ctx.request(index, "/pbft/qc", { epoch: ctx.statement.epoch })).status, 422);
    for (const other of indices) if (index !== other && (index < 2) !== (other < 2)) {
      assert.ok(ctx.links[index].get(other).records.some((record) => record.blocked && record.delivery === "BLOCKED"));
    }
  }
  await ctx.assertAlive(indices); await ctx.assertSource(false);
  console.log("VALID: four live processes in a bidirectional 2|2 partition had exactly two PREPARE voters each and no COMMIT quorum, QC, or committed batch");
  ctx.gate.heal();
  for (const index of indices) {
    const retry = await ctx.cast(index, "prepare");
    assert.deepEqual(retry.record.vote, savedVotes[index]);
    assert.ok(retry.deliveries.every((delivery) => delivery.delivery === "DELIVERED" && delivery.result === "ACCEPTED"));
    assert.deepEqual(await ctx.states[index].store.readPrePrepares(), acceptedBefore[index]);
    const selection = await ctx.request(index, "/pbft/primary", { view: "0", epoch: ctx.statement.epoch });
    assert.equal(selection.body.primaryIdentity, ctx.peers[ctx.primary].address);
  }
  await ctx.assertPrepared(indices, indices);
  const committed = await ctx.finish(indices);
  assert.equal(committed.record.epoch.toString(), ctx.statement.epoch);
  assert.equal(committed.record.batchId, ctx.statement.batchId); assert.equal(committed.record.messageRoot, ctx.statement.messageRoot);
  assert.equal(committed.quorumCertificate.proposalDigest, ctx.statement.proposalDigest);
  assert.deepEqual(ctx.validators.map((record) => record.child.pid), initialPids);
  await ctx.assertSource(true); await ctx.assertAlive(indices);
  console.log("VALID: healing changed only transport policy; persisted votes completed the same epoch, proposal, root, and primary without resetting locks");
}

async function primaryCrash(ctx) {
  await ctx.stop(ctx.primary); await ctx.assertAlive(ctx.backups);
  for (const index of ctx.backups) {
    const selection = await ctx.request(index, "/pbft/primary", { view: "0", epoch: ctx.statement.epoch });
    assert.equal(selection.body.primaryIdentity, ctx.peers[ctx.primary].address);
    const rejected = await ctx.request(index, "/pbft/propose", { batchId: ctx.pending.record.batchId });
    assert.equal(rejected.status, 422); assert.equal(rejected.body.reason, "WRONG_PRIMARY");
    const prepare = await ctx.request(index, "/pbft/prepare/cast", { epoch: ctx.statement.epoch });
    assert.equal(prepare.status, 422); assert.equal(prepare.body.reason, "PRE_PREPARE_REQUIRED");
    const commit = await ctx.request(index, "/pbft/commit/cast", { epoch: ctx.statement.epoch });
    assert.equal(commit.status, 422); assert.equal(commit.body.reason, "NOT_PREPARED");
    assert.equal((await ctx.request(index, "/pbft/qc", { epoch: ctx.statement.epoch })).status, 422);
    assert.deepEqual(await ctx.states[index].store.readPrePrepares(), []);
    assert.deepEqual(await ctx.states[index].store.readPrepareStates(), []);
    assert.deepEqual(await ctx.states[index].store.readCommitStates(), []);
    for (const route of ["/set-view", "/set-primary"]) assert.equal((await ctx.request(index, route, {})).status, 404);
  }
  const claimed = ctx.backups[0];
  const envelope = await signAdversarial(ctx, claimed, { messageType: "PRE_PREPARE", protocolVersion: "3", view: "0",
    validatorEpoch: ctx.statement.validatorEpoch,committeeDigest: ctx.statement.committeeDigest,
    sourceDomain: ctx.statement.sourceDomain, sourceGateway: ctx.statement.sourceGateway, epoch: ctx.statement.epoch,
    batchId: ctx.statement.batchId, messageRoot: ctx.statement.messageRoot, primaryIdentity: ctx.peers[claimed].address }, prePrepareDigest);
  const response = await ctx.send(claimed, ctx.backups[1], "/pbft/pre-prepare", envelope);
  assert.equal(response.status, 422); assert.equal(response.body.reason, "WRONG_PRIMARY");
  await ctx.assertSource(false);
  console.log("VALID: offline deterministic primary preserved safety; backups did not replace it, create a proposal, form quorum, or commit");
}

export async function verifyValidatorFaults({ sourceConfig, sourcePool, snapshot, pidFile }) {
  const original = await sourceState(sourcePool, sourceConfig.databaseSchema);
  const orphanIds = new Set(original.source_messages.filter((row) => row.status === "REORGED").map((row) => row.message_id));
  assert.ok(orphanIds.size, "real REORGED Message C must remain available for exclusion checks");
  const scenarios = [["crash", nonPrimaryCrash], ["byzantine", byzantineBackup], ["partition", partitionAndHeal], ["primary", primaryCrash]];
  for (let index = 0; index < scenarios.length; index++) {
    const [name, run] = scenarios[index];
    const epoch = normalizeBatchEpoch(snapshot.record.epoch + BigInt(index + 1));
    const ctx = await createScenario({ name, epoch, sourceConfig, template: snapshot, orphanIds, pidFile });
    try { await run(ctx); }
    finally { await ctx.close(); }
    assert.deepEqual(await sourceState(sourcePool, sourceConfig.databaseSchema), original);
  }
  console.log("VALID: isolated real-chain fault scenarios preserved original messages, REORGED C, canonical blocks, cursor, committed QC, and Message E");
}
