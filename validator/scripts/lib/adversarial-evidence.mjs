import assert from "node:assert/strict";
import { recoverMessageAddress } from "viem";
import { validatorAccount } from "../../src/identity.mjs";

// Shared by fault fixtures and the explicitly owned local validator wrapper.
// This intentionally bypasses the normal cast policy to model a Byzantine
// signer, while retaining the real protocol digest and actual identity key.
export async function signAdversarialEvidence(privateKey,identity,fields,digestFunction) {
  const digest = digestFunction(fields);
  const signature = await validatorAccount(privateKey).signMessage({ message: { raw: digest } });
  assert.equal((await recoverMessageAddress({ message: { raw: digest },signature })).toLowerCase(),identity);
  return { ...fields,signature,
    [fields.messageType === "PRE_PREPARE" ? "proposalDigest" : fields.messageType === "PREPARE" ? "prepareDigest" : "commitDigest"]: digest };
}
