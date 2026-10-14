import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { createMerkleInclusionChecks, goldenInclusion } from "../test/helpers/merkle-inclusion-contract.mjs";

const { CHAIN_B_RPC_URL: rpcUrl, MERKLE_INCLUSION_VERIFIER_ADDRESS: address } = process.env;
assert.ok(rpcUrl && address, "Chain B RPC and Merkle inclusion verifier are required");
const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 10000 }) });
assert.equal(await client.getChainId(), 2001);
const checks = await createMerkleInclusionChecks({ client, address });
const fixture = JSON.parse(readFileSync(new URL("../../test-vectors/merkle-golden-vectors.json", import.meta.url), "utf8"));
assert.deepEqual(fixture.vectors.map((vector) => vector.leafCount), [1, 2, 3, 4, 5]);
for (const vector of fixture.vectors) {
  const inputs = vector.batch.messageIds.map((_id, index) => goldenInclusion(vector, index));
  assert.equal(await checks.readPrimitive("computeBatchId", [Number(vector.batch.version),
    BigInt(vector.batch.sourceDomain), vector.batch.sourceGateway, BigInt(vector.batch.epoch), vector.batch.messageIds]), vector.batch.batchId);
  for (let index = 0; index < vector.leafCount; index += 1) {
    assert.equal(await checks.readPrimitive("computeLeaf", [vector.batch.batchId, BigInt(index), vector.batch.messageIds[index]]), vector.leaves[index]);
  }
  for (let level = 0; level < vector.levels.length - 1; level += 1) {
    const children = vector.levels[level];
    for (let index = 0; index < children.length; index += 2) {
      assert.equal(await checks.readPrimitive("hashNode", [children[index], children[index + 1] ?? children[index]]), vector.levels[level + 1][index / 2]);
    }
  }
  await checks.members(inputs, `frozen ${vector.name}`);
  await checks.negatives(inputs, `frozen ${vector.name}`);
}
const probe = fixture.encodingProbe;
assert.equal(await checks.readPrimitive("computeLeaf", [probe.batchId, BigInt(probe.index), probe.messageId]), probe.expectedLeaf);
assert.notEqual(probe.expectedLeaf, probe.sha3LeafHash);
console.log("VALID: Chain B canonical batch, leaf and ordered node encoding match frozen golden vectors, including uint256 probe");
console.log("VALID: every fixed membership proof and precise-error negative verified without rewriting frozen evidence or consuming messages");
