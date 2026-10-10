import assert from "node:assert/strict";
import test from "node:test";
import { canonicalCommittee, deterministicPrimary } from "../src/committee.mjs";
import { authenticatePrePrepare, PRE_PREPARE_DOMAIN, prePrepareDigest, PrePrepareError, signPrePrepare } from "../src/pre-prepare.mjs";
import { broadcastPrePrepare, createPrePrepareService } from "../src/pre-prepare-service.mjs";
import { createBatchValidationService, SourceValidationError } from "../src/source-validation.mjs";
import { HANDSHAKE_DOMAIN } from "../src/handshake.mjs";
import { validatorAccount } from "../src/identity.mjs";
import { createValidatorServer } from "../src/server.mjs";
import { MESSAGE_MERKLE_LEAF_DOMAIN, MESSAGE_MERKLE_NODE_DOMAIN } from "../../indexer/src/message-merkle.mjs";
import { CROSS_CHAIN_MESSAGE_TYPEHASH } from "../../indexer/src/canonical-message.mjs";
import { MESSAGE_BATCH_TYPEHASH } from "../../indexer/src/message-batch.mjs";
import { chainFixture, configuration, snapshotFixture } from "./helpers/fixtures.mjs";

const configs = Array.from({ length: 4 }, (_, index) => configuration({}, index));
const silent = { warn() {}, error() {} };
const bytes = (byte) => `0x${byte.repeat(32)}`;

function primaryConfig(epoch) {
  return configs.find((config) => config.validatorAddress === deterministicPrimary(config.peers, epoch));
}
function fields(snapshot, overrides = {}) {
  return { messageType: "PRE_PREPARE", protocolVersion: "2", view: "0", sourceDomain: snapshot.record.sourceDomain.toString(),
    sourceGateway: snapshot.record.sourceGateway, epoch: snapshot.record.epoch.toString(),
    batchId: snapshot.record.batchId, messageRoot: snapshot.record.messageRoot,
    primaryIdentity: primaryConfig(snapshot.record.epoch).validatorAddress, ...overrides };
}
async function rawSigned(p, signer = primaryConfig(p.epoch)) {
  const proposalDigest = prePrepareDigest(p);
  const signature = await validatorAccount(signer.privateKey).signMessage({ message: { raw: proposalDigest } });
  return { ...p, proposalDigest, signature };
}
function memoryStore() {
  const proposals = new Map();
  const rejections = [];
  const observations = [];
  return { proposals, rejections, observations,
    async recordObservation(value) { observations.push(value); return { validated_at: new Date(0) }; },
    async readPrePrepare(epoch) { return proposals.get(String(epoch)) ?? null; },
    async readPrePrepares() { return [...proposals.values()]; },
    async readObservations() { return []; },
    async recordPrePrepareRejection(input, reason) { rejections.push({ input, reason }); },
    async savePrePrepare(envelope, direction) {
      const previous = proposals.get(envelope.epoch);
      if (previous && previous.envelope.proposalDigest !== envelope.proposalDigest) throw new PrePrepareError("CONFLICTING_PRE_PREPARE");
      if (previous) return previous;
      const record = { envelope, direction, status: "ACCEPTED", acceptedAt: new Date(0).toISOString() };
      proposals.set(envelope.epoch, record);
      return record;
    },
  };
}
function harness(snapshot, config = primaryConfig(snapshot.record.epoch), overrides = {}) {
  const store = overrides.store ?? memoryStore();
  const chain = overrides.chain ?? chainFixture(snapshot);
  const validation = createBatchValidationService({ config, store, publicClient: chain,
    reader: overrides.reader ?? { async read() { return snapshot; } }, logger: silent });
  const deliveries = [];
  const broadcast = async (_config, envelope) => {
    assert.equal((await store.readPrePrepare(envelope.epoch)).envelope.proposalDigest, envelope.proposalDigest,
      "primary must persist before broadcast");
    deliveries.push(envelope); return [];
  };
  const service = createPrePrepareService({ config, store, validation, broadcast, logger: silent });
  return { config, store, chain, validation, service, deliveries };
}

test("canonical committee ignores all peer permutations; uint256 primary rotation stays exact", () => {
  const peers = configs[0].peers;
  const committee = canonicalCommittee(peers);
  const maximum = (1n << 256n) - 1n;
  for (const epoch of [0n, 1n, 3n, 4n, (1n << 200n) + 3n, maximum]) {
    for (const order of [peers, [...peers].reverse(), [...peers.slice(1), peers[0]], [peers[2], peers[0], peers[3], peers[1]]]) {
      assert.equal(deterministicPrimary(order, epoch), committee[Number(epoch % 4n)]);
    }
  }
  assert.equal(new Set([0n, 1n, 2n, 3n].map((epoch) => deterministicPrimary(peers, epoch))).size, 4);
  assert.equal(deterministicPrimary(peers, maximum - 4n), deterministicPrimary(peers, maximum));
  assert.throws(() => canonicalCommittee(peers.slice(1)));
  assert.throws(() => canonicalCommittee([peers[0], peers[0], peers[2], peers[3]]));
  for (const epoch of [-1n, maximum + 1n, 1, "01", "bad"]) assert.throws(() => deterministicPrimary(peers, epoch));
});

test("canonical ABI digest is deterministic, domain-separated, and binds every protocol field", async () => {
  const snapshot = await snapshotFixture();
  const p = fields(snapshot);
  const digest = prePrepareDigest(p);
  assert.equal(prePrepareDigest(Object.fromEntries(Object.entries(p).reverse())), digest);
  assert.equal(prePrepareDigest({ ...p, epoch: BigInt(p.epoch), sourceDomain: BigInt(p.sourceDomain) }), digest);
  for (const mutation of [{ protocolVersion: "3" }, { sourceDomain: "2" },
    { sourceGateway: "0x0000000000000000000000000000000000000099" }, { epoch: (BigInt(p.epoch) + 1n).toString() },
    { batchId: bytes("ab") }, { messageRoot: bytes("bc") }, { primaryIdentity: configs.find((c) => c.validatorAddress !== p.primaryIdentity).validatorAddress }]) {
    assert.notEqual(prePrepareDigest({ ...p, ...mutation }), digest);
  }
  for (const domain of [HANDSHAKE_DOMAIN, MESSAGE_MERKLE_LEAF_DOMAIN, MESSAGE_MERKLE_NODE_DOMAIN,
    CROSS_CHAIN_MESSAGE_TYPEHASH, MESSAGE_BATCH_TYPEHASH]) assert.notEqual(PRE_PREPARE_DOMAIN, domain);
  const maximum = (1n << 256n) - 1n;
  assert.equal(prePrepareDigest({ ...p, epoch: maximum }), prePrepareDigest({ ...p, epoch: maximum.toString() }));
  for (const invalid of [{ batchId: "0x00" }, { messageRoot: "bad" }, { messageType: "PREPARE" }, { protocolVersion: "256" }]) {
    assert.throws(() => prePrepareDigest({ ...p, ...invalid }));
  }
});

test("authentication requires the exact primary, context, digest, and valid recoverable signature", async () => {
  const p = fields(await snapshotFixture());
  const signer = primaryConfig(p.epoch);
  const envelope = await signPrePrepare(signer, p);
  assert.equal((await authenticatePrePrepare(configs[0], envelope)).proposalDigest, envelope.proposalDigest);
  for (const mutation of [{ protocolVersion: "3" }, { sourceDomain: "2" },
    { sourceGateway: "0x0000000000000000000000000000000000000099" }, { epoch: (BigInt(p.epoch) + 1n).toString() },
    { batchId: bytes("ab") }, { messageRoot: bytes("bc") },
    { primaryIdentity: configs.find((config) => config !== signer).validatorAddress }]) {
    const changed = { ...p, ...mutation };
    await assert.rejects(authenticatePrePrepare(configs[0], { ...changed, proposalDigest: prePrepareDigest(changed), signature: envelope.signature }));
  }
  for (const other of configs.filter((config) => config !== signer)) {
    await assert.rejects(authenticatePrePrepare(configs[0], await rawSigned(p, other)), { code: "INVALID_SIGNATURE" });
    await assert.rejects(authenticatePrePrepare(configs[0], await rawSigned({ ...p, primaryIdentity: other.validatorAddress }, other)), { code: "WRONG_PRIMARY" });
    await assert.rejects(signPrePrepare(other, { ...p, primaryIdentity: other.validatorAddress }), { code: "WRONG_PRIMARY" });
  }
  const mutations = ["0x00", `0x${"00".repeat(65)}`, `0x${"ff".repeat(65)}`,
    `0x${"00".repeat(32)}${envelope.signature.slice(66)}`,
    `${envelope.signature.slice(0, 66)}${"00".repeat(32)}${envelope.signature.slice(130)}`,
    `${envelope.signature.slice(0, -2)}ff`];
  for (const signature of mutations) await assert.rejects(authenticatePrePrepare(configs[0], { ...envelope, signature }), { code: "INVALID_SIGNATURE" });
  for (const mutation of [{ messageRoot: bytes("ee") }, { epoch: (BigInt(p.epoch) + 1n).toString() }, { proposalDigest: bytes("ee") }]) {
    await assert.rejects(authenticatePrePrepare(configs[0], { ...envelope, ...mutation }), { code: "INVALID_DIGEST" });
  }
  await assert.rejects(authenticatePrePrepare(configs[0], await rawSigned({ ...p, protocolVersion: "3" })), { code: "WRONG_VERSION" });
  for (const mutation of [{ sourceDomain: "2" }, { sourceGateway: "0x0000000000000000000000000000000000000099" }]) {
    await assert.rejects(authenticatePrePrepare(configs[0], await rawSigned({ ...p, ...mutation })), { code: "WRONG_CONTEXT" });
  }
  const unknown = { privateKey: `0x${99n.toString(16).padStart(64, "0")}` };
  const address = validatorAccount(unknown.privateKey).address.toLowerCase();
  await assert.rejects(authenticatePrePrepare(configs[0], await rawSigned({ ...p, primaryIdentity: address }, unknown)), { code: "WRONG_PRIMARY" });
  await assert.rejects(authenticatePrePrepare(configs[0], { ...envelope, extra: true }), { code: "MALFORMED" });
});

test("primary validates before signing, persists before broadcast, and retries the identical envelope", async () => {
  const snapshot = await snapshotFixture();
  const h = harness(snapshot);
  const first = await h.service.propose(snapshot.record.batchId);
  assert.equal(first.result, "ACCEPTED"); assert.equal(first.record.direction, "ISSUED");
  assert.equal(h.chain.calls.latestHeads, 1);
  assert.equal(h.chain.calls.receipts.length, snapshot.batch.messages.length);
  assert.deepEqual((await h.service.propose(snapshot.record.batchId)).record, first.record);
  const restarted = harness(snapshot, h.config, { store: h.store });
  assert.deepEqual((await restarted.service.propose(snapshot.record.batchId)).record, first.record);
  assert.equal(h.store.proposals.size, 1);
  const backup = configs.find((config) => config !== h.config);
  const refused = harness(snapshot, backup);
  assert.equal((await refused.service.propose(snapshot.record.batchId)).reason, "WRONG_PRIMARY");
  assert.equal(refused.deliveries.length, 0); assert.equal(refused.store.proposals.size, 0);
  for (const status of ["BUILDING", "SEALED", "COMMITTED"]) {
    const invalid = harness({ ...snapshot, record: { ...snapshot.record, status } });
    assert.equal((await invalid.service.propose(snapshot.record.batchId)).reason, "INVALID_LIFECYCLE");
    assert.equal(invalid.deliveries.length, 0); assert.equal(invalid.store.proposals.size, 0);
  }
});

test("backup independently reconstructs the source; duplicates and restart preserve the safety lock", async () => {
  const snapshot = await snapshotFixture();
  const p = fields(snapshot);
  const backup = configs.find((config) => config.validatorAddress !== p.primaryIdentity);
  const h = harness(snapshot, backup);
  const envelope = await rawSigned(p);
  const first = await h.service.receive(envelope);
  assert.equal(first.result, "ACCEPTED"); assert.equal(first.record.direction, "ACCEPTED");
  assert.equal(h.chain.calls.latestHeads, 1); assert.equal(h.deliveries.length, 0);
  const duplicates = await Promise.all(Array.from({ length: 6 }, () => h.service.receive(envelope)));
  for (const duplicate of duplicates) assert.deepEqual(duplicate.record, first.record);
  const restarted = harness(snapshot, backup, { store: h.store });
  assert.deepEqual((await restarted.service.receive(envelope)).record, first.record);
  const conflicting = await rawSigned({ ...p, messageRoot: bytes("ee") });
  assert.equal((await restarted.service.receive(conflicting)).reason, "CONFLICTING_PRE_PREPARE");
  assert.equal(h.store.proposals.size, 1); assert.deepEqual(await h.store.readPrePrepare(p.epoch), first.record);
});

test("crashes before persistence leave no slot; crashes after persistence rebroadcast the stored envelope", async () => {
  const snapshot = await snapshotFixture();
  const h = harness(snapshot);
  let deliveries = 0;
  const broadcast = async () => { deliveries += 1; throw new Error("crash before delivery"); };
  const interrupted = createPrePrepareService({ config: h.config, validation: h.validation, store: h.store, broadcast, logger: silent });
  await assert.rejects(interrupted.propose(snapshot.record.batchId), /crash before delivery/);
  const persisted = await h.store.readPrePrepare(snapshot.record.epoch);
  assert.equal(persisted.envelope.proposalDigest, prePrepareDigest(fields(snapshot)));
  const recovered = await h.service.propose(snapshot.record.batchId);
  assert.deepEqual(recovered.record, persisted);
  assert.equal(deliveries, 1);
  const failedStore = memoryStore();
  failedStore.savePrePrepare = async () => { throw new Error("persistence interrupted"); };
  const beforePersist = harness(snapshot, h.config, { store: failedStore });
  await assert.rejects(beforePersist.service.propose(snapshot.record.batchId), /persistence interrupted/);
  assert.equal(failedStore.proposals.size, 0); assert.equal(beforePersist.deliveries.length, 0);
  assert.equal((await harness(snapshot, h.config).service.propose(snapshot.record.batchId)).proposalDigest, persisted.envelope.proposalDigest);
});

test("valid primary signatures cannot authorize wrong root/epoch/lifecycle/reference or corrupt source", async () => {
  const snapshot = await snapshotFixture();
  const p = fields(snapshot);
  for (const [mutation, reason] of [[{ messageRoot: bytes("ee") }, "WRONG_ROOT"],
    [{ epoch: (BigInt(p.epoch) + 1n).toString(), primaryIdentity: primaryConfig(BigInt(p.epoch) + 1n).validatorAddress }, "WRONG_EPOCH"]]) {
    const h = harness(snapshot);
    assert.equal((await h.service.receive(await rawSigned({ ...p, ...mutation }))).reason, reason);
    assert.equal(h.store.proposals.size, 0);
    assert.equal((await h.service.receive(await rawSigned(p))).result, "ACCEPTED", "rejection must not reserve epoch");
  }
  for (const status of ["BUILDING", "SEALED", "COMMITTED"]) {
    const h = harness({ ...snapshot, record: { ...snapshot.record, status } });
    assert.equal((await h.service.receive(await rawSigned(p))).reason, "INVALID_LIFECYCLE");
    assert.equal(h.store.proposals.size, 0);
  }
  const missing = harness(snapshot, undefined, { reader: { async read() { throw new SourceValidationError("BATCH_NOT_FOUND", "unknown batch"); } } });
  assert.equal((await missing.service.receive(await rawSigned({ ...p, batchId: bytes("ff") }))).reason, "UNKNOWN_BATCH");
  assert.equal(missing.store.proposals.size, 0);
  const wrongCandidate = harness(snapshot);
  assert.equal((await wrongCandidate.service.receive(await rawSigned({ ...p, batchId: bytes("ff") }))).reason, "INVALID_SOURCE_STATE");
  for (const mutation of ["block", "event", "depth", "reorged", "root"]) {
    const candidate = mutation === "reorged" ? { ...snapshot, batch: { ...snapshot.batch,
      messages: snapshot.batch.messages.map((m, i) => i === 0 ? { ...m, status: "REORGED" } : m) } } :
      mutation === "root" ? { ...snapshot, record: { ...snapshot.record, messageRoot: bytes("ee") } } : snapshot;
    const chain = chainFixture(snapshot, mutation === "depth" ? snapshot.batch.messages[0].sourceBlockNumber : undefined);
    if (mutation === "block") {
      const getBlock = chain.getBlock.bind(chain);
      chain.getBlock = async (args) => { const block = await getBlock(args); return args.blockNumber === snapshot.batch.messages[0].sourceBlockNumber ? { ...block, hash: bytes("ee") } : block; };
    }
    if (mutation === "event") {
      const receipt = chain.getTransactionReceipt.bind(chain);
      chain.getTransactionReceipt = async (args) => ({ ...await receipt(args), logs: [] });
    }
    const h = harness(candidate, undefined, { chain });
    assert.equal((await h.service.receive(await rawSigned(p))).reason, "INVALID_SOURCE_STATE");
    assert.equal((await h.service.propose(p.batchId)).result, "REJECTED");
    assert.equal(h.store.proposals.size, 0); assert.equal(h.deliveries.length, 0);
  }
});

test("broadcast is bounded, authenticates configured peers, and reports failure without quorum", async () => {
  const p = fields(await snapshotFixture());
  const config = primaryConfig(p.epoch);
  const envelope = await rawSigned(p);
  const calls = [];
  const peers = config.peers.filter((peer) => peer.address !== config.validatorAddress);
  const authenticated = [];
  const result = await broadcastPrePrepare(config, envelope, {
    authenticatePeer: async (_config, address) => { authenticated.push(address); },
    fetchImplementation: async (url, options) => {
      calls.push({ url, options });
      const peer = peers.find((entry) => url === `${entry.url}/pbft/pre-prepare`);
      if (peer === peers[2]) throw new Error("offline");
      return { status: 200, async json() { return { result: "ACCEPTED", validatorAddress: peer.address, proposalDigest: envelope.proposalDigest }; } };
    },
  });
  assert.equal(calls.length, 3); assert.equal(authenticated.length, 3);
  assert.equal(result.filter((entry) => entry.delivery === "FAILED").length, 1);
  for (const call of calls) { assert.ok(call.options.signal instanceof AbortSignal); assert.deepEqual(JSON.parse(call.options.body), envelope); }
  assert.ok(!JSON.stringify(result).includes("signature"));
});

test("existing HTTP server exposes only PRE-PREPARE routes with bounded strict fields", async () => {
  const snapshot = await snapshotFixture();
  const h = harness(snapshot);
  const runtime = createValidatorServer({ config: { ...h.config, listenPort: 0 }, service: h.validation,
    store: h.store, prePrepare: h.service, logger: silent });
  await runtime.listen();
  const url = `http://127.0.0.1:${runtime.server.address().port}`;
  async function post(route, body) {
    const response = await fetch(`${url}${route}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }
  try {
    assert.equal((await post("/pbft/primary", { view: "0", epoch: snapshot.record.epoch.toString() })).body.primaryIdentity, h.config.validatorAddress);
    assert.equal((await post("/pbft/primary", { view: "0", epoch: 1 })).status, 400);
    assert.equal((await post("/pbft/propose", { batchId: snapshot.record.batchId, messageRoot: snapshot.record.messageRoot })).status, 400);
    const result = await post("/pbft/propose", { batchId: snapshot.record.batchId });
    assert.equal(result.status, 200);
    assert.equal((await post("/pbft/pre-prepare", result.body.record.envelope)).status, 200);
    const malformed = await post("/pbft/pre-prepare", { ...result.body.record.envelope, proposalDigest: [result.body.proposalDigest] });
    assert.equal(malformed.status, 422); assert.equal(malformed.body.reason, "MALFORMED");
    assert.equal((await post("/pbft/view-change", {})).status, 400);
    const list = await (await fetch(`${url}/pbft/pre-prepares`)).json();
    assert.equal(list.proposals.length, 1);
    assert.ok(!JSON.stringify(list).includes(h.config.privateKey));
  } finally { await runtime.close(); }
});
