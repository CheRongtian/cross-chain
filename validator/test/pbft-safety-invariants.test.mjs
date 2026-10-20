import assert from "node:assert/strict";
import test from "node:test";
import { recoverMessageAddress } from "viem";
import { buildMessageBatch } from "../../indexer/src/message-batch.mjs";
import { buildMessageMerkleTree } from "../../indexer/src/message-merkle.mjs";
import { deterministicPrimary } from "../src/committee.mjs";
import { validatorAccount } from "../src/identity.mjs";
import { loadValidatorConfig } from "../src/config.mjs";
import { signPrePrepare } from "../src/pre-prepare.mjs";
import { authenticatePrepare, prepareDigest, signPrepare } from "../src/prepare.mjs";
import { authenticateCommit, commitDigest, signCommit } from "../src/commit.mjs";
import { buildPreparedCertificate } from "../src/prepared-certificate.mjs";
import { buildQuorumCertificate, expectedCommitStatement, verifyQuorumCertificate } from "../src/quorum-certificate.mjs";
import { developmentKeys, environment, snapshotFixture } from "./helpers/fixtures.mjs";

const EPOCH = (1n << 200n) + 23n;
const ROTATION = EPOCH + 10n;

async function safetyFixture() {
  const frozen = await snapshotFixture();
  const keys = developmentKeys(5);
  const peers = keys.map((key, index) => ({ address: validatorAccount(key).address.toLowerCase(),
    url: `http://127.0.0.1:${31001 + index}` }));
  const history = [
    { validatorEpoch: "7", activationBatchEpoch: "0", validators: peers.slice(0, 4).map(peer => peer.address) },
    { validatorEpoch: "8", activationBatchEpoch: ROTATION.toString(), validators: peers.slice(1).map(peer => peer.address) },
  ];
  const configs = keys.map((key, index) => loadValidatorConfig(environment({ VALIDATOR_PRIVATE_KEY: key,
    VALIDATOR_LISTEN_PORT: String(31001 + index), VALIDATOR_PEERS: JSON.stringify(peers),
    VALIDATOR_SET_HISTORY: JSON.stringify(history) })));
  async function round(epoch, voters) {
    const batch = buildMessageBatch({ ...frozen.batch, epoch });
    const tree = buildMessageMerkleTree(batch);
    const set = configs[0].validatorSets.resolveForBatchEpoch(epoch);
    const primary = configs.find(config => config.validatorAddress === deterministicPrimary(set.validators, epoch));
    const statement = expectedCommitStatement({ sourceDomain: batch.sourceDomain, sourceGateway: batch.sourceGateway,
      epoch: batch.epoch, batchId: batch.batchId, messageRoot: tree.messageRoot }, primary);
    const proposal = await signPrePrepare(primary, { messageType: "PRE_PREPARE", ...statement,
      primaryIdentity: primary.validatorAddress });
    const prepares = await Promise.all(voters.map(index => signPrepare(configs[index], {
      messageType: "PREPARE", ...statement, voterIdentity: peers[index].address })));
    const prepared = await buildPreparedCertificate(proposal, prepares, primary);
    const commits = await Promise.all(voters.map(index => signCommit(configs[index], {
      messageType: "COMMIT", ...statement, voterIdentity: peers[index].address })));
    const options = { peers, validatorSets: primary.validatorSets, expected: statement };
    const qc = await buildQuorumCertificate(commits, options);
    assert.equal(new Set(qc.commits.map(vote => vote.voterIdentity)).size, 3);
    assert.deepEqual(await verifyQuorumCertificate(qc, options), qc);
    return { batch, tree, primary, statement, proposal, prepares, prepared, commits, qc, options };
  }
  const baseline = await round(EPOCH, [0, 1, 2]);
  return { peers, configs, round, baseline };
}

test("PBFT safety: one authorized non-primary can sign conflicts but cannot manufacture distinct quorum identities", async () => {
  const { configs, baseline } = await safetyFixture();
  const adversary = configs.find(config => config.validatorAddress !== baseline.primary.validatorAddress &&
    baseline.primary.validatorSets.resolveByValidatorEpoch("7").validators.includes(config.validatorAddress));
  const vote = await signPrepare(adversary, { messageType: "PREPARE", ...baseline.statement, voterIdentity: adversary.validatorAddress });
  const commit = await signCommit(adversary, { messageType: "COMMIT", ...baseline.statement, voterIdentity: adversary.validatorAddress });
  assert.deepEqual(await authenticatePrepare(baseline.primary, vote), vote);
  assert.deepEqual(await authenticateCommit(baseline.primary, commit), commit);
  await assert.rejects(buildPreparedCertificate(baseline.proposal, [vote], baseline.primary), { code: "QUORUM_REQUIRED" });
  await assert.rejects(buildPreparedCertificate(baseline.proposal, [vote, vote, vote], baseline.primary), { code: "DUPLICATE_SIGNER" });
  await assert.rejects(buildQuorumCertificate([commit], baseline.options), { code: "INSUFFICIENT_OR_INVALID_QC_EVIDENCE" });
  await assert.rejects(buildQuorumCertificate([commit, commit, commit], baseline.options), { code: "DUPLICATE_QC_SIGNER" });
  const conflicting = expectedCommitStatement({ ...baseline.statement, messageRoot: `0x${"ab".repeat(32)}`,
    proposalDigest: undefined }, baseline.primary);
  assert.notEqual(conflicting.messageRoot, baseline.statement.messageRoot);
  const badPrepare = await signPrepare(adversary, { messageType: "PREPARE", ...conflicting, voterIdentity: adversary.validatorAddress });
  const badCommit = await signCommit(adversary, { messageType: "COMMIT", ...conflicting, voterIdentity: adversary.validatorAddress });
  assert.deepEqual(await authenticatePrepare(baseline.primary, badPrepare), badPrepare);
  assert.deepEqual(await authenticateCommit(baseline.primary, badCommit), badCommit);
  const honest = configs.filter(config => config.validatorAddress !== adversary.validatorAddress &&
    baseline.primary.validatorSets.resolveByValidatorEpoch("7").validators.includes(config.validatorAddress)).slice(0, 2);
  const prepares = await Promise.all(honest.map(config => signPrepare(config, {
    messageType: "PREPARE", ...baseline.statement, voterIdentity: config.validatorAddress })));
  const commits = await Promise.all(honest.map(config => signCommit(config, {
    messageType: "COMMIT", ...baseline.statement, voterIdentity: config.validatorAddress })));
  await assert.rejects(buildPreparedCertificate(baseline.proposal, [...prepares, badPrepare], baseline.primary), { code: "WRONG_PREPARED_PROPOSAL" });
  await assert.rejects(buildQuorumCertificate([...commits, badCommit], baseline.options), { code: "MISMATCHED_COMMIT" });
  assert.deepEqual(await verifyQuorumCertificate(baseline.qc, baseline.options), baseline.qc);
  console.log(`VALID: PBFT safety authorized non-primary ${adversary.validatorAddress} signs genuine conflicts but has at most one distinct identity; two R1 voters plus one R2 voter cannot form either quorum`);
});

test("PBFT safety: adjacent full-width consensus epochs cannot share votes or reinterpret a QC", async () => {
  const { round, baseline } = await safetyFixture();
  const other = await round(EPOCH + 1n, [0, 1, 2]);
  assert.ok(BigInt(baseline.statement.epoch) > 2n ** 53n);
  assert.equal(BigInt(other.statement.epoch), BigInt(baseline.statement.epoch) + 1n);
  assert.equal(other.statement.validatorEpoch, baseline.statement.validatorEpoch);
  const third = other.commits.find(vote => vote.voterIdentity === baseline.commits[2].voterIdentity);
  const thirdPrepare = other.prepares.find(vote => vote.voterIdentity === baseline.prepares[2].voterIdentity);
  assert.deepEqual(await authenticateCommit(baseline.primary, third), third);
  assert.deepEqual(await authenticatePrepare(baseline.primary, thirdPrepare), thirdPrepare);
  await assert.rejects(buildPreparedCertificate(baseline.proposal,
    [...baseline.prepares.slice(0, 2), thirdPrepare], baseline.primary), { code: "WRONG_PREPARED_PROPOSAL" });
  await assert.rejects(buildQuorumCertificate([...baseline.commits.slice(0, 2), third], baseline.options), { code: "MISMATCHED_COMMIT" });
  await assert.rejects(verifyQuorumCertificate(other.qc, baseline.options), { code: "WRONG_QC_EPOCH" });
  await assert.rejects(verifyQuorumCertificate(baseline.qc, other.options), { code: "WRONG_QC_EPOCH" });
  assert.deepEqual(await verifyQuorumCertificate(other.qc, other.options), other.qc);
  console.log(`EXPECTED FAILURE: PBFT safety valid votes/QCs for adjacent consensus epochs ${EPOCH} and ${EPOCH + 1n} cannot contribute to each other's PREPARED or QC authority`);
});

test("PBFT safety: a valid common member signature cannot relabel the validator-set epoch", async () => {
  const { configs, baseline } = await safetyFixture();
  const signer = configs[1]; // TEST-ONLY V2 belongs to both registered committees.
  const future = signer.validatorSets.resolveByValidatorEpoch("8");
  for (const [messageType, digest, authenticate] of [
    ["PREPARE", prepareDigest, authenticatePrepare], ["COMMIT", commitDigest, authenticateCommit],
  ]) {
    const fields = { messageType, ...baseline.statement, validatorEpoch: future.validatorEpoch,
      committeeDigest: future.committeeDigest, voterIdentity: signer.validatorAddress };
    const raw = digest(fields);
    const signature = await validatorAccount(signer.privateKey).signMessage({ message: { raw } });
    assert.equal((await recoverMessageAddress({ message: { raw }, signature })).toLowerCase(), signer.validatorAddress);
    const vote = { ...fields, [messageType === "PREPARE" ? "prepareDigest" : "commitDigest"]: raw, signature };
    await assert.rejects(authenticate(baseline.primary, vote), { code: "WRONG_VALIDATOR_EPOCH" });
  }
  assert.deepEqual(await verifyQuorumCertificate(baseline.qc, baseline.options), baseline.qc);
  console.log("EXPECTED FAILURE: PBFT safety genuinely signed epoch-8 votes cannot acquire epoch-7 weight even for a member shared by both historical committees");
});

test("PBFT safety: historical epoch-7 QC and current epoch-8 QC resolve their own immutable four-member sets", async () => {
  const { peers, configs, round, baseline } = await safetyFixture();
  const original = structuredClone(baseline.qc);
  const current = await round(ROTATION, [1, 2, 4]);
  const resolver = configs[0].validatorSets;
  assert.equal(baseline.qc.validatorEpoch, "7"); assert.equal(current.qc.validatorEpoch, "8");
  assert.ok(baseline.qc.commits.some(vote => vote.voterIdentity === peers[0].address));
  assert.ok(current.qc.commits.some(vote => vote.voterIdentity === peers[4].address));
  assert.ok(!resolver.resolveByValidatorEpoch("8").validators.includes(peers[0].address));
  assert.ok(!resolver.resolveByValidatorEpoch("7").validators.includes(peers[4].address));
  for (const [target, signerIndex] of [[baseline, 4], [current, 0]]) {
    const fields = { messageType: "COMMIT", ...target.statement, voterIdentity: peers[signerIndex].address };
    const raw = commitDigest(fields);
    const signature = await validatorAccount(configs[signerIndex].privateKey).signMessage({ message: { raw } });
    assert.equal((await recoverMessageAddress({ message: { raw }, signature })).toLowerCase(), peers[signerIndex].address);
    await assert.rejects(buildQuorumCertificate([...target.commits.slice(0, 2), {
      ...fields, commitDigest: raw, signature,
    }], target.options), { code: "UNKNOWN_VALIDATOR" });
  }
  assert.deepEqual(await verifyQuorumCertificate(baseline.qc, baseline.options), original);
  assert.deepEqual(await verifyQuorumCertificate(current.qc, current.options), current.qc);
  assert.deepEqual(baseline.qc, original);
  console.log("VALID: PBFT safety epoch-7 V1–V4 and epoch-8 V2–V5 each verify with three distinct signers; V1 stays historical, V5 cannot backdate authority, and old QC bytes/fields are unchanged");
});
