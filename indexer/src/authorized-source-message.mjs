import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeAddress,normalizePayload } from "./canonical-message.mjs";
import { ACTION_FORWARD_MESSAGE,FORWARD_MESSAGE_VERSION,computeForwardIntentDigest } from "./forward-authorization.mjs";
import { generateCredentialProof } from "../../zk/scripts/forward-proof.mjs";

export async function loadIdentityApplicationAbi() {
  return JSON.parse(await readFile(new URL("../../contracts/out/IdentityApplicationA.sol/IdentityApplicationA.json",import.meta.url),"utf8")).abi;
}

// Pin the policy and the exact intent to one source block. Both the interactive
// prover and the existing security regressions use this canonical preparation.
export async function prepareAuthorizedSourceMessage({ publicClient,application,destinationDomain,destinationGateway,destinationReceiver,payload,deadline,executor,
  fixtureName,stateName,proofTimestamp,authorizationValidUntil,credential,state,artifacts,temporaryParent,privateInput,signal }) {
  const abi = await loadIdentityApplicationAbi();
  const block = await publicClient.getBlock();
  const read = functionName => publicClient.readContract({ address: application,abi,functionName,blockNumber: block.number });
  const [sourceGateway,applicationDomain,policyEpoch,credentialStateRoot,trustedIssuer,requiredRole,version,action] = await Promise.all([
    read("sourceGateway"),read("applicationDomain"),read("currentPolicyEpoch"),read("credentialStateRoot"),
    read("trustedIssuer"),read("requiredRole"),read("FORWARD_MESSAGE_VERSION"),read("ACTION_FORWARD_MESSAGE"),
  ]);
  assert.equal(BigInt(version),FORWARD_MESSAGE_VERSION); assert.equal(action,ACTION_FORWARD_MESSAGE);
  const request = { destinationDomain: BigInt(destinationDomain),destinationGateway: normalizeAddress(destinationGateway),
    destinationReceiver: normalizeAddress(destinationReceiver),payload: normalizePayload(payload),deadline: BigInt(deadline) };
  const intent = { protocolVersion: FORWARD_MESSAGE_VERSION,action,sourceDomain: BigInt(await publicClient.request({ method: "eth_chainId" })),
    application: normalizeAddress(application),sourceGateway: normalizeAddress(sourceGateway),...request,authorizedExecutor: normalizeAddress(executor) };
  const digest = computeForwardIntentDigest(intent);
  assert.equal(await publicClient.readContract({ address: application,abi,functionName: "forwardIntentDigest",args: [request,executor],blockNumber: block.number }),digest);
  const prepared = await generateCredentialProof({ intent,applicationDomain,policyEpoch,credentialStateRoot,trustedIssuer,requiredRole,
    currentTimestamp: proofTimestamp ?? block.timestamp,authorizationValidUntil,fixtureName,stateName,credential,state,artifacts,temporaryParent,privateInput,signal });
  return { ...prepared,intent,abi,request,args: [prepared.proofA.map(BigInt),prepared.proofB.map(row => row.map(BigInt)),prepared.proofC.map(BigInt),
    Object.fromEntries(Object.entries(prepared.publicInputs).map(([name,value]) => [name,BigInt(value)])),request] };
}
