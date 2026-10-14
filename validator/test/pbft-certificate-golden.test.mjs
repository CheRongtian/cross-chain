import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeAbiParameters, encodeAbiParameters, hashMessage, parseAbiParameters, recoverMessageAddress } from "viem";
import { verifyQuorumCertificate, qcDigest } from "../src/quorum-certificate.mjs";
import { commitDigest } from "../src/commit.mjs";
import { prePrepareDigest } from "../src/pre-prepare.mjs";
import { createValidatorSetResolver } from "../src/validator-sets.mjs";
import { buildDeliveryPackages } from "../../indexer/src/delivery/package.mjs";
import { encodeDestinationSubmission, ENVELOPE_PARAMETERS } from "../../indexer/src/relayer/encoding.mjs";
import { deliveryFixture } from "../../indexer/test/helpers/delivery-fixtures.mjs";
import { consensusContext, encodeCertificate, solidityContext } from "./helpers/pbft-certificate.mjs";

const vectors = JSON.parse(readFileSync(new URL("../../test-vectors/pbft-certificates.json", import.meta.url), "utf8"));
const validatorSets = createValidatorSetResolver(vectors.history);
const peers = vectors.history[0].validators;

test("Solidity viewNumber mapping preserves the original context ABI slot and full-width protocol view", () => {
  // The ABI text parser also reserves "view"; compare against the original positional types.
  const originalAbi = parseAbiParameters("(uint8,uint256,address,uint256,uint256,bytes32,bytes32,uint256)");
  const solidityAbi = parseAbiParameters("(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 batchEpoch,uint256 viewNumber,bytes32 batchId,bytes32 messageRoot,uint256 authorityEpoch)");
  for (const entry of vectors.cases) {
    const expected = structuredClone(entry.expected);
    const context = solidityContext(expected);
    assert.equal(context.viewNumber, BigInt(expected.view));
    assert.equal(Object.hasOwn(context, "view"), false);
    const encoded = encodeAbiParameters(solidityAbi, [context]);
    const original = [context.protocolVersion, context.sourceDomain, context.sourceGateway, context.batchEpoch,
      BigInt(expected.view), context.batchId, context.messageRoot, context.authorityEpoch];
    assert.equal(encoded, encodeAbiParameters(originalAbi, [original]));
    assert.equal(decodeAbiParameters(originalAbi, encoded)[0][4], BigInt(expected.view));
    assert.deepEqual(expected, entry.expected, "Contract mapping must not rewrite the frozen protocol context");
    assert.equal(consensusContext(expected).view, expected.view);
  }
});

for (const entry of vectors.cases) {
  test(`frozen certificate parity: ${entry.name}`, async () => {
    assert.equal(encodeCertificate(entry.certificate), entry.encoded);
    const expected = consensusContext(entry.expected);
    const verify = () => verifyQuorumCertificate(entry.certificate, { peers, validatorSets, expected });
    // JS verification does not consume caller legacy authority metadata; Solidity does.
    if (entry.name === "legacy-wrong-authority") { await verify(); return; }
    if (!entry.valid) { await assert.rejects(verify); return; }
    const q = await verify();
    assert.deepEqual(q, entry.certificate);
    assert.equal(qcDigest(q), q.qcDigest);
    assert.equal(prePrepareDigest({ messageType: "PRE_PREPARE", ...expected, primaryIdentity: entry.primary,
      ...(q.protocolVersion === "3" ? { committeeDigest: q.committeeDigest } : {}) }), q.proposalDigest);
    for (const [index, vote] of q.commits.entries()) {
      assert.equal(commitDigest(vote), vote.commitDigest);
      assert.equal(hashMessage({ raw: vote.commitDigest }), entry.signingDigests[index]);
      const recovered = await recoverMessageAddress({ message: { raw: vote.commitDigest }, signature: vote.signature });
      assert.equal(recovered.toLowerCase(), entry.recovered[index]);
      assert.equal(recovered.toLowerCase(), vote.voterIdentity);
    }
  });
}

test("frozen legacy/current bytes equal the QC embedded by the actual relayer transport", async () => {
  for (const protocolVersion of ["1", "2", "3"]) {
    const fixture = await deliveryFixture({ protocolVersion, validatorSets, epoch: 23n });
    // The generator uses the canonical first three members; retain exactly those frozen votes.
    const frozen = vectors.cases.find((entry) => entry.name === `v${protocolVersion}-quorum-3`);
    fixture.quorumCertificate = structuredClone(frozen.certificate);
    const [pack] = await buildDeliveryPackages(fixture, { validatorSets });
    const transport = await encodeDestinationSubmission(pack, { validatorSets });
    assert.equal(decodeAbiParameters(ENVELOPE_PARAMETERS, transport.data)[9], frozen.encoded);
    assert.deepEqual(pack.quorumCertificate, frozen.certificate);
  }
});

test("production recovery rejects signature length, scalar and recovery-ID boundaries", async () => {
  const entry = vectors.cases.find((item) => item.name === "v3-quorum-3");
  const signature = entry.certificate.commits[0].signature;
  const zero = "00".repeat(32);
  const order = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
  const generatorX = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const infinityS = (BigInt(entry.signingDigests[0]) % BigInt(`0x${order}`)).toString(16).padStart(64, "0");
  const signatures = ["0x", signature.slice(0, -2), `${signature}00`,
    `0x${generatorX}${infinityS}1b`,
    `0x${zero}${signature.slice(66)}`, `0x${order}${signature.slice(66)}`,
    `${signature.slice(0, 66)}${zero}${signature.slice(130)}`,
    `${signature.slice(0, 66)}${order}${signature.slice(130)}`,
    ...[2, 3, 26, 29, 35, 255].map((v) => `${signature.slice(0, -2)}${v.toString(16).padStart(2, "0")}`)];
  for (const changed of signatures) {
    const q = structuredClone(entry.certificate);
    q.commits[0].signature = changed;
    await assert.rejects(() => verifyQuorumCertificate(q, {
      peers, validatorSets, expected: consensusContext(entry.expected),
    }));
  }
});
