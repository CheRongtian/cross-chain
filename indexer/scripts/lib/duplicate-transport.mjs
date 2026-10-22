import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { encodeGatewaySubmission } from "../../src/relayer/encoding.mjs";
import { signDeliveryTransaction } from "../../src/transaction-manager/transaction.mjs";

// Deliberately duplicate public transport, without a canonical intent/account
// write. Prepare while the original is unconsumed, then send after it confirms.
export async function prepareDuplicateTransport({ config,queue,manager,rpc,id }) {
  const pack = await queue.getDeliveryPackage(id);
  const encoded = await encodeGatewaySubmission(pack,{ validatorSets: config.validatorSets,
    sourceDomain: config.chainDomain,sourceGateway: config.sourceGateway });
  const canonical = await manager.resolveIntent(id);
  assert.equal(canonical.calldata,encoded.calldata); assert.equal(canonical.packageDigest,encoded.packageDigest);
  assert.equal(await rpc.verifyChain(),config.destinationDomain);
  const gasLimit = await rpc.estimateGas(canonical);
  const fees = await rpc.fees();
  assert.ok(fees.maxFeePerGas <= config.maxFeePerGasCap && fees.maxPriorityFeePerGas <= config.maxPriorityFeePerGasCap);
  const nonce = await rpc.pendingNonce();
  const intent = { ...canonical,nonce: nonce.toString() };
  const attempt = await signDeliveryTransaction(intent,{ nonce,gasLimit,...fees },privateKeyToAccount(config.privateKey));
  return { intent,attempt,package: encoded.package };
}
