import assert from "node:assert/strict";
import test from "node:test";
import { validatorAccount } from "../src/identity.mjs";
import { signPrePrepare } from "../src/pre-prepare.mjs";
import { authenticatePrepare, PREPARE_DOMAIN, prepareDigest, PrepareError, signPrepare } from "../src/prepare.mjs";
import { broadcastPrepare, createPrepareService } from "../src/prepare-service.mjs";
import { createValidatorServer } from "../src/server.mjs";
import { PRE_PREPARE_DOMAIN } from "../src/pre-prepare.mjs";
import { HANDSHAKE_DOMAIN } from "../src/handshake.mjs";
import { CROSS_CHAIN_MESSAGE_TYPEHASH } from "../../indexer/src/canonical-message.mjs";
import { MESSAGE_BATCH_TYPEHASH } from "../../indexer/src/message-batch.mjs";
import { MESSAGE_MERKLE_LEAF_DOMAIN, MESSAGE_MERKLE_NODE_DOMAIN } from "../../indexer/src/message-merkle.mjs";
import { deterministicPrimary } from "../src/committee.mjs";
import { configuration, snapshotFixture } from "./helpers/fixtures.mjs";

const configs = Array.from({ length: 4 }, (_, index) => configuration({}, index));
const silent = { warn() {}, error() {} };
const bytes = (byte) => `0x${byte.repeat(32)}`;

async function acceptedProposal(snapshot) {
  const primaryAddress = deterministicPrimary(configs[0].peers, snapshot.record.epoch);
  const primary = configs.find((config) => config.validatorAddress === primaryAddress);
  const envelope = await signPrePrepare(primary, { messageType: "PRE_PREPARE", protocolVersion: "1",
    sourceDomain: primary.chainDomain, sourceGateway: primary.sourceGateway, epoch: snapshot.record.epoch,
    batchId: snapshot.record.batchId, messageRoot: snapshot.record.messageRoot,
    primaryIdentity: primary.validatorAddress });
  return { validatorAddress: primary.validatorAddress, direction: "ACCEPTED", status: "ACCEPTED",
    acceptedAt: new Date(0).toISOString(), envelope };
}

function voteFields(proposal, config, overrides = {}) {
  return { messageType: "PREPARE", protocolVersion: "1", sourceDomain: proposal.envelope.sourceDomain,
    sourceGateway: proposal.envelope.sourceGateway, epoch: proposal.envelope.epoch,
    batchId: proposal.envelope.batchId, messageRoot: proposal.envelope.messageRoot,
    proposalDigest: proposal.envelope.proposalDigest, voterIdentity: config.validatorAddress, ...overrides };
}

async function rawSigned(fields, privateKey) {
  const digest = prepareDigest(fields);
  const signature = await validatorAccount(privateKey).signMessage({ message: { raw: digest } });
  return { ...fields, prepareDigest: digest, signature };
}

function memoryStore(proposal) {
  const proposals = new Map(proposal ? [[proposal.envelope.epoch, proposal]] : []);
  const votes = new Map();
  const prepared = new Map();
  const rejections = [];
  function matching(epoch) {
    const accepted = proposals.get(String(epoch));
    return [...votes.values()].filter((vote) => vote.epoch === String(epoch) && accepted &&
      vote.batchId === accepted.envelope.batchId && vote.messageRoot === accepted.envelope.messageRoot &&
      vote.proposalDigest === accepted.envelope.proposalDigest).sort((left, right) => left.voterIdentity.localeCompare(right.voterIdentity));
  }
  function result(epoch, voterIdentity) {
    const vote = votes.get(`${epoch}:${voterIdentity}`);
    if (!vote) return null;
    return { vote, voteCount: matching(epoch).length, prepared: prepared.get(String(epoch)) ?? null };
  }
  return { proposals, votes, prepared, rejections,
    async readPrePrepare(epoch) { return proposals.get(String(epoch)) ?? null; },
    async readPrePrepareByDigest(digest) { return [...proposals.values()].find((entry) => entry.envelope.proposalDigest === digest) ?? null; },
    async readPrepareVote(epoch, voterIdentity) { return result(String(epoch), voterIdentity); },
    async readPrepareStates() {
      return [...proposals.keys()].map((epoch) => ({ validatorAddress: null, epoch,
        voteCount: matching(epoch).length, votes: matching(epoch), prepared: prepared.get(epoch) ?? null }));
    },
    async recordPrepareRejection(input, reason) { rejections.push({ input, reason }); },
    async savePrepareVote(vote) {
      const accepted = proposals.get(vote.epoch);
      if (!accepted) throw new PrepareError("PRE_PREPARE_REQUIRED");
      const key = `${vote.epoch}:${vote.voterIdentity}`;
      const existing = votes.get(key);
      if (existing && existing.prepareDigest !== vote.prepareDigest) throw new PrepareError("CONFLICTING_PREPARE");
      if (!existing) votes.set(key, vote);
      const current = matching(vote.epoch);
      if (current.length >= 3 && !prepared.has(vote.epoch)) {
        prepared.set(vote.epoch, { validatorAddress: null, epoch: vote.epoch, batchId: vote.batchId,
          messageRoot: vote.messageRoot, proposalDigest: vote.proposalDigest,
          quorumVoters: current.slice(0, 3).map((entry) => entry.voterIdentity), preparedAt: new Date(0).toISOString() });
      }
      return result(vote.epoch, vote.voterIdentity);
    },
  };
}

async function harness(index = 0, { proposal = undefined, store = undefined, broadcast = undefined, sign = undefined } = {}) {
  const snapshot = await snapshotFixture();
  const accepted = proposal === undefined ? await acceptedProposal(snapshot) : proposal;
  const state = store ?? memoryStore(accepted);
  const deliveries = [];
  const sender = broadcast ?? (async (_config, envelope) => {
    const saved = await state.readPrepareVote(envelope.epoch, envelope.voterIdentity);
    assert.equal(saved.vote.prepareDigest, envelope.prepareDigest, "self PREPARE must persist before broadcast");
    deliveries.push(envelope); return [];
  });
  const service = createPrepareService({ config: configs[index], store: state, broadcast: sender,
    sign: sign ?? signPrepare, logger: silent });
  return { snapshot, accepted, store: state, service, deliveries };
}

test("PREPARE uses canonical ABI encoding, exact uint256 values, and an independent domain", async () => {
  const h = await harness();
  const fields = voteFields(h.accepted, configs[0]);
  const digest = prepareDigest(fields);
  assert.equal(prepareDigest(Object.fromEntries(Object.entries(fields).reverse())), digest);
  assert.equal(prepareDigest({ ...fields, epoch: BigInt(fields.epoch), sourceDomain: BigInt(fields.sourceDomain) }), digest);
  const maximum = (1n << 256n) - 1n;
  assert.equal(prepareDigest({ ...fields, epoch: maximum }), prepareDigest({ ...fields, epoch: maximum.toString() }));
  for (const mutation of [{ protocolVersion: "2" }, { sourceDomain: "2" },
    { sourceGateway: "0x0000000000000000000000000000000000000099" },
    { epoch: (BigInt(fields.epoch) + 1n).toString() }, { batchId: bytes("a1") },
    { messageRoot: bytes("a2") }, { proposalDigest: bytes("a3") },
    { voterIdentity: configs[1].validatorAddress }]) {
    assert.notEqual(prepareDigest({ ...fields, ...mutation }), digest);
  }
  for (const domain of [PRE_PREPARE_DOMAIN, HANDSHAKE_DOMAIN, CROSS_CHAIN_MESSAGE_TYPEHASH,
    MESSAGE_BATCH_TYPEHASH, MESSAGE_MERKLE_LEAF_DOMAIN, MESSAGE_MERKLE_NODE_DOMAIN]) {
    assert.notEqual(PREPARE_DOMAIN, domain);
  }
  for (const invalid of [{ messageType: "COMMIT" }, { batchId: "0x00" },
    { messageRoot: "bad" }, { proposalDigest: [] }, { protocolVersion: "256" }]) {
    assert.throws(() => prepareDigest({ ...fields, ...invalid }), { code: "MALFORMED" });
  }
});

test("PREPARE authentication binds the committee voter, recovered signer, digest, and every field", async () => {
  const h = await harness();
  const fields = voteFields(h.accepted, configs[1]);
  const envelope = await signPrepare(configs[1], fields);
  assert.equal((await authenticatePrepare(configs[0], envelope)).prepareDigest, envelope.prepareDigest);
  for (const mutation of [{ protocolVersion: "2" }, { sourceDomain: "2" },
    { sourceGateway: "0x0000000000000000000000000000000000000099" },
    { epoch: (BigInt(fields.epoch) + 1n).toString() }, { batchId: bytes("b1") },
    { messageRoot: bytes("b2") }, { proposalDigest: bytes("b3") }, { voterIdentity: configs[2].validatorAddress }]) {
    const changed = { ...fields, ...mutation };
    await assert.rejects(authenticatePrepare(configs[0], { ...changed,
      prepareDigest: prepareDigest(changed), signature: envelope.signature }));
  }
  await assert.rejects(authenticatePrepare(configs[0], { ...envelope, prepareDigest: bytes("ef") }), { code: "INVALID_DIGEST" });
  for (const signature of ["0x00", `0x${"00".repeat(65)}`, `0x${"ff".repeat(65)}`,
    `${envelope.signature.slice(0, -2)}ff`]) {
    await assert.rejects(authenticatePrepare(configs[0], { ...envelope, signature }), { code: "INVALID_SIGNATURE" });
  }
  const unknownKey = `0x${99n.toString(16).padStart(64, "0")}`;
  const unknown = validatorAccount(unknownKey).address.toLowerCase();
  const unknownVote = await rawSigned({ ...fields, voterIdentity: unknown }, unknownKey);
  await assert.rejects(authenticatePrepare(configs[0], unknownVote), { code: "UNKNOWN_VALIDATOR" });
  const wrongSigner = await rawSigned(fields, configs[2].privateKey);
  await assert.rejects(authenticatePrepare(configs[0], wrongSigner), { code: "INVALID_SIGNATURE" });
  await assert.rejects(authenticatePrepare(configs[0], { ...envelope, extra: true }), { code: "MALFORMED" });
});

test("self PREPARE requires accepted state, persists before broadcast, and survives retry/restart", async () => {
  const missing = await harness(0, { proposal: null });
  assert.equal((await missing.service.cast("1")).reason, "PRE_PREPARE_REQUIRED");
  assert.equal(missing.deliveries.length, 0); assert.equal(missing.store.votes.size, 0);
  const h = await harness();
  const first = await h.service.cast(h.accepted.envelope.epoch);
  assert.equal(first.result, "ACCEPTED"); assert.equal(first.voteCount, 1); assert.equal(first.prepared, false);
  assert.equal(h.deliveries.length, 1);
  const duplicate = await h.service.cast(h.accepted.envelope.epoch);
  assert.deepEqual(duplicate.record, first.record); assert.equal(h.store.votes.size, 1);
  const restarted = await harness(0, { proposal: h.accepted, store: h.store });
  assert.deepEqual((await restarted.service.cast(h.accepted.envelope.epoch)).record, first.record);
  const conflicting = { ...first.record.vote, proposalDigest: bytes("cc"), prepareDigest: bytes("dd") };
  h.store.votes.set(`${first.record.vote.epoch}:${configs[0].validatorAddress}`, conflicting);
  let signatures = 0;
  const locked = await harness(0, { proposal: h.accepted, store: h.store,
    sign: async (...args) => { signatures += 1; return signPrepare(...args); } });
  assert.equal((await locked.service.cast(h.accepted.envelope.epoch)).reason, "DOUBLE_VOTE");
  assert.equal(signatures, 0, "double-vote conflict must be found before signing");
});

test("PREPARE crash boundaries preserve only durable votes and retry the original envelope", async () => {
  const beforePersist = await harness(0, { sign: async () => { throw new Error("crash before persistence"); } });
  await assert.rejects(beforePersist.service.cast(beforePersist.accepted.envelope.epoch), /crash before persistence/);
  assert.equal(beforePersist.store.votes.size, 0);

  let persistedEnvelope;
  const afterPersist = await harness(0, { broadcast: async (_config, envelope) => {
    persistedEnvelope = envelope;
    const saved = await afterPersist.store.readPrepareVote(envelope.epoch, envelope.voterIdentity);
    assert.equal(saved.vote.prepareDigest, envelope.prepareDigest);
    throw new Error("crash before broadcast completion");
  } });
  await assert.rejects(afterPersist.service.cast(afterPersist.accepted.envelope.epoch), /crash before broadcast completion/);
  assert.equal(afterPersist.store.votes.size, 1);
  const restartedSender = await harness(0, { proposal: afterPersist.accepted, store: afterPersist.store });
  const retry = await restartedSender.service.cast(afterPersist.accepted.envelope.epoch);
  assert.deepEqual(retry.record.vote, persistedEnvelope);

  const receiver = await harness();
  const remoteVote = await signPrepare(configs[1], voteFields(receiver.accepted, configs[1]));
  const durableStore = receiver.store;
  const lostResponseStore = { ...durableStore, async savePrepareVote(vote) {
    await durableStore.savePrepareVote(vote);
    throw new Error("receiver crashed before response");
  } };
  const interruptedReceiver = await harness(0, { proposal: receiver.accepted, store: lostResponseStore });
  await assert.rejects(interruptedReceiver.service.receive(remoteVote), /receiver crashed before response/);
  const restartedReceiver = await harness(0, { proposal: receiver.accepted, store: durableStore });
  const recovered = await restartedReceiver.service.receive(remoteVote);
  assert.equal(recovered.result, "ACCEPTED"); assert.equal(recovered.voteCount, 1);
  assert.equal(durableStore.votes.size, 1);
});

test("unique durable voters produce PREPARED only at three matching votes and never regress", async () => {
  const h = await harness();
  const envelopes = await Promise.all(configs.map((config) => signPrepare(config, voteFields(h.accepted, config))));
  const one = await h.service.receive(envelopes[0]);
  assert.equal(one.voteCount, 1); assert.equal(one.prepared, false);
  for (let index = 0; index < 100; index++) {
    const duplicate = await h.service.receive(envelopes[0]);
    assert.equal(duplicate.voteCount, 1); assert.equal(duplicate.prepared, false);
  }
  const two = await h.service.receive(envelopes[1]);
  assert.equal(two.voteCount, 2); assert.equal(two.prepared, false);
  const three = await h.service.receive(envelopes[2]);
  assert.equal(three.voteCount, 3); assert.equal(three.prepared, true);
  const prepared = three.record.prepared;
  assert.equal(new Set(prepared.quorumVoters).size, 3);
  const four = await h.service.receive(envelopes[3]);
  assert.equal(four.voteCount, 4); assert.equal(four.prepared, true);
  assert.deepEqual(four.record.prepared, prepared);
  const restarted = await harness(0, { proposal: h.accepted, store: h.store });
  assert.deepEqual((await restarted.service.list()).states[0].prepared, prepared);
});

test("mismatched, premature, and conflicting votes never add quorum weight", async () => {
  const h = await harness();
  const canonical = await Promise.all(configs.map((config) => signPrepare(config, voteFields(h.accepted, config))));
  await h.service.receive(canonical[0]); await h.service.receive(canonical[1]);
  const wrongCases = [
    [await signPrepare(configs[2], voteFields(h.accepted, configs[2], { batchId: bytes("d1") })), "WRONG_BATCH_ID"],
    [await signPrepare(configs[2], voteFields(h.accepted, configs[2], { messageRoot: bytes("d2") })), "WRONG_ROOT"],
    [await signPrepare(configs[2], voteFields(h.accepted, configs[2], { proposalDigest: bytes("d3") })), "WRONG_PROPOSAL"],
  ];
  const changedEpoch = (BigInt(h.accepted.envelope.epoch) + 1n).toString();
  wrongCases.push([await signPrepare(configs[2], voteFields(h.accepted, configs[2], { epoch: changedEpoch })), "WRONG_EPOCH"]);
  for (const [envelope, reason] of wrongCases) {
    assert.equal((await h.service.receive(envelope)).reason, reason);
    assert.equal((await h.service.list()).states[0].voteCount, 2);
    assert.equal((await h.service.list()).states[0].prepared, null);
  }
  await h.service.receive(canonical[2]);
  const conflict = await signPrepare(configs[2], voteFields(h.accepted, configs[2], { messageRoot: bytes("ee") }));
  assert.equal((await h.service.receive(conflict)).reason, "CONFLICTING_PREPARE");
  const state = (await h.service.list()).states[0];
  assert.equal(state.voteCount, 3); assert.ok(state.prepared);
  assert.equal(h.store.rejections.length, wrongCases.length + 1);
});

test("concurrent duplicate and third-vote delivery retain one vote per identity and PREPARED", async () => {
  const h = await harness();
  const votes = await Promise.all(configs.slice(0, 3).map((config) => signPrepare(config, voteFields(h.accepted, config))));
  await h.service.receive(votes[0]);
  const results = await Promise.all([
    ...Array.from({ length: 8 }, () => h.service.receive(votes[1])),
    ...Array.from({ length: 8 }, () => h.service.receive(votes[2])),
  ]);
  assert.ok(results.some((result) => result.prepared));
  const state = (await h.service.list()).states[0];
  assert.equal(state.voteCount, 3); assert.ok(state.prepared);
  assert.equal(h.store.votes.size, 3);
});

test("PREPARE broadcast is bounded and reports delivery without treating responses as votes", async () => {
  const h = await harness();
  const envelope = await signPrepare(configs[0], voteFields(h.accepted, configs[0]));
  const peers = configs[0].peers.filter((peer) => peer.address !== configs[0].validatorAddress);
  const authenticated = [];
  const calls = [];
  const result = await broadcastPrepare(configs[0], envelope, {
    authenticatePeer: async (_config, address) => { authenticated.push(address); },
    fetchImplementation: async (url, options) => {
      calls.push({ url, options });
      const peer = peers.find((entry) => url === `${entry.url}/pbft/prepare`);
      if (peer === peers[2]) throw new Error("offline");
      return { status: 200, async json() {
        return { validatorAddress: peer.address, result: "ACCEPTED", prepareDigest: envelope.prepareDigest };
      } };
    },
  });
  assert.equal(authenticated.length, 3); assert.equal(calls.length, 3);
  assert.equal(result.filter((entry) => entry.delivery === "FAILED").length, 1);
  for (const call of calls) {
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(call.options.body), envelope);
  }
  assert.ok(!JSON.stringify(result).includes("signature"));
});

test("validator HTTP transport exposes strict PREPARE cast, receive, and local-state routes", async () => {
  const h = await harness();
  const runtime = createValidatorServer({ config: { ...configs[0], listenPort: 0 },
    service: { async validate() { return { result: "INVALID" }; } },
    store: { async readObservations() { return []; }, async readPrePrepares() { return [h.accepted]; } },
    prePrepare: {}, prepare: h.service, logger: silent });
  await runtime.listen();
  const url = `http://127.0.0.1:${runtime.server.address().port}`;
  async function post(route, body) {
    const response = await fetch(`${url}${route}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }
  try {
    assert.equal((await post("/pbft/prepare/cast", { epoch: 1 })).status, 422);
    const cast = await post("/pbft/prepare/cast", { epoch: h.accepted.envelope.epoch });
    assert.equal(cast.status, 200); assert.equal(cast.body.result, "ACCEPTED");
    assert.equal((await post("/pbft/prepare", cast.body.record.vote)).status, 200);
    assert.equal((await post("/pbft/prepare", { ...cast.body.record.vote, extra: true })).status, 400);
    const states = await (await fetch(`${url}/pbft/prepares`)).json();
    assert.equal(states.states[0].voteCount, 1);
    assert.equal((await post("/pbft/commit", {})).status, 404);
    assert.ok(!JSON.stringify(states).includes(configs[0].privateKey));
  } finally { await runtime.close(); }
});
