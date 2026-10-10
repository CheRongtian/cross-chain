import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { applyValidatorMigrations, createValidatorPool, createValidatorStore } from "../src/db.mjs";
import { tableName } from "../../indexer/src/db.mjs";
import { configuration, snapshotFixture } from "./helpers/fixtures.mjs";
import { canonicalCommittee, deterministicPrimary } from "../src/committee.mjs";
import { signPrePrepare } from "../src/pre-prepare.mjs";
import { createPrePrepareService } from "../src/pre-prepare-service.mjs";
import { signPrepare } from "../src/prepare.mjs";
import { createPrepareService } from "../src/prepare-service.mjs";
import { createCommitService } from "../src/commit-service.mjs";
import { signCommit } from "../src/commit.mjs";
import { expectedCommitStatement } from "../src/quorum-certificate.mjs";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for validator database tests");
const prefix = process.env.VALIDATOR_DATABASE_TEST_SCHEMA ?? "cross_chain_validator_database_test";
const configs = Array.from({ length: 4 }, (_, index) => configuration({
  SOURCE_DATABASE_URL: process.env.DATABASE_URL, VALIDATOR_DATABASE_URL: process.env.DATABASE_URL,
  VALIDATOR_DB_SCHEMA: `${prefix}_v${index + 1}`,
}, index));
const pools = configs.map(createValidatorPool);
const stores = configs.map((config, index) => createValidatorStore({ config, pool: pools[index] }));
let snapshot;
let head;

before(async () => {
  snapshot = await snapshotFixture();
  head = { number: snapshot.batch.messages[0].sourceBlockNumber + 2n, hash: `0x${"99".repeat(32)}` };
  for (let index = 0; index < 4; index++) await applyValidatorMigrations(pools[index], configs[index].databaseSchema);
});
beforeEach(async () => {
  for (let index = 0; index < 4; index++) {
    const schema = configs[index].databaseSchema;
    await pools[index].query(`TRUNCATE TABLE ${tableName(schema, "commit_rejections")},
      ${tableName(schema, "pbft_commit_quorums")}, ${tableName(schema, "pbft_commit_votes")},
      ${tableName(schema, "prepare_rejections")},
      ${tableName(schema, "pbft_prepared_states")}, ${tableName(schema, "pbft_prepare_votes")},
      ${tableName(schema, "validation_observations")},
      ${tableName(schema, "validated_batch_bindings")}, ${tableName(schema, "validator_metadata")},
      ${tableName(schema, "validator_committee")}, ${tableName(schema, "pbft_pre_prepares")},
      ${tableName(schema, "pre_prepare_rejections")}`);
    await stores[index].bindIdentity();
  }
});

async function signedProposal(root = snapshot.tree.messageRoot) {
  const primary = configs.find((config) => config.validatorAddress === deterministicPrimary(configs[0].peers, snapshot.record.epoch));
  return signPrePrepare(primary, { messageType: "PRE_PREPARE", protocolVersion: "1",
    sourceDomain: primary.chainDomain, sourceGateway: primary.sourceGateway, epoch: snapshot.record.epoch,
    batchId: snapshot.record.batchId, messageRoot: root, primaryIdentity: primary.validatorAddress });
}

function direction(config, envelope) { return config.validatorAddress === envelope.primaryIdentity ? "ISSUED" : "ACCEPTED"; }

async function signedVote(proposal, voterIndex, overrides = {}) {
  const config = configs[voterIndex];
  return signPrepare(config, { messageType: "PREPARE", protocolVersion: "1",
    sourceDomain: proposal.sourceDomain, sourceGateway: proposal.sourceGateway, epoch: proposal.epoch,
    batchId: proposal.batchId, messageRoot: proposal.messageRoot,
    proposalDigest: proposal.proposalDigest, voterIdentity: config.validatorAddress, ...overrides });
}

async function acceptProposal(storeIndex = 0) {
  const proposal = await signedProposal();
  await stores[storeIndex].savePrePrepare(proposal, direction(configs[storeIndex], proposal));
  return proposal;
}

async function prepareProposal(storeIndex = 0, count = 3) {
  const proposal = await acceptProposal(storeIndex);
  for (let index = 0; index < count; index++) await stores[storeIndex].savePrepareVote(await signedVote(proposal, index));
  return expectedCommitStatement(proposal, configs[storeIndex].peers);
}

async function commitVote(statement, voterIndex, overrides = {}) {
  return signCommit(configs[voterIndex], { messageType: "COMMIT", ...statement,
    voterIdentity: configs[voterIndex].validatorAddress, ...overrides });
}

test("COMMIT cast and receive require durable PREPARED; missing or two-prepare state has no commit weight", async () => {
  const proposal = await signedProposal();
  const statement = expectedCommitStatement(proposal, configs[0].peers);
  const vote = await commitVote(statement, 0);
  let signed = 0;
  const signer = async (...args) => { signed++; return signCommit(...args); };
  await assert.rejects(stores[0].castCommitVote(proposal.epoch, signer), /NOT_PREPARED/);
  await assert.rejects(stores[0].saveCommitVote(vote), /NOT_PREPARED/);
  await stores[0].savePrePrepare(proposal, direction(configs[0], proposal));
  await assert.rejects(stores[0].castCommitVote(proposal.epoch, signer), /NOT_PREPARED/);
  for (let i = 0; i < 2; i++) await stores[0].savePrepareVote(await signedVote(proposal, i));
  await assert.rejects(stores[0].castCommitVote(proposal.epoch, signer), /NOT_PREPARED/);
  await assert.rejects(stores[0].saveCommitVote(vote), /NOT_PREPARED/);
  assert.equal(signed, 0);
  assert.equal((await stores[0].readCommitState(proposal.epoch)).voteCount, 0);
  await stores[0].savePrepareVote(await signedVote(proposal, 2));
  assert.equal((await stores[0].castCommitVote(proposal.epoch, signer)).voteCount, 1);
  assert.equal(signed, 1);
});

test("COMMIT locks, unique counts, quorum, and reconstructed QC survive migration and fresh pool", async () => {
  const statement = await prepareProposal();
  const votes = await Promise.all(configs.map((_config, index) => commitVote(statement, index)));
  const self = await stores[0].castCommitVote(statement.epoch);
  assert.equal(self.voteCount, 1); assert.equal(self.quorum, null); assert.equal(self.certificate, null);
  for (let i = 0; i < 100; i++) assert.equal((await stores[0].saveCommitVote(votes[0])).voteCount, 1);
  const two = await stores[0].saveCommitVote(votes[1]);
  assert.equal(two.voteCount, 2); assert.equal(two.certificate, null);
  const wrong = await commitVote(statement, 2, { messageRoot: `0x${"ed".repeat(32)}` });
  await assert.rejects(stores[0].saveCommitVote(wrong), /WRONG_ROOT/);
  assert.equal((await stores[0].readCommitState(statement.epoch)).quorum, null);
  const three = await stores[0].saveCommitVote(votes[2]);
  assert.equal(three.voteCount, 3); assert.equal(three.quorum.status, "COMMIT_QUORUM");
  const four = await stores[0].saveCommitVote(votes[3]);
  assert.equal(four.voteCount, 4); assert.deepEqual(four.quorum, three.quorum);
  assert.deepEqual(four.certificate, three.certificate);
  const conflict = await commitVote(statement, 3, { proposalDigest: `0x${"ee".repeat(32)}` });
  await assert.rejects(stores[0].saveCommitVote(conflict), /CONFLICTING_COMMIT/);
  await applyValidatorMigrations(pools[0], configs[0].databaseSchema);
  const fresh = createValidatorPool(configs[0]);
  try {
    const restored = createValidatorStore({ config: configs[0], pool: fresh });
    await restored.bindIdentity();
    assert.deepEqual(await restored.readCommitState(statement.epoch), four);
    let signatures = 0;
    assert.deepEqual(await restored.castCommitVote(statement.epoch, async () => { signatures++; assert.fail("re-signed durable self vote"); }), four);
    assert.equal(signatures, 0);
    await assert.rejects(restored.saveCommitVote(conflict), /CONFLICTING_COMMIT/);
  } finally { await fresh.end(); }
  for (const table of ["pbft_commit_votes", "pbft_commit_quorums"]) {
    await assert.rejects(pools[0].query(`DELETE FROM ${tableName(configs[0].databaseSchema, table)}`), /immutable/);
  }
  for (let i = 1; i < 4; i++) assert.equal((await stores[i].readCommitStates()).length, 0);
});

test("concurrent COMMIT casts sign once; concurrent duplicate/third votes create one durable quorum", async () => {
  const statement = await prepareProposal();
  let signatures = 0;
  const signer = async (...args) => { signatures++; return signCommit(...args); };
  const casts = await Promise.all(Array.from({ length: 6 }, () => stores[0].castCommitVote(statement.epoch, signer)));
  assert.equal(signatures, 1);
  for (const state of casts) assert.deepEqual(state, casts[0]);
  const second = await commitVote(statement, 1);
  const third = await commitVote(statement, 2);
  const invalid = await commitVote(statement, 2, { batchId: `0x${"ef".repeat(32)}` });
  const results = await Promise.allSettled([
    ...Array.from({ length: 6 }, () => stores[0].saveCommitVote(second)),
    ...Array.from({ length: 6 }, () => stores[0].saveCommitVote(third)), stores[0].saveCommitVote(invalid),
  ]);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const state = await stores[0].readCommitState(statement.epoch);
  assert.equal(state.voteCount, 3); assert.equal(new Set(state.votes.map((v) => v.voterIdentity)).size, 3);
  assert.ok(state.certificate); assert.equal(state.quorum.quorumVoters.length, 3);
});

test("COMMIT persistence failures and lost receiver responses recover from durable state", async () => {
  const statement = await prepareProposal();
  await assert.rejects(stores[0].castCommitVote(statement.epoch, async (...args) => {
    await signCommit(...args); throw new Error("crash before persistence");
  }), /crash before persistence/);
  assert.equal((await stores[0].readCommitState(statement.epoch)).voteCount, 0);
  const service = createCommitService({ config: configs[0], store: stores[0], logger: { warn() {} },
    broadcast: async () => { throw new Error("crash after persistence"); } });
  await assert.rejects(service.cast(statement.epoch), /crash after persistence/);
  const saved = await stores[0].readCommitState(statement.epoch);
  assert.equal(saved.voteCount, 1);
  const remote = await commitVote(statement, 1);
  const lostResponse = createCommitService({ config: configs[0], logger: { warn() {} }, store: {
    ...stores[0], async saveCommitVote(vote) { await stores[0].saveCommitVote(vote); throw new Error("lost receiver response"); },
  } });
  await assert.rejects(lostResponse.receive(remote), /lost receiver response/);
  const fresh = createValidatorPool(configs[0]);
  try {
    const restored = createValidatorStore({ config: configs[0], pool: fresh });
    await restored.bindIdentity();
    const retry = createCommitService({ config: configs[0], store: restored, logger: { warn() {} }, broadcast: async () => [] });
    assert.deepEqual((await retry.cast(statement.epoch)).record.vote, saved.votes[0]);
    assert.equal((await retry.receive(remote)).voteCount, 2);
    assert.equal((await restored.readCommitState(statement.epoch)).voteCount, 2);
  } finally { await fresh.end(); }
});

test("issued and accepted PRE-PREPARE survive migration and fresh-pool recovery without overwrites", async () => {
  const envelope = await signedProposal();
  for (let index = 0; index < 4; index++) {
    const first = await stores[index].savePrePrepare(envelope, direction(configs[index], envelope));
    assert.deepEqual(await stores[index].savePrePrepare(envelope, direction(configs[index], envelope)), first);
    await applyValidatorMigrations(pools[index], configs[index].databaseSchema);
    const fresh = createValidatorPool(configs[index]);
    try {
      const restored = createValidatorStore({ config: configs[index], pool: fresh });
      await restored.bindIdentity();
      assert.deepEqual(await restored.readPrePrepare(envelope.epoch), first);
      const conflict = await signedProposal(`0x${"ee".repeat(32)}`);
      await assert.rejects(restored.savePrePrepare(conflict, direction(configs[index], conflict)), /CONFLICTING_PRE_PREPARE/);
      assert.deepEqual(await restored.readPrePrepares(), [first]);
    } finally { await fresh.end(); }
    await assert.rejects(pools[index].query(`DELETE FROM ${tableName(configs[index].databaseSchema, "pbft_pre_prepares")}`), /immutable/);
  }
});

test("database safety slots serialize concurrent duplicates and conflicting signed proposals", async () => {
  const a = await signedProposal();
  const repeated = await Promise.all(Array.from({ length: 8 }, () => stores[0].savePrePrepare(a, direction(configs[0], a))));
  for (const record of repeated) assert.deepEqual(record, repeated[0]);
  assert.equal((await stores[0].readPrePrepares()).length, 1);
  const b = await signedProposal(`0x${"ee".repeat(32)}`);
  const races = await Promise.allSettled([
    stores[1].savePrePrepare(a, direction(configs[1], a)), stores[1].savePrePrepare(b, direction(configs[1], b)),
  ]);
  assert.equal(races.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = races.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "CONFLICTING_PRE_PREPARE");
  assert.equal((await stores[1].readPrePrepares()).length, 1);
});

test("rejection audit never reserves a safety slot; committee permutations preserve binding", async () => {
  const p = await signedProposal();
  await stores[0].recordPrePrepareRejection({ ...p, epoch: "bad" }, "MALFORMED");
  assert.deepEqual(await stores[0].readPrePrepares(), []);
  await stores[0].savePrePrepare(p, direction(configs[0], p));
  const reordered = createValidatorStore({ pool: pools[0], config: { ...configs[0], peers: [...configs[0].peers].reverse() } });
  await reordered.bindIdentity();
  assert.deepEqual(await reordered.readPrePrepares(), await stores[0].readPrePrepares());
  const altered = configs[0].peers.map((peer, index) => index === 1 ? { ...peer, address: "0x0000000000000000000000000000000000000099" } : peer);
  assert.notDeepEqual(canonicalCommittee(altered), canonicalCommittee(configs[0].peers));
  await assert.rejects(createValidatorStore({ pool: pools[0], config: { ...configs[0], peers: altered } }).bindIdentity(), /committee mismatch/);
});

test("failed source validation records rejection without creating accepted state", async () => {
  const envelope = await signedProposal();
  const service = createPrePrepareService({ config: configs[0], store: stores[0],
    validation: { async validatePending() { return { result: "INVALID", reason: "CANONICAL_BLOCK" }; } },
    logger: { warn() {} } });
  assert.equal((await service.receive(envelope)).reason, "INVALID_SOURCE_STATE");
  assert.deepEqual(await stores[0].readPrePrepares(), []);
  const audit = await pools[0].query(`SELECT * FROM ${tableName(configs[0].databaseSchema, "pre_prepare_rejections")}`);
  assert.equal(audit.rowCount, 1); assert.equal(audit.rows[0].proposal_digest, envelope.proposalDigest);
});

test("PREPARE votes and local PREPARED state survive rerunnable migration and fresh-pool recovery", async () => {
  const proposal = await acceptProposal(0);
  const votes = await Promise.all([0, 1, 2, 3].map((index) => signedVote(proposal, index)));
  const one = await stores[0].savePrepareVote(votes[0]);
  assert.equal(one.voteCount, 1); assert.equal(one.prepared, null);
  const two = await stores[0].savePrepareVote(votes[1]);
  assert.equal(two.voteCount, 2); assert.equal(two.prepared, null);
  const three = await stores[0].savePrepareVote(votes[2]);
  assert.equal(three.voteCount, 3); assert.equal(three.prepared.quorumVoters.length, 3);
  const prepared = three.prepared;
  const four = await stores[0].savePrepareVote(votes[3]);
  assert.equal(four.voteCount, 4); assert.deepEqual(four.prepared, prepared);
  await applyValidatorMigrations(pools[0], configs[0].databaseSchema);
  const fresh = createValidatorPool(configs[0]);
  try {
    const restored = createValidatorStore({ pool: fresh, config: configs[0] });
    await restored.bindIdentity();
    const state = await restored.readPrepareState(proposal.epoch);
    assert.equal(state.voteCount, 4); assert.deepEqual(state.prepared, prepared);
    assert.deepEqual((await restored.readPrepareVote(proposal.epoch, configs[0].validatorAddress)).vote, one.vote);
    assert.deepEqual(await restored.savePrepareVote(votes[0]), { ...one, voteCount: 4, prepared });
  } finally { await fresh.end(); }
  for (const table of ["pbft_prepare_votes", "pbft_prepared_states"]) {
    await assert.rejects(pools[0].query(`DELETE FROM ${tableName(configs[0].databaseSchema, table)}`), /immutable/);
  }
});

test("concurrent duplicate and third-vote writes produce unique votes and atomically persist PREPARED", async () => {
  const proposal = await acceptProposal(0);
  const votes = await Promise.all([0, 1, 2].map((index) => signedVote(proposal, index)));
  await stores[0].savePrepareVote(votes[0]);
  const results = await Promise.all([
    ...Array.from({ length: 6 }, () => stores[0].savePrepareVote(votes[1])),
    ...Array.from({ length: 6 }, () => stores[0].savePrepareVote(votes[2])),
  ]);
  assert.ok(results.some((result) => result.prepared !== null));
  const state = await stores[0].readPrepareState(proposal.epoch);
  assert.equal(state.voteCount, 3); assert.equal(state.votes.length, 3);
  assert.equal(new Set(state.votes.map((vote) => vote.voterIdentity)).size, 3);
  assert.equal(state.prepared.quorumVoters.length, 3);
  const rows = await pools[0].query(`SELECT COUNT(*)::int AS count FROM ${tableName(configs[0].databaseSchema, "pbft_prepare_votes")}`);
  assert.equal(rows.rows[0].count, 3);
});

test("wrong or conflicting PREPARE cannot replace a durable voter lock or create quorum", async () => {
  const proposal = await acceptProposal(0);
  const canonical = await signedVote(proposal, 1);
  await stores[0].savePrepareVote(canonical);
  const original = await stores[0].readPrepareVote(proposal.epoch, configs[1].validatorAddress);
  const conflict = await signedVote(proposal, 1, { messageRoot: `0x${"ee".repeat(32)}` });
  await assert.rejects(stores[0].savePrepareVote(conflict), /WRONG_ROOT/);
  const before = await stores[0].readPrepareState(proposal.epoch);
  assert.equal(before.voteCount, 1); assert.equal(before.prepared, null);
  const service = createPrepareService({ config: configs[0], store: stores[0], logger: { warn() {} } });
  assert.equal((await service.receive(conflict)).reason, "CONFLICTING_PREPARE");
  assert.deepEqual(await stores[0].readPrepareVote(proposal.epoch, configs[1].validatorAddress), original);
  const audit = await pools[0].query(`SELECT reason FROM ${tableName(configs[0].databaseSchema, "prepare_rejections")}`);
  assert.deepEqual(audit.rows.map((row) => row.reason), ["CONFLICTING_PREPARE"]);
});

test("concurrent canonical and conflicting PREPARE writes preserve only the accepted proposal vote", async () => {
  const proposal = await acceptProposal(0);
  const canonical = await signedVote(proposal, 2);
  const conflicting = await signedVote(proposal, 2, { messageRoot: `0x${"ed".repeat(32)}` });
  const results = await Promise.allSettled([
    stores[0].savePrepareVote(canonical), stores[0].savePrepareVote(conflicting),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "WRONG_ROOT");
  const state = await stores[0].readPrepareState(proposal.epoch);
  assert.equal(state.voteCount, 1); assert.equal(state.prepared, null);
  assert.equal(state.votes[0].prepareDigest, canonical.prepareDigest);
});

test("PREPARE requires a durable accepted proposal and rejected input never reserves vote weight", async () => {
  const proposal = await signedProposal();
  const vote = await signedVote(proposal, 0);
  await assert.rejects(stores[0].savePrepareVote(vote), /PRE_PREPARE_REQUIRED/);
  await stores[0].recordPrepareRejection(vote, "PRE_PREPARE_REQUIRED");
  assert.equal((await stores[0].readPrepareStates()).length, 0);
  const counts = await pools[0].query(`SELECT
    (SELECT COUNT(*) FROM ${tableName(configs[0].databaseSchema, "pbft_prepare_votes")})::int AS votes,
    (SELECT COUNT(*) FROM ${tableName(configs[0].databaseSchema, "pbft_prepared_states")})::int AS prepared,
    (SELECT COUNT(*) FROM ${tableName(configs[0].databaseSchema, "prepare_rejections")})::int AS rejected`);
  assert.deepEqual(counts.rows[0], { votes: 0, prepared: 0, rejected: 1 });
});
after(async () => { await Promise.all(pools.map((pool) => pool.end())); });

test("rerunnable migrations and four identity-bound namespaces isolate observations", async () => {
  const firstIdentity = await stores[0].bindIdentity();
  await applyValidatorMigrations(pools[0], configs[0].databaseSchema);
  assert.deepEqual(await stores[0].bindIdentity(), firstIdentity);
  await stores[0].recordObservation({ snapshot, head, result: "VALID" });
  assert.equal((await stores[0].readObservations()).length, 1);
  for (let index = 1; index < 4; index++) assert.deepEqual(await stores[index].readObservations(), []);
  for (let index = 1; index < 4; index++) await stores[index].recordObservation({ snapshot, head, result: "VALID" });
  for (const store of stores) assert.equal((await store.readObservations()).length, 1);
  assert.equal(new Set(configs.map((config) => config.validatorAddress)).size, 4);
});

test("fresh pools recover their own observations and reject swapped keys/context", async () => {
  for (let index = 0; index < 2; index++) {
    await stores[index].recordObservation({ snapshot, head, result: "VALID" });
    const before = await stores[index].readObservations();
    const pool = createValidatorPool(configs[index]);
    try {
      const restored = createValidatorStore({ pool, config: configs[index] });
      await restored.bindIdentity();
      assert.deepEqual(await restored.readObservations(), before);
      const swapped = createValidatorStore({ pool, config: { ...configs[index], validatorAddress: configs[1 - index].validatorAddress } });
      await assert.rejects(swapped.bindIdentity(), /identity or source context mismatch/);
      const changedPolicy = createValidatorStore({ pool, config: { ...configs[index], finalityBlockDepth: 3n } });
      await assert.rejects(changedPolicy.bindIdentity(), /identity or source context mismatch/);
      assert.deepEqual(await restored.readObservations(), before);
    } finally { await pool.end(); }
  }
});

test("same-head validation is idempotent; changed heads retain immutable history", async () => {
  const first = await stores[0].recordObservation({ snapshot, head, result: "VALID" });
  assert.deepEqual(await stores[0].recordObservation({ snapshot, head, result: "VALID" }), first);
  assert.equal((await stores[0].readObservations()).length, 1);
  await stores[0].recordObservation({ snapshot, head: { number: head.number + 1n, hash: `0x${"98".repeat(32)}` }, result: "INVALID", reason: "CANONICAL_BLOCK" });
  assert.equal((await stores[0].readObservations()).length, 2);
  await assert.rejects(stores[0].recordObservation({ snapshot, head, result: "INVALID", reason: "CANONICAL_BLOCK" }), /conflicting validation observation/);
  assert.equal((await stores[0].readObservations())[0].result, "VALID");
});

test("conflicting roots, epochs, or occurrence membership cannot replace existing bindings", async () => {
  await stores[0].recordObservation({ snapshot, head, result: "VALID" });
  const before = await stores[0].readObservations();
  for (const candidate of [
    { ...snapshot, record: { ...snapshot.record, messageRoot: `0x${"ee".repeat(32)}` } },
    { ...snapshot, record: { ...snapshot.record, epoch: snapshot.record.epoch + 1n } },
    { ...snapshot, batch: { ...snapshot.batch, messages: [...snapshot.batch.messages].reverse() } },
  ]) await assert.rejects(stores[0].recordObservation({ snapshot: candidate, head, result: "VALID" }), /conflicting validator-local batch snapshot/);
  assert.deepEqual(await stores[0].readObservations(), before);
  for (const table of ["validator_metadata", "validated_batch_bindings", "validation_observations"]) {
    await assert.rejects(pools[0].query(`DELETE FROM ${tableName(configs[0].databaseSchema, table)}`), /immutable/);
  }
  const data = JSON.stringify({ identities: await stores[0].bindIdentity(), observations: before });
  assert.ok(!data.includes(configs[0].privateKey));
});
