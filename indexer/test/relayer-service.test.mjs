import assert from "node:assert/strict";
import test from "node:test";
import { buildDeliveryPackages, deliveryJson } from "../src/delivery/package.mjs";
import { createSingleRelayer } from "../src/relayer/service.mjs";
import { deliveryFixture, fixtureHash } from "./helpers/delivery-fixtures.mjs";
import { relayerConfig } from "./helpers/relayer-fixtures.mjs";

const clone = (value) => JSON.parse(deliveryJson(value));
async function harness({ config = relayerConfig(),packMutation,jobMutation,sendFailure,hash,actualDomain,
  persistFailure } = {}) {
  const original = await buildDeliveryPackages(await deliveryFixture(),{ validatorSets: config.validatorSets });
  const packets = original.map(clone);
  if (packMutation) packMutation(packets[0]);
  const jobs = packets.map((pack) => ({ deliveryJobId: pack.deliveryJobId,status: "READY",
    destinationDomain: pack.message.destinationDomain,destinationGateway: pack.message.destinationGateway }));
  if (jobMutation) jobMutation(jobs[0]);
  const records = new Map(); const calls = []; let chainChecks = 0;
  const queue = { async getDeliveryJob(id) { return jobs.find((job) => job.deliveryJobId === id); },
    async getDeliveryPackage(id) { return packets.find((pack) => pack.deliveryJobId === id); } };
  const repository = { async withSingleton(operation) { return operation(() => {}); },
    async listEligibleJobs({ limit }) { return jobs.filter((job) => !records.has(job.deliveryJobId)).slice(0,limit); },
    async getSubmission(id) { return records.get(id) ?? null; },
    async recordSubmission({ deliveryJobId,encoded,transactionHash }) {
      if (persistFailure) throw persistFailure;
      const value = { deliveryJobId,packageDigest: encoded.packageDigest,transactionHash,relayerAddress: config.relayerAddress,
        destinationDomain: encoded.package.message.destinationDomain,destinationGateway: encoded.package.message.destinationGateway };
      records.set(deliveryJobId,value); return value;
    } };
  const submitter = { async verifyChain() { chainChecks++; return actualDomain ?? config.destinationDomain; },
    async submit(args) { calls.push(args); if (sendFailure) throw sendFailure; return hash ?? fixtureHash(1000 + calls.length); } };
  return { service: createSingleRelayer({ config,queue,repository,submitter }),config,original,packets,jobs,records,calls,repository,
    chainChecks: () => chainChecks };
}

test("single relayer verifies, sends zero value to canonical gateway, and skips durable ordinary reruns", async () => {
  const h = await harness({ config: relayerConfig({ RELAYER_MAX_JOBS_PER_RUN: "2" }) });
  const first = await h.service.runOnce();
  assert.equal(first.selected,2); assert.equal(first.submitted,2); assert.equal(h.calls.length,2);
  for (const [index,call] of h.calls.entries()) {
    assert.equal(call.to,h.original[index].message.destinationGateway);
    assert.notEqual(call.to,h.original[index].message.destinationReceiver);
    assert.equal(call.value,0n); assert.match(call.data,/^0x[0-9a-f]+$/);
    assert.equal(first.results[index].transactionHash,fixtureHash(1001 + index));
    assert.ok(!JSON.stringify(first).includes(h.config.privateKey));
  }
  const second = await h.service.runOnce();
  assert.equal(second.selected,1); assert.equal(second.submitted,1); assert.equal(h.calls.length,3);
  const empty = await h.service.runOnce();
  assert.equal(empty.selected,0); assert.equal(empty.submitted,0);
  const repeated = await h.service.submitJob(h.jobs[0].deliveryJobId);
  assert.equal(repeated.submitted,false); assert.equal(h.calls.length,3);
  h.records.get(h.jobs[0].deliveryJobId).packageDigest = fixtureHash(9);
  await assert.rejects(h.service.submitJob(h.jobs[0].deliveryJobId),{ code: "CONFLICTING_RELAY_SUBMISSION" });
  assert.equal(h.calls.length,3);
});

test("corrupted message, batch, proof, root, QC, epoch and destination result in zero sends", async () => {
  const mutations = [
    (p) => { p.message.payload = "0xffff"; },(p) => { p.message.messageId = fixtureHash(9); },
    (p) => { p.batchId = fixtureHash(9); },(p) => { p.messageRoot = fixtureHash(9); },
    (p) => { p.merkleProof.siblings[0] = fixtureHash(9); },
    (p) => { p.quorumCertificate.commits[0].signature = `0x${"ff".repeat(65)}`; },
    (p) => { p.validatorEpoch = "99"; },(p) => { p.committeeDigest = fixtureHash(9); },
    (p) => { p.message.destinationDomain = "3001"; },
    (p) => { p.message.destinationGateway = "0x0000000000000000000000000000000000009999"; },
  ];
  for (const packMutation of mutations) {
    const h = await harness({ packMutation });
    await assert.rejects(h.service.runOnce()); assert.equal(h.calls.length,0); assert.equal(h.records.size,0);
  }
  const metadata = await harness({ jobMutation: (j) => { j.destinationGateway = "0x0000000000000000000000000000000000009999"; } });
  await assert.rejects(metadata.service.runOnce(),{ code: "DESTINATION_CONTEXT_MISMATCH" });
  assert.equal(metadata.calls.length,0);
  const otherNetwork = await harness({ config: relayerConfig({ CHAIN_B_CHAIN_ID: "3001" }) });
  await assert.rejects(otherNetwork.service.runOnce(),{ code: "DESTINATION_CONTEXT_MISMATCH" });
  assert.equal(otherNetwork.calls.length,0);
  const wrongChain = await harness({ actualDomain: 10011n });
  await assert.rejects(wrongChain.service.runOnce(),{ code: "CHAIN_ID_MISMATCH" });
  assert.equal(wrongChain.calls.length,0); assert.equal(wrongChain.records.size,0);
});

test("RPC failure, malformed returned hash and persistence ambiguity are surfaced without automatic retry", async () => {
  for (const args of [{ sendFailure: new Error("injected RPC unavailable") },{ hash: "not-a-transaction-hash" },
    { persistFailure: new Error("injected persistence failure after returned hash") }]) {
    const h = await harness(args);
    await assert.rejects(h.service.runOnce());
    assert.equal(h.calls.length,1); assert.equal(h.records.size,0);
    assert.deepEqual(h.packets,h.original);
  }
  const config = relayerConfig();
  const h = await harness({ config,sendFailure: new Error(`private config ${config.privateKey} ${config.databaseUrl} ${config.destinationRpcUrl}`) });
  await assert.rejects(h.service.runOnce(),(error) => !error.message.includes(config.privateKey) &&
    !error.message.includes(config.databaseUrl) && !error.message.includes(config.destinationRpcUrl));
});
