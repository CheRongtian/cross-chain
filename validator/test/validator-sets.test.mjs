import assert from "node:assert/strict";
import test from "node:test";
import { encodeAbiParameters,keccak256,parseAbiParameters,stringToHex } from "viem";
import { createValidatorSetResolver, consensusBinding, consensusCommittee, consensusPeers } from "../src/validator-sets.mjs";
import { committeeDigest, deterministicPrimary } from "../src/committee.mjs";
import { validatorAccount } from "../src/identity.mjs";
import { loadValidatorConfig } from "../src/config.mjs";
import { authenticatePrePrepare, prePrepareDigest, signPrePrepare } from "../src/pre-prepare.mjs";
import { authenticatePrepare, prepareDigest, signPrepare } from "../src/prepare.mjs";
import { authenticateCommit, commitDigest, signCommit } from "../src/commit.mjs";
import { authenticateNewView, authenticateViewChange, newViewDigest, signNewView, signViewChange, viewChangeDigest } from "../src/view-change.mjs";
import { buildPreparedCertificate, proposalIdentity } from "../src/prepared-certificate.mjs";
import { buildQuorumCertificate, expectedCommitStatement, qcDigest, verifyQuorumCertificate } from "../src/quorum-certificate.mjs";
import { createConsensusRuntime } from "../src/consensus-runtime.mjs";
import { validateCandidateSnapshot } from "../src/source-validation.mjs";
import { developmentKeys, environment, snapshotFixture } from "./helpers/fixtures.mjs";

const keys = developmentKeys(5);
const peers = keys.map((key,index) => ({ address: validatorAccount(key).address.toLowerCase(), url: `http://127.0.0.1:${31001 + index}` }));
const schedule = [
  { validatorEpoch: "7", activationBatchEpoch: "0", validators: peers.slice(0,4).map((peer) => peer.address) },
  { validatorEpoch: "8", activationBatchEpoch: "24", validators: peers.slice(1).map((peer) => peer.address) },
];
const resolver = createValidatorSetResolver(schedule);
const configs = keys.map((key,index) => loadValidatorConfig(environment({ VALIDATOR_PRIVATE_KEY: key,
  VALIDATOR_LISTEN_PORT: String(31001 + index), VALIDATOR_PEERS: JSON.stringify(peers), VALIDATOR_SET_HISTORY: JSON.stringify(schedule) })));
const bytes = (value) => `0x${value.repeat(32)}`;

async function rawSigned(fields, digest, index) {
  const value = digest(fields);
  const signature = await validatorAccount(keys[index]).signMessage({ message: { raw: value } });
  const field = fields.messageType === "PREPARE" ? "prepareDigest" : fields.messageType === "COMMIT" ? "commitDigest" : "viewChangeDigest";
  return { ...fields, [field]: value, signature };
}
async function evidence(epoch = "23", view = "0") {
  const snapshot = await snapshotFixture();
  const set = resolver.resolveForBatchEpoch(epoch);
  const indices = peers.map((peer,index) => set.validators.includes(peer.address) ? index : -1).filter((index) => index >= 0);
  const primary = peers.findIndex((peer) => peer.address === deterministicPrimary(set.validators,epoch,view));
  const proposal = await signPrePrepare(configs[primary], { messageType: "PRE_PREPARE", protocolVersion: "3", epoch, view,
    ...consensusBinding(configs[primary],epoch), sourceDomain: configs[primary].chainDomain.toString(), sourceGateway: configs[primary].sourceGateway,
    batchId: snapshot.batch.batchId, messageRoot: snapshot.tree.messageRoot, primaryIdentity: peers[primary].address });
  const statement = expectedCommitStatement(proposal,configs[primary]);
  const prepares = await Promise.all(indices.slice(0,3).map((index) => signPrepare(configs[index], { messageType: "PREPARE", ...statement, voterIdentity: peers[index].address })));
  const certificate = await buildPreparedCertificate(proposal,prepares,configs[primary]);
  const commits = await Promise.all(indices.slice(0,3).map((index) => signCommit(configs[index], { messageType: "COMMIT", ...statement, voterIdentity: peers[index].address })));
  const qc = await buildQuorumCertificate(commits, { peers, validatorSets: resolver, expected: statement });
  return { indices, primary, proposal, statement, prepares, certificate, commits, qc };
}

test("four canonical nonzero members, optional verified digest, independent epochs and deterministic schedule order", () => {
  const reordered = createValidatorSetResolver([...schedule].reverse().map((set) => ({ ...set, validators: [...set.validators].reverse() })));
  assert.deepEqual(reordered.history,resolver.history);
  assert.equal(resolver.resolveForBatchEpoch("23").validatorEpoch,"7");
  assert.equal(resolver.resolveForBatchEpoch("24").validatorEpoch,"8");
  assert.equal(resolver.resolveForBatchEpoch((1n << 240n).toString()).validatorEpoch,"8");
  assert.equal(resolver.resolveForBatchEpoch("2").validatorEpoch,resolver.resolveForBatchEpoch("23").validatorEpoch);
  assert.equal(resolver.resolveByValidatorEpoch("7").committeeDigest,committeeDigest(schedule[0].validators));
  assert.notEqual(resolver.history[0].committeeDigest,resolver.history[1].committeeDigest);
  assert.deepEqual(createValidatorSetResolver(resolver.history).history,resolver.history);
  assert.throws(() => resolver.resolveByValidatorEpoch("999"), { code: "UNKNOWN_VALIDATOR_EPOCH" });
  assert.throws(() => resolver.resolveForBatchEpoch(23));
  assert.throws(() => createValidatorSetResolver([{ ...schedule[0], activationBatchEpoch: "1" }]).resolveForBatchEpoch("0"));
});

test("malformed, zero, duplicate, noncontiguous and retroactive history is rejected", () => {
  for (const validators of [schedule[0].validators.slice(1), peers.map((peer) => peer.address),
    [schedule[0].validators[0],schedule[0].validators[0],...schedule[0].validators.slice(2)],
    [bytes("00").slice(0,42),...schedule[0].validators.slice(1)], ["bad",...schedule[0].validators.slice(1)]]) {
    assert.throws(() => createValidatorSetResolver([{ ...schedule[0],validators }]));
  }
  for (const change of [{ validatorEpoch: "7" }, { validatorEpoch: "9" }, { activationBatchEpoch: "0" },
    { activationBatchEpoch: "-1" }, { validatorEpoch: "1.5" }, { committeeDigest: bytes("aa") }]) {
    assert.throws(() => createValidatorSetResolver([schedule[0],{ ...schedule[1],...change }]));
  }
  assert.throws(() => createValidatorSetResolver([{ ...schedule[0],privateKey: keys[0] }]));
  assert.throws(() => createValidatorSetResolver([{ ...schedule[0],validators: peers.slice(0,4) }]));
});

test("endpoint directory contains five identities but each resolved committee and broadcast contains four", () => {
  for (const epoch of ["23","24"]) {
    const context = { protocolVersion: "3", epoch, ...consensusBinding(configs[0],epoch) };
    const set = consensusCommittee(configs[0],context);
    assert.equal(set.validators.length,4);
    assert.equal(consensusPeers(configs[0],context).length,4);
    for (const view of ["0","1","2"]) assert.ok(set.validators.includes(deterministicPrimary(set.validators,epoch,view)));
  }
  const changed = { ...configs[0],peers: peers.map((peer) => ({ ...peer,url: peer.url.replace("310","320") })) };
  assert.equal(consensusCommittee(changed,{ protocolVersion: "3",epoch: "24",...consensusBinding(changed,"24") }).committeeDigest,resolver.history[1].committeeDigest);
  assert.ok(!consensusPeers(configs[0],{ protocolVersion: "3",epoch: "24",...consensusBinding(configs[0],"24") }).some((peer) => peer.address === peers[0].address));
  assert.ok(!JSON.stringify(resolver.history).includes(keys[0]));
});

test("removed and upcoming identities cannot contribute votes or view-change weight to another committee", async () => {
  for (const [epoch,inactive] of [["23",4],["24",0]]) {
    const current = await evidence(epoch);
    for (const [messageType,digest,authenticate] of [["PREPARE",prepareDigest,authenticatePrepare],["COMMIT",commitDigest,authenticateCommit]]) {
      const fields = { messageType,...current.statement,voterIdentity: peers[inactive].address };
      // PREPARE does not carry COMMIT's pre-existing committee field in legacy formats;
      // current v3 PREPARE deliberately binds the exact same committee.
      const vote = await rawSigned(fields,digest,inactive);
      await assert.rejects(authenticate(configs[current.primary],vote), { code: "UNKNOWN_VALIDATOR" });
    }
    const fields = { messageType: "VIEW_CHANGE",protocolVersion: "3",sourceDomain: current.statement.sourceDomain,
      sourceGateway: current.statement.sourceGateway,epoch,targetView: "1",...consensusBinding(configs[0],epoch),
      voterIdentity: peers[inactive].address,acceptedProposal: null,preparedCertificate: null };
    await assert.rejects(authenticateViewChange(configs[current.primary],await rawSigned(fields,viewChangeDigest,inactive)), { code: "UNKNOWN_VALIDATOR" });
  }
});

test("historical and new QCs use exact epoch committees, never mixed votes or latest membership", async () => {
  const old = await evidence(); const next = await evidence("24");
  for (const current of [old,next]) assert.deepEqual(await verifyQuorumCertificate(current.qc,{ peers,validatorSets: resolver,expected: current.statement }),current.qc);
  for (const change of [{ validatorEpoch: "8" },{ committeeDigest: next.statement.committeeDigest },
    { batchId: bytes("aa") },{ messageRoot: bytes("bb") },{ view: "1" },{ epoch: "24" },{ proposalDigest: bytes("cc") }]) {
    await assert.rejects(verifyQuorumCertificate({ ...old.qc,...change },{ peers,validatorSets: resolver,expected: old.statement }));
  }
  await assert.rejects(buildQuorumCertificate([old.commits[0],old.commits[1],next.commits[0]],{ peers,validatorSets: resolver,expected: old.statement }));
  await assert.rejects(verifyQuorumCertificate(old.qc,{ peers: peers.slice(1),expected: old.statement }));
  assert.notEqual(qcDigest({ ...next.statement,validatorEpoch: "7" }),next.qc.qcDigest);
  assert.throws(() => consensusCommittee(configs[0],{ ...old.statement,validatorEpoch: "999" }), { code: "UNKNOWN_VALIDATOR_EPOCH" });
});

test("prepared and NEW_VIEW evidence from another validator epoch cannot authorize recovery", async () => {
  const old = await evidence(); const next = await evidence("24");
  await assert.rejects(signViewChange(configs[1],{ epoch: "24",targetView: "1",acceptedProposal: next.proposal,preparedCertificate: old.certificate }));
  const votes = await Promise.all(old.indices.slice(0,3).map((index) => signViewChange(configs[index],{
    epoch: "23",targetView: "1",acceptedProposal: old.proposal,preparedCertificate: old.certificate })));
  const primary = peers.findIndex((peer) => peer.address === deterministicPrimary(resolver.history[1].validators,"24","1"));
  await assert.rejects(signNewView(configs[primary],{ epoch: "24",view: "1",viewChanges: votes,selectedProposal: proposalIdentity(next.proposal) },proposalIdentity(next.proposal)));
});

test("every signed consensus digest binds validator epoch even when identical members recur", async () => {
  const old = await evidence();
  const votes = await Promise.all(old.indices.slice(0,3).map((index) => signViewChange(configs[index], {
    epoch: old.proposal.epoch,targetView: "1",acceptedProposal: old.proposal,preparedCertificate: old.certificate })));
  const primary = peers.findIndex((peer) => peer.address === deterministicPrimary(resolver.history[0].validators,old.proposal.epoch,"1"));
  const message = await signNewView(configs[primary],{ epoch: old.proposal.epoch,view: "1",viewChanges: votes,
    selectedProposal: proposalIdentity(old.proposal) },proposalIdentity(old.proposal));
  assert.deepEqual(await authenticateNewView(configs[primary],message,proposalIdentity(old.proposal)),message);
  for (const [envelope,digest,authenticate] of [[old.proposal,prePrepareDigest,authenticatePrePrepare],
    [old.prepares[0],prepareDigest,authenticatePrepare],[old.commits[0],commitDigest,authenticateCommit],
    [votes[0],viewChangeDigest,authenticateViewChange],[message,newViewDigest,authenticateNewView]]) {
    assert.notEqual(digest({ ...envelope,validatorEpoch: "8" }),digest(envelope));
    await assert.rejects(authenticate(configs[primary],{ ...envelope,validatorEpoch: "8" },proposalIdentity(old.proposal)));
  }
  const repeated = createValidatorSetResolver([schedule[0],{ ...schedule[1],validators: schedule[0].validators }]);
  assert.equal(repeated.history[0].committeeDigest,repeated.history[1].committeeDigest);
  assert.equal(message.validatorEpoch,"7"); assert.equal(message.committeeDigest,old.proposal.committeeDigest);
});

test("version-two historical QC retains original ABI bytes and signatures after a new committee activates", async () => {
  const snapshot = await snapshotFixture();
  const statement = expectedCommitStatement({ protocolVersion: "2",epoch: "23",view: "2",sourceDomain: configs[0].chainDomain,
    sourceGateway: configs[0].sourceGateway,batchId: snapshot.batch.batchId,messageRoot: snapshot.tree.messageRoot },configs[0]);
  assert.equal(Object.hasOwn(statement,"validatorEpoch"),false);
  const type = "PBFTQuorumCertificate(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest)";
  const expected = keccak256(encodeAbiParameters(parseAbiParameters("bytes32,uint8,uint256,address,uint256,uint256,bytes32,bytes32,bytes32,bytes32"),
    [keccak256(stringToHex(type)),2,BigInt(statement.sourceDomain),statement.sourceGateway,23n,2n,statement.batchId,statement.messageRoot,statement.proposalDigest,statement.committeeDigest]));
  assert.equal(qcDigest(statement),expected);
  const commits = await Promise.all([0,1,2].map((index) => rawSigned({ messageType: "COMMIT",...statement,voterIdentity: peers[index].address },commitDigest,index)));
  const certificate = await buildQuorumCertificate(commits,{ peers,validatorSets: resolver,expected: statement });
  assert.deepEqual(await verifyQuorumCertificate(certificate,{ peers,validatorSets: resolver,expected: statement }),certificate);
  assert.equal(certificate.protocolVersion,"2"); assert.equal(Object.hasOwn(certificate,"validatorEpoch"),false);
});

test("replacement-view scheduler selects the pinned four-member committee from a five-entry directory", async () => {
  const current = await evidence("24","1");
  const config = configs[current.primary];
  const actions = [];
  const state = { epoch: "24",current_view: "1",target_view: "1",protocol_version: 3,
    validator_epoch: "8",committee_digest: resolver.history[1].committeeDigest,batch_id: current.proposal.batchId,
    finalized: false,changing_view: false,progress_at: new Date(0),progress_revision: "0" };
  const runtime = createConsensusRuntime({ config,clock: { now: () => 1,schedule() {},cancel() {} },
    sourcePool: { async query() { return { rows: [] }; } },
    store: { async readViewStates() { return [state]; },async readViewChangeTargets() { return []; },
      async readPrePrepare() { return { envelope: current.proposal }; },async readPrepareState() { return { prepared: null }; },
      async readCommitState() { return { certificate: null }; } },
    viewChange: { async replay() { actions.push("replay"); } },
    prePrepare: { async propose() { actions.push("proposal"); return { result: "ACCEPTED" }; } },
    prepare: { async cast() { actions.push("prepare"); } },
  });
  try { await runtime.tick(); assert.deepEqual(actions,["replay","proposal","prepare"]); }
  finally { await runtime.close(); }
});

test("source database binding is independently checked against trusted history", async () => {
  const snapshot = await snapshotFixture();
  const binding = { protocolVersion: "3",...consensusBinding(configs[0],snapshot.record.epoch) };
  validateCandidateSnapshot({ ...snapshot,consensusBinding: binding },configs[0],snapshot.record.batchId);
  for (const change of [{ validatorEpoch: "999" },{ committeeDigest: bytes("aa") },{ protocolVersion: "2" }]) {
    assert.throws(() => validateCandidateSnapshot({ ...snapshot,consensusBinding: { ...binding,...change } },configs[0],snapshot.record.batchId), { code: "CONSENSUS_BINDING" });
  }
});
