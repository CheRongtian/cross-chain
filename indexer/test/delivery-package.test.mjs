import assert from "node:assert/strict";
import test from "node:test";
import { computeCanonicalMessageId, computePayloadHash } from "../src/canonical-message.mjs";
import { createValidatorSetResolver } from "../../validator/src/validator-sets.mjs";
import { buildDeliveryPackages, deliveryJobId, deliveryJson, deliveryLimit, verifyDeliveryPackage } from "../src/delivery/package.mjs";
import { deliveryFixture, deliveryValidatorSets, fixtureHash } from "./helpers/delivery-fixtures.mjs";

const options = { validatorSets: deliveryValidatorSets };
const copy = (value) => JSON.parse(deliveryJson(value));

test("committed packages are portable, ordered, immutable and use exact opaque canonical data", async () => {
  const snapshot = await deliveryFixture({ multiDestination: true, epoch: (1n << 200n) + 1n });
  const packages = await buildDeliveryPackages(snapshot, options);
  assert.equal(packages.length,3);
  for (const [index,pack] of packages.entries()) {
    assert.deepEqual(await verifyDeliveryPackage(copy(pack), options), pack);
    assert.equal(pack.messageIndex,Number(snapshot.members[index].position));
    assert.equal(pack.message.messageId,snapshot.members[index].messageId);
    assert.deepEqual(pack.merkleProof.siblings,snapshot.tree.proofs[index].siblings);
    assert.deepEqual(pack.quorumCertificate,snapshot.quorumCertificate);
    assert.equal(pack.message.payload,"0x00ff80");
    assert.equal(pack.message.deadline,((1n << 200n) + 123n).toString());
    assert.equal(Object.isFrozen(pack.merkleProof.siblings),true);
  }
  assert.equal(packages[0].message.destinationDomain,"2001");
  assert.equal(packages[1].message.destinationDomain,"3001");
  const pack = packages[0];
  const fields = { ...pack.message,batchId: pack.batchId,messageIndex: pack.messageIndex };
  assert.equal(deliveryJobId(fields),pack.deliveryJobId);
  assert.equal(deliveryJobId({ ...fields,createdAt: "different",materializedAt: "later" }),pack.deliveryJobId);
  assert.notEqual(deliveryJobId({ ...fields,batchId: fixtureHash(999) }),pack.deliveryJobId);
  assert.notEqual(deliveryJobId({ ...fields,messageIndex: 1 }),pack.deliveryJobId);
  assert.notEqual(packages[1].deliveryJobId,pack.deliveryJobId);
});

test("only complete, matching COMMITTED evidence can construct packages", async () => {
  const snapshot = await deliveryFixture();
  for (const status of ["BUILDING","SEALED","CONSENSUS_PENDING"]) {
    await assert.rejects(buildDeliveryPackages({ ...snapshot,record: { ...snapshot.record,status } },options), { code: "DELIVERY_REQUIRES_COMMITTED" });
  }
  await assert.rejects(buildDeliveryPackages({ ...snapshot,quorumCertificate: null },options), { code: "DELIVERY_REQUIRES_QC" });
  const anotherBatch = await deliveryFixture({ epoch: 24n });
  await assert.rejects(buildDeliveryPackages({ ...snapshot,quorumCertificate: anotherBatch.quorumCertificate },options));
  for (const mutation of [
    { record: { ...snapshot.record,messageRoot: fixtureHash(555) } },
    { record: { ...snapshot.record,batchId: fixtureHash(555) } },
    { members: snapshot.members.map((member,index) => index === 1 ? { ...member,position: 2n } : member) },
    { members: snapshot.members.slice(0,2) },
    { quorumCertificate: { ...snapshot.quorumCertificate,commits: snapshot.quorumCertificate.commits.slice(0,2) } },
    { consensusBinding: { ...snapshot.consensusBinding,validatorEpoch: "1" } },
    { batch: { ...snapshot.batch,messages: snapshot.batch.messages.map((message,index) => index === 0 ? { ...message,status: "REORGED" } : message) } },
  ]) await assert.rejects(buildDeliveryPackages({ ...snapshot,...mutation },options));
});

test("portable verification rejects message, context, proof, membership and QC corruption", async () => {
  const [pack,other] = await buildDeliveryPackages(await deliveryFixture(),options);
  const mutations = [
    (p) => { p.message.payload = "0x80ff00"; },
    (p) => { p.message.messageId = fixtureHash(99); },
    (p) => { p.message.destinationGateway = "0x0000000000000000000000000000000000009999"; },
    (p) => { p.message.sourceGateway = "0x0000000000000000000000000000000000009999"; },
    (p) => { p.messageRoot = fixtureHash(99); },
    (p) => { p.batchId = fixtureHash(99); },
    (p) => { p.batchEpoch = "999"; },
    (p) => { p.messageIndex = 1; },
    (p) => { p.leafCount = 4; p.merkleProof.leafCount = 4; },
    (p) => { p.batchMessageIds.reverse(); },
    (p) => { p.batchMessageIds.push(p.batchMessageIds[2]); p.leafCount = 4; p.merkleProof.leafCount = 4; },
    (p) => { p.merkleProof.siblings[0] = fixtureHash(99); },
    (p) => { p.merkleProof.siblings.pop(); },
    (p) => { p.merkleProof.siblings.push(fixtureHash(99)); },
    (p) => { p.merkleProof = copy(other.merkleProof); },
    (p) => { p.validatorEpoch = "1"; },
    (p) => { p.committeeDigest = fixtureHash(99); },
    (p) => { p.quorumCertificate.validatorEpoch = "1"; p.validatorEpoch = "1"; },
    (p) => { p.quorumCertificate.batchId = fixtureHash(99); },
    (p) => { p.quorumCertificate.messageRoot = fixtureHash(99); },
    (p) => { p.quorumCertificate.commits[0].signature = `0x${"ff".repeat(65)}`; },
    (p) => { p.deliveryJobId += ":extra"; },
    (p) => { p.message.payload = undefined; },
    (p) => { p.message.nonce = Number.MAX_SAFE_INTEGER + 1; },
  ];
  for (const mutate of mutations) { const value = copy(pack); mutate(value); await assert.rejects(verifyDeliveryPackage(value,options)); }
  const nonMember = copy(pack);
  nonMember.message.nonce = "999";
  nonMember.message.payloadHash = computePayloadHash(nonMember.message.payload);
  nonMember.message.messageId = computeCanonicalMessageId(nonMember.message);
  await assert.rejects(verifyDeliveryPackage(nonMember,options));
  await assert.rejects(verifyDeliveryPackage(pack,{ ...options,sourceDomain: "999" }), { code: "WRONG_DELIVERY_SOURCE" });
  await assert.rejects(verifyDeliveryPackage(pack,{ ...options,sourceGateway: "0x0000000000000000000000000000000000009999" }), { code: "WRONG_DELIVERY_SOURCE" });
  await assert.rejects(verifyDeliveryPackage(pack,{}), { code: "VALIDATOR_HISTORY_REQUIRED" });
});

test("single-leaf packages and historical QC evidence remain independently verifiable", async () => {
  const initial = deliveryValidatorSets.history[0];
  const history = createValidatorSetResolver([{ ...initial,validatorEpoch: "7" },
    { ...initial,validatorEpoch: "8",activationBatchEpoch: "24" }]);
  for (const epoch of [23n,24n]) {
    const snapshot = await deliveryFixture({ count: 1,epoch,validatorSets: history });
    const [pack] = await buildDeliveryPackages(snapshot,{ validatorSets: history });
    assert.equal(pack.validatorEpoch,epoch === 23n ? "7" : "8");
    assert.deepEqual(pack.merkleProof.siblings,[]);
    assert.deepEqual(await verifyDeliveryPackage(copy(pack),{ validatorSets: history }),pack);
  }
  for (const protocolVersion of ["1","2"]) {
    const snapshot = await deliveryFixture({ protocolVersion });
    const [pack] = await buildDeliveryPackages(snapshot,options);
    assert.equal(pack.validatorEpoch,null);
    assert.deepEqual(pack.quorumCertificate,snapshot.quorumCertificate);
    assert.deepEqual(await verifyDeliveryPackage(copy(pack),options),pack);
    await assert.rejects(verifyDeliveryPackage({ ...pack,validatorEpoch: "0" },options), { code: "UNSIGNED_VALIDATOR_EPOCH" });
  }
});

test("listing limits are exact, positive and bounded", () => {
  assert.equal(deliveryLimit(),100);
  assert.equal(deliveryLimit(1000),1000);
  for (const limit of [0,-1,1.5,"3",1001,NaN,Infinity,Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => deliveryLimit(limit), { code: "INVALID_DELIVERY_LIMIT" });
});
