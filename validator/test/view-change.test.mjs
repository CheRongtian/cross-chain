import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, stringToHex } from "viem";
import { configuration, snapshotFixture } from "./helpers/fixtures.mjs";
import { validatorAccount } from "../src/identity.mjs";
import { canonicalCommittee, deterministicPrimary } from "../src/committee.mjs";
import { signPrePrepare, prePrepareDigest } from "../src/pre-prepare.mjs";
import { signPrepare, prepareDigest } from "../src/prepare.mjs";
import { signCommit, commitDigest } from "../src/commit.mjs";
import { expectedCommitStatement, buildQuorumCertificate, verifyQuorumCertificate, qcDigest } from "../src/quorum-certificate.mjs";
import { buildPreparedCertificate, verifyPreparedCertificate, preparedCertificateDigest, proposalIdentity } from "../src/prepared-certificate.mjs";
import { authenticateNewView, authenticateViewChange, newViewDigest, selectSafeProposal, signNewView, signViewChange,
  viewChangeDigest, VIEW_CHANGE_DOMAIN, NEW_VIEW_DOMAIN } from "../src/view-change.mjs";
import { createViewChangeService } from "../src/view-change-service.mjs";
import { createValidatorServer } from "../src/server.mjs";
import { createConsensusRuntime } from "../src/consensus-runtime.mjs";
import { loadValidatorConfig } from "../src/config.mjs";
import { environment } from "./helpers/fixtures.mjs";

const configs = Array.from({ length: 4 }, (_, index) => configuration({}, index));
const config = configs[0];
const bytes = (value) => `0x${value.repeat(32)}`;
export async function preparedFixture(view = "0", root, epoch) {
  const snapshot = await snapshotFixture();
  epoch ??= snapshot.record.epoch.toString();
  const primary = configs.find((c) => c.validatorAddress === deterministicPrimary(config.peers, epoch, view));
  const proposal = await signPrePrepare(primary, { messageType: "PRE_PREPARE", protocolVersion: "2", view,
    sourceDomain: primary.chainDomain.toString(), sourceGateway: primary.sourceGateway, epoch,
    batchId: snapshot.record.batchId, messageRoot: root ?? snapshot.record.messageRoot, primaryIdentity: primary.validatorAddress });
  const prepares = await Promise.all(configs.map((c) => signPrepare(c, { messageType: "PREPARE", ...expectedCommitStatement(proposal, config.peers),
    voterIdentity: c.validatorAddress })));
  // PREPARE has no committeeDigest; signPrepare normalizes away non-PREPARE fields.
  return { proposal, prepares, certificate: await buildPreparedCertificate(proposal, prepares.slice(0, 3), config) };
}
async function vcSet(proposal, certificate = null, targetView = "1") {
  return Promise.all(configs.slice(0, 3).map((c, index) => signViewChange(c, {
    epoch: proposal.epoch, targetView, acceptedProposal: proposal, preparedCertificate: index === 0 ? certificate : null,
  })));
}
async function candidate(votes, proposal, view = "1") {
  const primary = configs.find((c) => c.validatorAddress === deterministicPrimary(config.peers, proposal.epoch, view));
  return signNewView(primary, { epoch: proposal.epoch, view, viewChanges: votes,
    selectedProposal: selectSafeProposal(votes, proposal) }, proposalIdentity(proposal));
}

test("primary round-robin preserves view zero, ignores config order, and uses exact large integers", () => {
  const committee = canonicalCommittee(config.peers);
  for (const epoch of [0n, 23n, (1n << 250n) + 1n]) for (const view of [0n, 1n, 2n, 4n, (1n << 240n) + 3n]) {
    assert.equal(deterministicPrimary(config.peers, epoch, view), committee[Number((epoch + view) % 4n)]);
    assert.equal(deterministicPrimary([...config.peers].reverse(), epoch, view), deterministicPrimary(config.peers, epoch, view));
  }
  assert.throws(() => deterministicPrimary(config.peers, "1", 1));
});
test("all consensus digests explicitly bind view; committee and batch identity remain unchanged", async () => {
  const { proposal, prepares } = await preparedFixture();
  const statement = expectedCommitStatement(proposal, config.peers);
  const commit = await signCommit(config, { messageType: "COMMIT", ...statement, voterIdentity: config.validatorAddress });
  for (const [value, digest] of [[proposal, prePrepareDigest], [prepares[0], prepareDigest], [commit, commitDigest], [statement, qcDigest]]) {
    assert.notEqual(digest(value), digest({ ...value, view: "1" }));
  }
  assert.equal(expectedCommitStatement({ ...proposal, view: "1", proposalDigest: undefined }, config.peers).committeeDigest, statement.committeeDigest);
});
test("prepared certificates require three distinct matching authenticated PREPAREs", async () => {
  const { proposal, prepares, certificate } = await preparedFixture();
  assert.deepEqual(await verifyPreparedCertificate(certificate, config), certificate);
  for (const bad of [prepares.slice(0, 2), [prepares[0], prepares[0], prepares[1]], prepares.slice(0, 3).reverse(),
    [prepares[0], prepares[1], { ...prepares[2], view: "1" }],
    [prepares[0], prepares[1], { ...prepares[2], epoch: "0" }],
    [prepares[0], prepares[1], { ...prepares[2], messageRoot: bytes("ab") }],
    [prepares[0], prepares[1], { ...prepares[2], proposalDigest: bytes("ab") }],
    [prepares[0], prepares[1], { ...prepares[2], voterIdentity: "0x0000000000000000000000000000000000000099" }]]) {
    await assert.rejects(verifyPreparedCertificate({ messageType: "PREPARED_CERTIFICATE", proposal, prepares: bad }, config));
  }
});
test("VIEW_CHANGE digest binds signer, context, target view and authenticated safety evidence", async () => {
  const { proposal, certificate } = await preparedFixture();
  const votes = await vcSet(proposal, certificate);
  const vote = votes[0];
  assert.notEqual(VIEW_CHANGE_DOMAIN, NEW_VIEW_DOMAIN);
  assert.equal(viewChangeDigest(vote), vote.viewChangeDigest);
  assert.deepEqual(await authenticateViewChange(config, vote), vote);
  for (const change of [{ epoch: "0" }, { targetView: "2" }, { voterIdentity: configs[1].validatorAddress },
    { preparedCertificate: null }, { acceptedProposal: null }]) assert.notEqual(viewChangeDigest({ ...vote, ...change }), vote.viewChangeDigest);
  for (const change of [{ signature: "0x00" }, { signature: votes[1].signature }, { targetView: "0" },
    { voterIdentity: "0x0000000000000000000000000000000000000099" },
    { preparedCertificate: { ...certificate, prepares: certificate.prepares.slice(0, 2) } }, { extra: true }]) {
    await assert.rejects(authenticateViewChange(config, { ...vote, ...change }));
  }
  const wrongEpoch = await preparedFixture("0", undefined, (BigInt(proposal.epoch) + 1n).toString());
  await assert.rejects(signViewChange(config, { epoch: proposal.epoch, targetView: "1", acceptedProposal: null,
    preparedCertificate: wrongEpoch.certificate }), { code: "WRONG_PREPARED_VIEW" });
});
test("NEW_VIEW canonicalizes input order, independently selects safe proposal, and requires target primary", async () => {
  const { proposal, certificate } = await preparedFixture();
  const votes = await vcSet(proposal, certificate);
  const message = await candidate(votes, proposal);
  assert.deepEqual(await candidate([...votes].reverse(), proposal), message);
  assert.deepEqual(await authenticateNewView(config, message, proposalIdentity(proposal)), message);
  for (const viewChanges of [votes.slice(0, 2), [votes[0], votes[0], votes[1]]]) await assert.rejects(candidate(viewChanges, proposal));
  for (const change of [{ primaryIdentity: configs.find((c) => c.validatorAddress !== message.primaryIdentity).validatorAddress },
    { view: "2" }, { selectedProposal: { ...message.selectedProposal, messageRoot: bytes("bb") } },
    { viewChanges: [...message.viewChanges].reverse() }, { signature: "0x00" }, { extra: true }]) {
    await assert.rejects(authenticateNewView(config, { ...message, ...change }, proposalIdentity(proposal)));
  }
  // A valid primary signature alone cannot legitimize a policy-unsafe selection.
  const wrong = { ...message, selectedProposal: { ...message.selectedProposal, messageRoot: bytes("cc") } };
  wrong.newViewDigest = newViewDigest(wrong);
  const primary = configs.find((c) => c.validatorAddress === wrong.primaryIdentity);
  wrong.signature = await validatorAccount(primary.privateKey).signMessage({ message: { raw: wrong.newViewDigest } });
  await assert.rejects(authenticateNewView(config, wrong, proposalIdentity(proposal)), { code: "UNSAFE_SELECTED_PROPOSAL" });
});
test("highest prepared view wins; equal-highest conflicting proposals fail closed", async () => {
  const zero = await preparedFixture(); const one = await preparedFixture("1"); const two = await preparedFixture("2", bytes("dd"));
  assert.deepEqual(selectSafeProposal([], zero.proposal), proposalIdentity(zero.proposal));
  assert.deepEqual(selectSafeProposal([{ preparedCertificate: zero.certificate }], one.proposal), proposalIdentity(zero.proposal));
  assert.deepEqual(selectSafeProposal([{ preparedCertificate: zero.certificate }, { preparedCertificate: two.certificate }]), proposalIdentity(two.proposal));
  const conflict = await preparedFixture("2", bytes("ee"));
  assert.throws(() => selectSafeProposal([{ preparedCertificate: two.certificate }, { preparedCertificate: conflict.certificate }]), { code: "CONFLICTING_HIGHEST_PREPARED" });
});
test("valid QC from an earlier view remains independently verifiable", async () => {
  const { proposal } = await preparedFixture();
  const statement = expectedCommitStatement(proposal, config.peers);
  const votes = await Promise.all(configs.slice(0, 3).map((c) => signCommit(c, { messageType: "COMMIT", ...statement, voterIdentity: c.validatorAddress })));
  const options = { peers: config.peers, expected: statement };
  const qc = await buildQuorumCertificate(votes, options);
  assert.deepEqual(await verifyQuorumCertificate(qc, options), qc);
  await assert.rejects(verifyQuorumCertificate(qc, { peers: config.peers, expected: { ...statement, view: "1", proposalDigest: undefined } }));
});
test("legacy QC preserves original version-one encoding without adding view bytes", async () => {
  const snapshot = await snapshotFixture();
  const statement = expectedCommitStatement({ protocolVersion: "1", sourceDomain: config.chainDomain,
    sourceGateway: config.sourceGateway, epoch: snapshot.record.epoch, batchId: snapshot.record.batchId,
    messageRoot: snapshot.record.messageRoot }, config.peers);
  assert.equal(Object.hasOwn(statement, "view"), false);
  const type = "PBFTQuorumCertificate(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest)";
  assert.equal(qcDigest(statement), keccak256(encodeAbiParameters(parseAbiParameters("bytes32,uint8,uint256,address,uint256,bytes32,bytes32,bytes32,bytes32"),
    [keccak256(stringToHex(type)), 1, BigInt(statement.sourceDomain), statement.sourceGateway, BigInt(statement.epoch),
      statement.batchId, statement.messageRoot, statement.proposalDigest, statement.committeeDigest])));
  const commits = [];
  for (const c of configs.slice(0, 3)) {
    const vote = { messageType: "COMMIT", ...statement, voterIdentity: c.validatorAddress };
    const digest = commitDigest(vote);
    commits.push({ ...vote, commitDigest: digest, signature: await validatorAccount(c.privateKey).signMessage({ message: { raw: digest } }) });
  }
  const q = await buildQuorumCertificate(commits, { peers: config.peers, expected: statement });
  assert.equal(q.protocolVersion, "1"); assert.equal(Object.hasOwn(q, "view"), false);
});
test("progress timeout uses an injected clock and never individually advances current view", async () => {
  const epoch = "0";
  const state = { epoch, current_view: "0", target_view: "0", progress_revision: "0", view_change_at: null,
    progress_at: new Date(0), finalized: false, changing_view: false, batch_id: bytes("aa") };
  let now = 99; let timeouts = 0;
  const runtime = createConsensusRuntime({ config: { ...config, viewTimeoutMs: 100 },
    clock: { now: () => now, schedule() {}, cancel() {} }, sourcePool: { async query() { return { rows: [] }; } },
    store: { async readViewStates() { return [state]; }, async readViewChangeTargets() { return []; } },
    viewChange: { async replay() {}, async retryIntent() {}, async timeout(_epoch, expected) {
      assert.equal(expected.view, "0"); assert.equal(expected.progressRevision, "0");
      timeouts++; state.changing_view = true; state.target_view = String(timeouts); state.view_change_at = new Date(now);
      return { envelope: { targetView: state.target_view } };
    } }, logger: { error() {} } });
  await runtime.tick(); assert.equal(timeouts, 0);
  now = 100; await runtime.tick(); assert.equal(timeouts, 1); assert.equal(state.current_view, "0");
  now = 250; await runtime.tick(); assert.equal(timeouts, 2); assert.equal(state.current_view, "0");
  await runtime.close();
  for (const value of ["0", "-1", "1.5", "2147483648", "NaN"]) assert.throws(() => loadValidatorConfig(environment({ PBFT_VIEW_TIMEOUT_MS: value })));
});

test("startup awaits validation and registration without scheduling or broadcasting", async () => {
  const snapshot = await snapshotFixture();
  const epoch = snapshot.record.epoch.toString();
  const states = [];
  let releaseValidation;
  const validationGate = new Promise((resolve) => { releaseValidation = resolve; });
  let reportEntered;
  const validationEntered = new Promise((resolve) => { reportEntered = resolve; });
  let validations = 0;
  let schedules = 0;
  let initialized = false;
  const runtime = createConsensusRuntime({ config: { ...config, viewTimeoutMs: 100 },
    // Even an expired deadline cannot trigger consensus during startup discovery.
    clock: { now: () => 10000, schedule() { schedules++; }, cancel() {} },
    sourcePool: { async query() { return { rows: [{ batch_record_id: snapshot.record.batchRecordId,
      batch_id: snapshot.record.batchId, epoch, status: "CONSENSUS_PENDING" }] }; } },
    store: { async readViewStates() { return states; }, async registerEpoch(proposal) {
      states.push({ epoch: proposal.epoch, batch_id: proposal.batchId, message_root: proposal.messageRoot,
        current_view: "0", progress_at: new Date(0), changing_view: false, finalized: false });
    } },
    validation: { async validatePending(id) {
      assert.equal(id, snapshot.record.batchId); validations++; reportEntered();
      await validationGate; return { result: "VALID", snapshot };
    } },
    viewChange: { async timeout() { assert.fail("initialization cast VIEW_CHANGE"); },
      async establish() { assert.fail("initialization broadcast NEW_VIEW"); } },
    prePrepare: { async propose() { assert.fail("initialization proposed a batch"); } },
    prepare: { async cast() { assert.fail("initialization cast PREPARE"); } },
    commit: { async cast() { assert.fail("initialization cast COMMIT"); } },
  });
  const initialization = runtime.initialize().then(() => { initialized = true; });
  try {
    await validationEntered;
    assert.equal(initialized, false); assert.equal(states.length, 0); assert.equal(schedules, 0);
    releaseValidation(); await initialization;
    assert.equal(initialized, true); assert.equal(states.length, 1);
    assert.equal(states[0].batch_id, snapshot.record.batchId);
    assert.equal(states[0].message_root, snapshot.record.messageRoot);
    await runtime.initialize();
    assert.equal(validations, 1); assert.equal(states.length, 1); assert.equal(schedules, 0);
  } finally { releaseValidation(); await initialization; await runtime.close(); }
});

test("startup registration failure propagates without starting the scheduler", async () => {
  const snapshot = await snapshotFixture();
  let schedules = 0;
  const runtime = createConsensusRuntime({ config,
    clock: { now: () => 0, schedule() { schedules++; }, cancel() {} },
    sourcePool: { async query() { return { rows: [{ batch_record_id: snapshot.record.batchRecordId,
      batch_id: snapshot.record.batchId, epoch: snapshot.record.epoch.toString(), status: "CONSENSUS_PENDING" }] }; } },
    store: { async readViewStates() { return []; }, async registerEpoch() { throw new Error("startup storage unavailable"); } },
    validation: { async validatePending() { return { result: "VALID", snapshot }; } },
  });
  try {
    await assert.rejects(runtime.initialize(), /startup storage unavailable/);
    assert.equal(schedules, 0);
  } finally { await runtime.close(); }
});

test("startup preserves recovered higher-view state without resetting to view zero", async () => {
  const snapshot = await snapshotFixture();
  const state = { epoch: snapshot.record.epoch.toString(), batch_id: snapshot.record.batchId,
    message_root: snapshot.record.messageRoot, current_view: "2", changing_view: true, finalized: false,
    progress_at: new Date(0) };
  const original = structuredClone(state);
  const runtime = createConsensusRuntime({ config,
    sourcePool: { async query() { return { rows: [{ batch_record_id: snapshot.record.batchRecordId,
      batch_id: state.batch_id, epoch: state.epoch, status: "CONSENSUS_PENDING" }] }; } },
    store: { async readViewStates() { return [state]; },
      async registerEpoch() { assert.fail("startup rewrote a recovered epoch"); } },
    validation: { async validatePending() { assert.fail("startup revalidated an already registered epoch"); } },
    viewChange: { async timeout() { assert.fail("startup emitted intent before listening"); } },
  });
  try { await runtime.initialize(); assert.deepEqual(state, original); }
  finally { await runtime.close(); }
});

test("NEW_VIEW persists before broadcast; a lost broadcast is retried with the same durable envelope", async () => {
  const { proposal, certificate } = await preparedFixture();
  const votes = await vcSet(proposal, certificate);
  const primary = configs.find((c) => c.validatorAddress === deterministicPrimary(config.peers, proposal.epoch, "1"));
  let saved = null; let fail = true;
  const store = {
    async readNewView() { return saved; }, async readViewChanges() { return votes; },
    async acceptNewView(message) { assert.equal(saved, null); saved = message; return message; },
  };
  const snapshot = await snapshotFixture();
  const service = createViewChangeService({ config: primary, store,
    validation: { async validatePending() { return { result: "VALID", snapshot }; } },
    broadcast: async (_config, message) => {
      assert.deepEqual(message, saved);
      if (fail) throw new Error("crash after NEW_VIEW persistence");
      return [];
    } });
  await assert.rejects(service.establish(proposal.epoch, "1", proposal.batchId), /crash after/);
  const first = saved; fail = false;
  const result = await service.establish(proposal.epoch, "1", proposal.batchId);
  assert.deepEqual(result.envelope, first);
  assert.deepEqual(saved, first);
});

test("view HTTP endpoints enforce strict signed bodies and expose read-only durable state", async () => {
  const { proposal } = await preparedFixture();
  const votes = await vcSet(proposal);
  const message = await candidate(votes, proposal);
  const runtime = createValidatorServer({ config: { ...config, listenPort: 0 },
    store: { async readViewStates() { return [{ epoch: proposal.epoch, current_view: "1" }]; } },
    viewChange: { async receiveViewChange(envelope) { return { result: "ACCEPTED", envelope }; },
      async receiveNewView(envelope) { return { result: "ACCEPTED", envelope }; } },
    logger: { error() {} } });
  await runtime.listen();
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  async function post(route, body) {
    return fetch(origin + route, { method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(body) });
  }
  try {
    assert.equal((await post("/pbft/view-change", votes[0])).status, 200);
    assert.equal((await post("/pbft/new-view", message)).status, 200);
    assert.equal((await post("/pbft/view-change", { ...votes[0], admin: true })).status, 400);
    assert.equal((await post("/pbft/new-view", {})).status, 400);
    assert.equal((await post("/set-view", { view: "100" })).status, 404);
    const response = await fetch(origin + "/pbft/views", { headers: { connection: "close" } });
    assert.equal((await response.json()).states[0].current_view, "1");
  } finally { await runtime.close(); }
});

test("prepared and view-change evidence count normalized recovered identities, not address spellings", async () => {
  const { proposal, prepares, certificate } = await preparedFixture();
  const address = prepares[0].voterIdentity;
  const spellings = [address, `0x${address.slice(2).toUpperCase()}`, getAddress(address)];
  assert.equal(new Set(spellings).size, 3);
  const duplicatePrepares = spellings.map((voterIdentity) => ({ ...prepares[0], voterIdentity }));
  const invalidCertificate = { ...certificate, prepares: duplicatePrepares };
  await assert.rejects(verifyPreparedCertificate(invalidCertificate, config), { code: "DUPLICATE_SIGNER" });
  await assert.rejects(signViewChange(config, { epoch: proposal.epoch, targetView: "1",
    acceptedProposal: proposal, preparedCertificate: invalidCertificate }), { code: "DUPLICATE_SIGNER" });
  const votes = await vcSet(proposal);
  const message = await candidate(votes, proposal);
  const duplicated = { ...message, viewChanges: spellings.map((voterIdentity) => ({ ...votes[0], voterIdentity })) };
  duplicated.newViewDigest = newViewDigest(duplicated);
  const primary = configs.find((c) => c.validatorAddress === message.primaryIdentity);
  duplicated.signature = await validatorAccount(primary.privateKey).signMessage({ message: { raw: duplicated.newViewDigest } });
  await assert.rejects(authenticateNewView(config, duplicated, proposalIdentity(proposal)), { code: "DUPLICATE_SIGNER" });
  const originalVote = await signViewChange(config, { epoch: proposal.epoch, targetView: "1",
    acceptedProposal: proposal, preparedCertificate: certificate });
  for (const spelling of [(value) => value, (value) => `0x${value.slice(2).toUpperCase()}`, getAddress]) {
    const equivalent = { ...certificate, prepares: certificate.prepares.map((vote) => ({ ...vote, voterIdentity: spelling(vote.voterIdentity) })) };
    assert.deepEqual(await verifyPreparedCertificate(equivalent, config), certificate);
    assert.equal(preparedCertificateDigest(equivalent), preparedCertificateDigest(certificate));
    assert.equal(viewChangeDigest({ ...originalVote, preparedCertificate: equivalent }), originalVote.viewChangeDigest);
    const signed = await signViewChange(config, { epoch: proposal.epoch, targetView: "1",
      acceptedProposal: proposal, preparedCertificate: equivalent });
    assert.deepEqual(signed, originalVote);
    assert.deepEqual(await authenticateViewChange(config, signed), originalVote);
  }
});

test("a valid COMMITTED transition during NEW_VIEW replay finalizes locally without halting the scheduler", async () => {
  const { proposal } = await preparedFixture("1");
  const snapshot = await snapshotFixture();
  const statement = expectedCommitStatement(proposal, config.peers);
  const commits = await Promise.all(configs.slice(0, 3).map((c) => signCommit(c, { messageType: "COMMIT", ...statement, voterIdentity: c.validatorAddress })));
  const certificate = await buildQuorumCertificate(commits, { peers: config.peers, expected: statement });
  const primary = configs.find((c) => c.validatorAddress === proposal.primaryIdentity);
  const evidence = await vcSet((await preparedFixture()).proposal);
  const message = await candidate(evidence, proposal);
  const state = { epoch: proposal.epoch, current_view: "1", target_view: "1", progress_revision: "1",
    progress_at: new Date(0), view_change_at: null, changing_view: false, finalized: false, batch_id: proposal.batchId };
  let reads = 0;
  const store = { async readViewStates() { return [state]; }, async readLatestIssuedNewView() { return message; },
    async finalizeEpoch(qc) { assert.deepEqual(qc, certificate); state.finalized = true; } };
  const validation = {
    async validatePending() { return { result: "INVALID", reason: "BATCH_STATUS" }; },
    async readCommitted() { reads++; return { ...snapshot, record: { ...snapshot.record, status: "COMMITTED" }, quorumCertificate: certificate }; },
  };
  const viewChange = createViewChangeService({ config: primary, store, validation,
    broadcast: async () => { assert.fail("COMMITTED batch rebroadcast NEW_VIEW"); } });
  const runtime = createConsensusRuntime({ config: primary, store, viewChange,
    sourcePool: { async query() { return { rows: [] }; } }, clock: { now: () => 0, schedule() {}, cancel() {} } });
  try {
    await runtime.tick();
    assert.equal(reads, 1); assert.equal(state.finalized, true); assert.equal(runtime.healthy(), true);
    await runtime.tick(); assert.equal(reads, 1);
    validation.readCommitted = async () => { throw new Error("persisted QC signature invalid"); };
    await assert.rejects(viewChange.establish(proposal.epoch, "1", proposal.batchId), /QC signature invalid/);
    validation.readCommitted = async () => null;
    await assert.rejects(viewChange.establish(proposal.epoch, "1", proposal.batchId), { code: "INVALID_SOURCE_STATE" });
  } finally { await runtime.close(); }
});

test("waiting for a later view still replays the durable NEW_VIEW to lagging peers", async () => {
  const { proposal } = await preparedFixture("1");
  const state = { epoch: proposal.epoch, current_view: "1", target_view: "2", progress_revision: "0",
    progress_at: new Date(0), view_change_at: new Date(0), changing_view: true, finalized: false, batch_id: proposal.batchId };
  const actions = [];
  const runtime = createConsensusRuntime({ config,
    store: { async readViewStates() { return [state]; }, async readViewChangeTargets() { return []; } },
    sourcePool: { async query() { return { rows: [] }; } },
    clock: { now: () => 100000, schedule() {}, cancel() {} },
    viewChange: { async replay() { actions.push("NEW_VIEW"); }, async retryIntent() { actions.push("VIEW_CHANGE_RETRY"); } } });
  try { await runtime.tick(); assert.deepEqual(actions, ["NEW_VIEW", "VIEW_CHANGE_RETRY"]); }
  finally { await runtime.close(); }
});
