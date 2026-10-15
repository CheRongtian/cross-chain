import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { decodeFunctionData, encodeAbiParameters, parseAbiParameters } from "viem";
import { DELIVERY_POLICY, requireDeliveryBounds } from "../src/delivery/policy.mjs";
import { buildDeliveryPackages } from "../src/delivery/package.mjs";
import { encodeDestinationSubmission, encodeGatewaySubmission, DESTINATION_GATEWAY_ABI } from "../src/relayer/encoding.mjs";
import { deliveryFixture, deliveryValidatorSets } from "./helpers/delivery-fixtures.mjs";
import { createValidatorSetResolver } from "../../validator/src/validator-sets.mjs";

test("committed complete transport/Gateway golden bytes remain identical", async () => {
  const vector = JSON.parse(readFileSync(new URL("../../test-vectors/destination-transport.json", import.meta.url), "utf8"));
  const encoded = await encodeGatewaySubmission(vector.package, { validatorSets: createValidatorSetResolver(vector.validatorHistory) });
  assert.equal(encoded.data, vector.canonicalPackageBytes);
  assert.equal(encoded.calldata, vector.gatewayCalldata);
  assert.equal(encoded.calldata.slice(0, 10), vector.selector);
  assert.equal(encoded.packageDigest, vector.packageDigest);
  assert.equal(encoded.package.message.destinationGateway, vector.expectedTarget);
  assert.equal(vector.expectedValue, "0");
});

test("Gateway wrapper preserves all frozen transport-v1 bytes and the package digest", async () => {
  for (const protocolVersion of ["1", "2", "3"]) {
    const [pack] = await buildDeliveryPackages(await deliveryFixture({ protocolVersion }), { validatorSets: deliveryValidatorSets });
    const original = await encodeDestinationSubmission(pack, { validatorSets: deliveryValidatorSets });
    const production = await encodeGatewaySubmission(pack, { validatorSets: deliveryValidatorSets });
    const call = decodeFunctionData({ abi: DESTINATION_GATEWAY_ABI, data: production.calldata });
    assert.equal(call.functionName, "execute");
    assert.equal(call.args[0], original.data);
    assert.equal(production.packageDigest, original.packageDigest);
    assert.equal(production.data, original.data);
    assert.notEqual(production.calldata, original.data);
  }
});

test("shared practical limit arithmetic follows the exact ABI, not a gas allowance", () => {
  const p = DELIVERY_POLICY;
  // Envelope head; domain; full-width job ID; message bytes; batch bytes; siblings; maximum QC.
  const maximum = 320 + 64 + (32 + p.maxDeliveryJobIdBytes) + (32 + 384 + 32 + p.maxPayloadBytes)
    + (32 + 128 + 32 + 32 * p.maxBatchMessages) + (32 + 32 * p.maxMerkleDepth) + (32 + p.maxCertificateBytes);
  assert.equal(maximum, p.maxPackageBytes);
  assert.equal(p.maxMerkleDepth, Math.ceil(Math.log2(p.maxBatchMessages)));
  assert.equal(encodeAbiParameters(parseAbiParameters("uint8,uint8,address"), [1, 1, "0x1234567890123456789012345678901234567890"]).length, 194);
});

test("payload and batch construction preflight cover below, at and above limits", () => {
  const shape = { message: { payload: "0x" }, batchMessageIds: ["id"], merkleProof: { siblings: [] } };
  for (const size of [DELIVERY_POLICY.maxPayloadBytes - 1, DELIVERY_POLICY.maxPayloadBytes]) {
    requireDeliveryBounds({ ...shape, message: { payload: `0x${"00".repeat(size)}` } });
  }
  assert.throws(() => requireDeliveryBounds({ ...shape, message: { payload: `0x${"00".repeat(DELIVERY_POLICY.maxPayloadBytes + 1)}` } }), /MESSAGE_PAYLOAD_LIMIT_EXCEEDED/);
  for (const count of [DELIVERY_POLICY.maxBatchMessages - 1, DELIVERY_POLICY.maxBatchMessages]) {
    requireDeliveryBounds({ ...shape, batchMessageIds: Array(count).fill("id") });
  }
  assert.throws(() => requireDeliveryBounds({ ...shape, batchMessageIds: Array(DELIVERY_POLICY.maxBatchMessages + 1).fill("id") }), /BATCH_MEMBERSHIP_LIMIT_EXCEEDED/);
});
