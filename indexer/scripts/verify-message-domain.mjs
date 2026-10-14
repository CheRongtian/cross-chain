import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { computeCanonicalMessageId } from "../src/canonical-message.mjs";
import { createMessageDomainChecks } from "../test/helpers/message-domain-contract.mjs";

const { CHAIN_B_RPC_URL: rpcUrl, MESSAGE_DOMAIN_VERIFIER_ADDRESS: address,
  REMOTE_GATEWAY_REGISTRY_ADDRESS: registryAddress, LOCAL_DESTINATION_DOMAIN: localDomain } = process.env;
assert.ok(rpcUrl && address && registryAddress && localDomain, "Chain B message verifier, registry and explicit domain are required");
const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 10000 }) });
assert.equal(await client.getChainId(), 2001);
const checks = await createMessageDomainChecks({ client, address, registryAddress, destinationDomain: localDomain });
// Consume the existing independently encoded fixture, produced by the existing unified flow.
const vectors = JSON.parse(readFileSync(new URL("../../zk/build/canonical-message-vector.json", import.meta.url), "utf8"));
assert.equal(vectors.vectors.length, 5);
for (const vector of vectors.vectors) {
  assert.equal(computeCanonicalMessageId(vector), vector.expectedMessageId);
  await checks.encoding(vector, vector.expectedMessageId, `existing source/off-chain canonical vector ${vector.name}`);
}
console.log("VALID: destination encoding preserves every existing canonical source/domain/gateway vector without new fixture generation");
