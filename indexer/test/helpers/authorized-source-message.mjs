import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { computeForwardIntentDigest,splitForwardIntentDigest } from "../../src/forward-authorization.mjs";
import { generateCredentialProof } from "../../../zk/scripts/forward-proof.mjs";
import { parseAbi } from "viem";
export { loadIdentityApplicationAbi,prepareAuthorizedSourceMessage } from "../../src/authorized-source-message.mjs";

function revertedAs(error,name) {
  const reverted = error?.walk?.(cause => cause.name === "ContractFunctionRevertedError");
  return reverted?.name === "ContractFunctionRevertedError" && (name === undefined || reverted.data?.errorName === name);
}

export async function expectForwardRejection(publicClient,application,prepared,args,caller,reason) {
  await assert.rejects(publicClient.simulateContract({ address: application,abi: prepared.abi,
    functionName: "forwardAuthorizedMessage",args,account: caller }),error => revertedAs(error,reason));
}

// One real proof serves all mutations; one additional fresh verify-only proof
// exercises action separation. No mutation gets a new setup ceremony.
export async function verifyForwardAuthorizationNegatives({ publicClient,walletClient,application,prepared,executor }) {
  const gatewayArtifact = JSON.parse(await readFile(new URL("../../../contracts/out/SourceGateway.sol/SourceGateway.json",import.meta.url),"utf8"));
  const applicationArtifact = JSON.parse(await readFile(new URL("../../../contracts/out/IdentityApplicationA.sol/IdentityApplicationA.json",import.meta.url),"utf8"));
  const gateway = prepared.intent.sourceGateway;
  const read = name => publicClient.readContract({ address: application,abi: prepared.abi,functionName: name });
  const nonceBefore = await publicClient.readContract({ address: gateway,abi: gatewayArtifact.abi,functionName: "nextNonce" });
  const inputs = prepared.args[3];
  const now = (await publicClient.getBlock()).timestamp;
  const maxAge = await read("maxProofAge");
  const variants = [
    ["payload",args => { args[4].payload = "0x01"; },"InvalidForwardIntent"],
    ["destination domain",args => { args[4].destinationDomain += 1n; },"InvalidForwardIntent"],
    ["destination gateway",args => { args[4].destinationGateway = "0x0000000000000000000000000000000000000123"; },"InvalidForwardIntent"],
    ["receiver",args => { args[4].destinationReceiver = "0x0000000000000000000000000000000000000123"; },"InvalidForwardIntent"],
    ["deadline",args => { args[4].deadline += 1n; },"InvalidForwardIntent"],
    ["action",args => { args[3].actionContext = 1n; },"InvalidActionContext"],
    ["high limb",args => { args[3].forwardIntentDigestHi += 1n; },"InvalidForwardIntent"],
    ["low limb",args => { args[3].forwardIntentDigestLo += 1n; },"InvalidForwardIntent"],
    ["swapped limbs",args => { [args[3].forwardIntentDigestHi,args[3].forwardIntentDigestLo] = [args[3].forwardIntentDigestLo,args[3].forwardIntentDigestHi]; },"InvalidForwardIntent"],
    ["issuer",args => { args[3].trustedIssuer += 1n; },"InvalidIssuerPolicy"],
    ["role",args => { args[3].requiredRole = 2n; },"InvalidRolePolicy"],
    ["root",args => { args[3].credentialStateRoot += 1n; },"InvalidCredentialStateRoot"],
    ["epoch",args => { args[3].policyEpoch += 1n; },"InvalidPolicyEpoch"],
    ["future timestamp",args => { args[3].currentTimestamp = now + 3600n; },"FutureProofTimestamp"],
    ["stale timestamp",args => { args[3].currentTimestamp = now - maxAge - 1n; },"StaleProofTimestamp"],
    ["authorization deadline reached",args => { args[3].authorizationValidUntil = now; },"AuthorizationExpired"],
    ["authorization deadline binding",args => { args[3].authorizationValidUntil += 1n; },"InvalidCredentialProof"],
  ];
  assert.notEqual(inputs.forwardIntentDigestHi,inputs.forwardIntentDigestLo,"swap fixture must have distinct limbs");
  for (const [label,mutate,reason] of variants) {
    const args = [...prepared.args]; args[3] = { ...inputs }; args[4] = { ...prepared.request }; mutate(args);
    await expectForwardRejection(publicClient,application,prepared,args,executor,reason);
    console.log("VALID: unchanged forwarding proof rejected altered " + label + " (" + reason + ")");
  }
  for (const field of ["application","sourceGateway"]) {
    const digest = computeForwardIntentDigest({ ...prepared.intent,[field]: "0x0000000000000000000000000000000000000123" });
    const args = [...prepared.args]; args[3] = { ...inputs,...splitForwardIntentDigest(digest) };
    await expectForwardRejection(publicClient,application,prepared,args,executor,"InvalidForwardIntent");
    console.log("VALID: unchanged proof rejected alternate " + field + " intent context");
  }
  await expectForwardRejection(publicClient,application,prepared,prepared.args,
    "0x0000000000000000000000000000000000000123","InvalidForwardIntent");
  const standalone = await generateCredentialProof(inputs);
  const standaloneInputs = Object.fromEntries(Object.entries(standalone.publicInputs).map(([name,value]) => [name,BigInt(value)]));
  const standaloneArgs = [standalone.proofA.map(BigInt),standalone.proofB.map(row => row.map(BigInt)),standalone.proofC.map(BigInt),standaloneInputs,prepared.request];
  await expectForwardRejection(publicClient,application,prepared,standaloneArgs,executor,"InvalidActionContext");
  await assert.rejects(publicClient.simulateContract({ address: application,abi: prepared.abi,functionName: "verifySupplier",
    args: prepared.args.slice(0,4),account: executor }),error => revertedAs(error,"InvalidActionContext"));
  console.log("VALID: executor theft and genuine fresh verify-only proof rejected; action separation works in both directions");
  const legacyAbi = parseAbi(["function sendCrossChainMessage(uint256,address,address,bytes,uint256) returns (bytes32,uint256)"]);
  await assert.rejects(publicClient.simulateContract({ address: application,abi: legacyAbi,functionName: "sendCrossChainMessage",
    args: [prepared.request.destinationDomain,prepared.request.destinationGateway,prepared.request.destinationReceiver,
      prepared.request.payload,prepared.request.deadline],account: executor }),error => revertedAs(error));
  const deploy = async (artifact,args) => {
    const hash = await walletClient.deployContract({ abi: artifact.abi,bytecode: artifact.bytecode.object,args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status,"success"); assert.ok(receipt.contractAddress); return receipt.contractAddress;
  };
  const otherGateway = await deploy(gatewayArtifact,[executor]);
  const otherApplication = await deploy(applicationArtifact,[await read("credentialVerifier"),otherGateway,inputs.trustedIssuer,
    inputs.requiredRole,maxAge,await read("credentialStateAuthority"),inputs.credentialStateRoot]);
  await expectForwardRejection(publicClient,otherApplication,prepared,prepared.args,executor,"InvalidApplicationDomain");
  assert.equal(await publicClient.readContract({ address: gateway,abi: gatewayArtifact.abi,functionName: "nextNonce" }),nonceBefore);
  assert.equal(await publicClient.readContract({ address: application,abi: prepared.abi,functionName: "usedNullifiers",args: [inputs.nullifier] }),false);
  console.log("VALID: real alternate application/source-Gateway reuse and legacy no-proof selector rejected; no original nonce/nullifier consumed");
}
