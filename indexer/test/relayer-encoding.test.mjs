import assert from "node:assert/strict";
import test from "node:test";
import { decodeAbiParameters, keccak256 } from "viem";
import { buildDeliveryPackages, deliveryJson } from "../src/delivery/package.mjs";
import { encodeDestinationSubmission, ENVELOPE_PARAMETERS, MESSAGE_PARAMETERS, BATCH_PARAMETERS,
  QC_PARAMETERS, QC_STATEMENT_PARAMETERS, DESTINATION_SUBMISSION_DOMAIN, DESTINATION_SUBMISSION_VERSION } from "../src/relayer/encoding.mjs";
import { createValidatorSetResolver } from "../../validator/src/validator-sets.mjs";
import { deliveryFixture, deliveryValidatorSets } from "./helpers/delivery-fixtures.mjs";

const options = { validatorSets: deliveryValidatorSets };
function reorder(input) {
  if (Array.isArray(input)) return input.map(reorder);
  if (input && typeof input === "object") return Object.fromEntries(Object.keys(input).reverse().map((key) => [key,reorder(input[key])]));
  return input;
}

test("ABI transport is versioned, byte deterministic and independent of JSON property ordering", async () => {
  const fixture = await deliveryFixture({ epoch: (1n << 200n) + 1n });
  const [pack] = await buildDeliveryPackages(fixture,options);
  const a = await encodeDestinationSubmission(pack,options);
  const b = await encodeDestinationSubmission(reorder(JSON.parse(deliveryJson(pack))),options);
  assert.equal(a.data,b.data); assert.equal(a.packageDigest,b.packageDigest);
  assert.equal(a.packageDigest,keccak256(a.data));
  const [domain,version,id,messageBytes,batchBytes,index,count,root,siblings,qcBytes] = decodeAbiParameters(ENVELOPE_PARAMETERS,a.data);
  assert.equal(domain,DESTINATION_SUBMISSION_DOMAIN); assert.equal(version,DESTINATION_SUBMISSION_VERSION);
  assert.equal(id,pack.deliveryJobId); assert.equal(index,0n); assert.equal(count,3n); assert.equal(root,pack.messageRoot);
  assert.deepEqual(siblings,pack.merkleProof.siblings);
  const message = decodeAbiParameters(MESSAGE_PARAMETERS,messageBytes);
  assert.equal(message[4],2001n); assert.equal(message[5].toLowerCase(),pack.message.destinationGateway);
  assert.equal(message[8],pack.message.payload); assert.equal(message[10],BigInt(pack.message.deadline));
  assert.equal(message[11],pack.message.messageId);
  const batch = decodeAbiParameters(BATCH_PARAMETERS,batchBytes);
  assert.equal(batch[1],fixture.record.epoch); assert.equal(batch[2],pack.batchId); assert.deepEqual(batch[3],pack.batchMessageIds);
  const qc = decodeAbiParameters(QC_PARAMETERS,qcBytes);
  assert.equal(qc[0],3); assert.equal(qc[2],pack.quorumCertificate.qcDigest);
  assert.equal(qc[3].length,3);
  for (const [position,vote] of qc[3].entries()) {
    assert.equal(vote.voterIdentity.toLowerCase(),pack.quorumCertificate.commits[position].voterIdentity);
    assert.equal(vote.commitDigest,pack.quorumCertificate.commits[position].commitDigest);
    assert.equal(vote.signature,pack.quorumCertificate.commits[position].signature);
  }
});

test("valid changed messages, destinations, batch context and historical epochs change transport bytes", async () => {
  const first = (await buildDeliveryPackages(await deliveryFixture(),options))[0];
  const a = await encodeDestinationSubmission(first,options);
  for (const fixture of [await deliveryFixture({ multiDestination: true }),await deliveryFixture({ epoch: 24n })]) {
    const packs = await buildDeliveryPackages(fixture,options);
    const other = await encodeDestinationSubmission(packs[1],options);
    assert.notEqual(other.data,a.data); assert.notEqual(other.packageDigest,a.packageDigest);
  }
  const initial = deliveryValidatorSets.history[0];
  const history = createValidatorSetResolver([{ ...initial,validatorEpoch: "7" },{ ...initial,validatorEpoch: "8",activationBatchEpoch: "24" }]);
  const old = (await buildDeliveryPackages(await deliveryFixture({ epoch: 23n,validatorSets: history }),{ validatorSets: history }))[0];
  const next = (await buildDeliveryPackages(await deliveryFixture({ epoch: 24n,validatorSets: history }),{ validatorSets: history }))[0];
  const oldBytes = await encodeDestinationSubmission(old,{ validatorSets: history });
  const newBytes = await encodeDestinationSubmission(next,{ validatorSets: history });
  assert.notEqual(oldBytes.data,newBytes.data);
  const oldQc = decodeAbiParameters(QC_PARAMETERS,decodeAbiParameters(ENVELOPE_PARAMETERS,oldBytes.data)[9]);
  const newQc = decodeAbiParameters(QC_PARAMETERS,decodeAbiParameters(ENVELOPE_PARAMETERS,newBytes.data)[9]);
  assert.equal(decodeAbiParameters(QC_STATEMENT_PARAMETERS["3"],oldQc[1]).at(-1),7n);
  assert.equal(decodeAbiParameters(QC_STATEMENT_PARAMETERS["3"],newQc[1]).at(-1),8n);
});

test("transport preserves each legacy QC format without inventing signed view or epoch fields", async () => {
  for (const protocolVersion of ["1","2","3"]) {
    const [pack] = await buildDeliveryPackages(await deliveryFixture({ protocolVersion }),options);
    const encoded = await encodeDestinationSubmission(pack,options);
    const qc = decodeAbiParameters(QC_PARAMETERS,decodeAbiParameters(ENVELOPE_PARAMETERS,encoded.data)[9]);
    assert.equal(qc[0],Number(protocolVersion));
    assert.equal(qc[2],pack.quorumCertificate.qcDigest);
    assert.equal(decodeAbiParameters(QC_STATEMENT_PARAMETERS[protocolVersion],qc[1]).length,
      protocolVersion === "1" ? 7 : protocolVersion === "2" ? 8 : 9);
    for (const [index,vote] of qc[3].entries()) assert.equal(vote.signature,pack.quorumCertificate.commits[index].signature);
  }
});
