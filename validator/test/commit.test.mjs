import assert from "node:assert/strict";
import test from "node:test";
import { committeeDigest, COMMITTEE_DOMAIN } from "../src/committee.mjs";
import { authenticateCommit, commitDigest, COMMIT_DOMAIN, CommitError } from "../src/commit.mjs";
import { createCommitService, broadcastCommit } from "../src/commit-service.mjs";
import { buildQuorumCertificate, qcDigest, QC_DOMAIN, verifyQuorumCertificate } from "../src/quorum-certificate.mjs";
import { PREPARE_DOMAIN } from "../src/prepare.mjs";
import { PRE_PREPARE_DOMAIN } from "../src/pre-prepare.mjs";
import { HANDSHAKE_DOMAIN } from "../src/handshake.mjs";
import { validatorAccount } from "../src/identity.mjs";
import { createValidatorServer } from "../src/server.mjs";
import { commitConfigs as configs, commitFixture, signedCommitFixture } from "./helpers/commit-fixtures.mjs";

const bytes = (value) => `0x${value.repeat(32)}`;
const silent = { warn() {}, error() {} };

test("COMMIT and static committee use independent deterministic ABI domains and exact uint256", async () => {
  const { votes, statement } = await commitFixture();
  const vote = votes[0];
  assert.equal(commitDigest(Object.fromEntries(Object.entries(vote).reverse())), vote.commitDigest);
  assert.equal(commitDigest({ ...vote, epoch: BigInt(vote.epoch) }), vote.commitDigest);
  const max = (1n << 256n) - 1n;
  assert.equal(commitDigest({ ...vote, epoch: max }), commitDigest({ ...vote, epoch: max.toString() }));
  assert.throws(() => commitDigest({ ...vote, epoch: Number.MAX_SAFE_INTEGER }), { code: "MALFORMED" });
  for (const mutation of [{ protocolVersion: "4" }, { sourceDomain: "2" }, { sourceGateway: configs[1].validatorAddress },
    { epoch: (BigInt(statement.epoch) + 1n).toString() }, { batchId: bytes("11") }, { messageRoot: bytes("12") },
    { proposalDigest: bytes("13") }, { committeeDigest: bytes("14") }, { voterIdentity: configs[1].validatorAddress }]) {
    assert.notEqual(commitDigest({ ...vote, ...mutation }), vote.commitDigest);
  }
  const domains = [COMMIT_DOMAIN, COMMITTEE_DOMAIN, QC_DOMAIN, PREPARE_DOMAIN, PRE_PREPARE_DOMAIN, HANDSHAKE_DOMAIN];
  assert.equal(new Set(domains).size, domains.length);
  assert.equal(committeeDigest([...configs[0].peers].reverse()), statement.committeeDigest);
  const changed = configs[0].peers.map((peer, index) => index ? peer : { ...peer, address: "0x0000000000000000000000000000000000000099" });
  assert.notEqual(committeeDigest(changed), statement.committeeDigest);
});

test("COMMIT authentication recomputes digest and binds signer, membership, committee, and context", async () => {
  const { votes, statement } = await commitFixture();
  assert.deepEqual(await authenticateCommit(configs[1], votes[0]), votes[0]);
  for (const mutation of [{ epoch: "1" }, { messageRoot: bytes("21") }, { proposalDigest: bytes("22") },
    { batchId: bytes("23") }, { voterIdentity: configs[1].validatorAddress }]) {
    const changed = { ...votes[0], ...mutation };
    await assert.rejects(authenticateCommit(configs[1], { ...changed, commitDigest: commitDigest(changed) }), { code: "INVALID_SIGNATURE" });
  }
  for (const [mutation, code] of [[{ protocolVersion: "4" }, "WRONG_VERSION"], [{ sourceDomain: "2" }, "WRONG_CONTEXT"],
    [{ sourceGateway: configs[1].validatorAddress }, "WRONG_CONTEXT"], [{ committeeDigest: bytes("24") }, "WRONG_COMMITTEE"]]) {
    await assert.rejects(authenticateCommit(configs[1], await signedCommitFixture(statement, configs[0], mutation)), { code });
  }
  const key = `0x${99n.toString(16).padStart(64, "0")}`;
  const unknown = { privateKey: key, validatorAddress: validatorAccount(key).address.toLowerCase() };
  await assert.rejects(authenticateCommit(configs[1], await signedCommitFixture(statement, unknown)), { code: "UNKNOWN_VALIDATOR" });
  await assert.rejects(authenticateCommit(configs[1], { ...votes[0], signature: votes[1].signature }), { code: "INVALID_SIGNATURE" });
  for (const signature of ["0x00", bytes("00"), `0x${"ff".repeat(65)}`]) {
    await assert.rejects(authenticateCommit(configs[1], { ...votes[0], signature }), { code: "INVALID_SIGNATURE" });
  }
  await assert.rejects(authenticateCommit(configs[1], { ...votes[0], commitDigest: bytes("ef") }), { code: "INVALID_DIGEST" });
  await assert.rejects(authenticateCommit(configs[1], { ...votes[0], receivedAt: "now" }), { code: "MALFORMED" });
});

test("QC construction canonicalizes evidence and different valid subsets prove the same statement", async () => {
  const { votes, options } = await commitFixture();
  const a = await buildQuorumCertificate(votes.slice(0, 3), options);
  const b = await buildQuorumCertificate([votes[3], votes[1], votes[0]], options);
  const four = await buildQuorumCertificate(votes, options);
  assert.equal(a.qcDigest, b.qcDigest); assert.equal(a.qcDigest, four.qcDigest);
  assert.notDeepEqual(a.commits, b.commits);
  assert.deepEqual(await buildQuorumCertificate(votes.slice(0, 3).reverse(), options), a);
  assert.deepEqual(a.commits.map((v) => v.voterIdentity), a.commits.map((v) => v.voterIdentity).sort());
  assert.deepEqual(await verifyQuorumCertificate(four, options), four);
  await assert.rejects(verifyQuorumCertificate({ ...a, commits: [...a.commits].reverse() }, options), { code: "NONCANONICAL_QC_EVIDENCE" });
});

test("QC rejects insufficient, duplicate, unknown, forged, malformed, or mismatched evidence", async () => {
  const { votes, options, statement } = await commitFixture();
  const q = await buildQuorumCertificate(votes.slice(0, 3), options);
  for (const input of [{ ...q, commits: votes.slice(0, 2) }, { ...q, commits: [votes[0], votes[0], votes[1]] },
    { ...q, commits: [votes[0], votes[1], { ...votes[2], signature: votes[0].signature }] },
    { ...q, commits: [votes[0], votes[1], { ...votes[2], commitDigest: bytes("88") }] },
    { ...q, qcDigest: bytes("ef") }, { ...q, messageType: "COMMIT" }, { ...q, extra: true },
    { ...q, commits: [votes[0], votes[1], await signedCommitFixture(statement, configs[2], { messageRoot: bytes("89") })] }]) {
    await assert.rejects(verifyQuorumCertificate(input, options));
  }
  const key = `0x${99n.toString(16).padStart(64, "0")}`;
  const unknown = await signedCommitFixture(statement, { privateKey: key, validatorAddress: validatorAccount(key).address.toLowerCase() });
  await assert.rejects(buildQuorumCertificate([votes[0], votes[1], unknown], options), { code: "UNKNOWN_VALIDATOR" });
  for (const mutation of [{ protocolVersion: "4" }, { sourceDomain: "2" }, { sourceGateway: configs[1].validatorAddress },
    { epoch: "1" }, { batchId: bytes("31") }, { messageRoot: bytes("32") }, { proposalDigest: bytes("33") },
    { committeeDigest: bytes("34") }]) {
    const changed = { ...q, ...mutation };
    await assert.rejects(verifyQuorumCertificate({ ...changed, qcDigest: qcDigest(changed) }, options));
  }
  const changedPeers = configs[0].peers.map((peer, index) => index ? peer : { ...peer, address: unknown.voterIdentity });
  await assert.rejects(verifyQuorumCertificate(q, { ...options, peers: changedPeers }));
});

test("COMMIT service broadcasts only the durable self vote and reports no quorum below three", async () => {
  const { votes, statement } = await commitFixture();
  let durable = false;
  let casts = 0;
  const state = { epoch: statement.epoch, votes: [votes[0]], voteCount: 1, quorum: null, certificate: null };
  const store = { async castCommitVote() { durable = true; casts++; return state; },
    async readCommitState() { return state; }, async recordCommitRejection() {} };
  const service = createCommitService({ config: configs[0], store, logger: silent,
    broadcast: async (_config, vote) => { assert.equal(durable, true); assert.deepEqual(vote, votes[0]); return []; } });
  assert.equal((await service.cast(statement.epoch)).commitQuorum, false);
  assert.deepEqual((await service.cast(statement.epoch)).record.vote, votes[0]);
  assert.equal(casts, 2);
  assert.equal((await service.certificate(statement.epoch)).reason, "COMMIT_QUORUM_REQUIRED");
  const missing = createCommitService({ config: configs[0], logger: silent,
    store: { ...store, async castCommitVote() { throw new CommitError("NOT_PREPARED"); } },
    broadcast: async () => { assert.fail("unprepared validator broadcast"); } });
  assert.equal((await missing.cast(statement.epoch)).reason, "NOT_PREPARED");
  const failed = createCommitService({ config: configs[0], store, logger: silent,
    broadcast: async () => { throw new Error("crash after durable persistence"); } });
  await assert.rejects(failed.cast(statement.epoch), /crash after durable persistence/);
  assert.deepEqual((await service.cast(statement.epoch)).record.vote, votes[0]);
});

test("COMMIT broadcast authenticates peers, bounds requests, and never counts acknowledgements as votes", async () => {
  const { votes } = await commitFixture();
  const peers = configs[0].peers.filter((p) => p.address !== configs[0].validatorAddress);
  const deliveries = await broadcastCommit(configs[0], votes[0], {
    authenticatePeer: async () => {}, fetchImplementation: async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      assert.deepEqual(JSON.parse(options.body), votes[0]);
      const peer = peers.find((p) => url === `${p.url}/pbft/commit`);
      if (peer === peers[0]) throw new Error("offline");
      return { status: 200, async json() { return { validatorAddress: peer.address, result: "ACCEPTED", commitDigest: votes[0].commitDigest }; } };
    },
  });
  assert.equal(deliveries.filter((d) => d.delivery === "FAILED").length, 1);
  assert.ok(deliveries.every((d) => !Object.hasOwn(d, "voteCount")));
});

test("HTTP COMMIT/QC endpoints enforce strict envelopes and accept a four-signature QC body", async () => {
  const { votes, options, statement } = await commitFixture();
  const q = await buildQuorumCertificate(votes, options);
  const requests = [];
  const runtime = createValidatorServer({ config: { ...configs[0], listenPort: 0 }, logger: silent,
    commit: { async cast(epoch) { requests.push(epoch); return { result: "ACCEPTED" }; },
      async receive(vote) { requests.push(vote); return { result: "ACCEPTED" }; },
      async certificate() { return { result: "ACCEPTED", certificate: q }; },
      async submit(input) { assert.deepEqual(input, q); return { result: "ACCEPTED", status: "COMMITTED" }; },
      async list() { return { states: [] }; } } });
  await runtime.listen();
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  async function post(route, body) {
    return fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  }
  try {
    assert.equal((await post("/pbft/commit/cast", { epoch: statement.epoch })).status, 200);
    assert.equal((await post("/pbft/commit/cast", { epoch: statement.epoch, messageRoot: bytes("ff") })).status, 400);
    assert.equal((await post("/pbft/commit", votes[0])).status, 200);
    assert.equal((await post("/pbft/commit", { ...votes[0], receivedAt: "now" })).status, 400);
    assert.equal((await post("/pbft/qc", { epoch: statement.epoch })).status, 200);
    assert.equal((await post("/pbft/qc/submit", q)).status, 200);
    assert.equal((await fetch(`${base}/pbft/commits`)).status, 200);
    assert.equal((await post("/pbft/view-change", {})).status, 400);
    assert.equal(requests.length, 2);
  } finally { await runtime.close(); }
});
