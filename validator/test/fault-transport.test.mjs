import assert from "node:assert/strict";
import test from "node:test";
import { createPeerProxy, createTransportGate } from "./helpers/fault-transport.mjs";
import { commitConfigs, commitFixture, signedCommitFixture } from "./helpers/commit-fixtures.mjs";
import { authenticateCommit } from "../src/commit.mjs";
import { buildQuorumCertificate } from "../src/quorum-certificate.mjs";

const identities = commitConfigs.map((config) => config.validatorAddress);

test("transport gate starts unblocked, supports directional failure, and heals only delivery policy", () => {
  const gate = createTransportGate(identities);
  for (const from of identities) for (const to of identities) if (from !== to) assert.equal(gate.isBlocked(from, to), false);
  gate.block(identities[0], identities[2]);
  assert.equal(gate.isBlocked(identities[0], identities[2]), true);
  assert.equal(gate.isBlocked(identities[2], identities[0]), false);
  gate.heal(); assert.equal(gate.isBlocked(identities[0], identities[2]), false);
  assert.throws(() => gate.block(identities[0], "unknown"));
});

test("2|2 partition blocks exactly eight directed cross-group edges and preserves same-group delivery", () => {
  const gate = createTransportGate(identities);
  gate.partition([identities.slice(0, 2), identities.slice(2)]);
  let count = 0;
  for (let from = 0; from < 4; from++) for (let to = 0; to < 4; to++) {
    if (from === to) continue;
    const crossGroup = (from < 2) !== (to < 2);
    assert.equal(gate.isBlocked(identities[from], identities[to]), crossGroup);
    if (gate.isBlocked(identities[from], identities[to])) count++;
  }
  assert.equal(count, 8);
  assert.throws(() => gate.partition([[identities[0], identities[1]], [identities[0], identities[3]]]));
  gate.heal();
  for (const from of identities) for (const to of identities) if (from !== to) assert.equal(gate.isBlocked(from, to), false);
});

test("peer proxy blocks before forwarding and preserves the exact signed envelope after healing", async () => {
  const gate = createTransportGate(identities);
  const { votes } = await commitFixture();
  const wireBody = JSON.stringify(votes[0]);
  const forwarded = [];
  const proxy = await createPeerProxy({ from: identities[0], to: identities[2], targetUrl: "http://127.0.0.1:1", gate,
    fetchImplementation: async (_url, options) => {
      forwarded.push(Buffer.from(options.body).toString("utf8"));
      assert.ok(options.signal instanceof AbortSignal);
      await authenticateCommit(commitConfigs[2], JSON.parse(forwarded.at(-1)));
      return new Response(JSON.stringify({ commitDigest: votes[0].commitDigest }), { status: 200 });
    } });
  async function deliver() {
    return fetch(`${proxy.url}/pbft/commit`, { method: "POST", headers: { "content-type": "application/json" },
      body: wireBody, signal: AbortSignal.timeout(5000) });
  }
  try {
    assert.equal((await deliver()).status, 200);
    gate.block(identities[0], identities[2]);
    assert.equal((await deliver()).status, 503); assert.equal(forwarded.length, 1);
    gate.heal();
    assert.equal((await deliver()).status, 200);
    assert.deepEqual(forwarded, [wireBody, wireBody]);
    assert.deepEqual(proxy.records.map((record) => record.delivery), ["FORWARDED", "BLOCKED", "FORWARDED"]);
    assert.ok(!JSON.stringify(proxy.records).includes(votes[0].signature));
  } finally { await proxy.close(); await proxy.close(); }
});

test("two isolated signer groups cannot form a QC; three matching live signers exclude stale offline votes", async () => {
  const { votes, options, statement } = await commitFixture();
  await assert.rejects(buildQuorumCertificate(votes.slice(0, 2), options));
  await assert.rejects(buildQuorumCertificate(votes.slice(2), options));
  const qc = await buildQuorumCertificate(votes.slice(0, 3), options);
  assert.equal(qc.commits.length, 3); assert.ok(qc.commits.every((v) => v.voterIdentity !== identities[3]));
  const stale = await signedCommitFixture(statement, commitConfigs[3], { epoch: (BigInt(votes[3].epoch) + 1n).toString() });
  await authenticateCommit(commitConfigs[0], stale);
  await assert.rejects(buildQuorumCertificate([votes[0], votes[1], stale], options));
});
