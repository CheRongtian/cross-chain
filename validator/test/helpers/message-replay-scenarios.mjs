import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWalletClient, encodeErrorResult, encodeFunctionData, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalizeAddress } from "../../../indexer/src/canonical-message.mjs";
import { canonicalDomainMessage } from "../../../indexer/test/helpers/message-domain-contract.mjs";
import { inclusionArguments, flipMerkleHash, forgedPathRoot } from "../../../indexer/test/helpers/merkle-inclusion-contract.mjs";
import { encodeCertificate, solidityContext } from "./pbft-certificate.mjs";
import { developmentKeys } from "./fixtures.mjs";

// Local test-transaction budget only. This is not a final Gateway gas/package policy.
const TEST_TRANSACTION_GAS = 3_000_000n;
const errorValue = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value;
const artifact = (name) => JSON.parse(readFileSync(new URL(
  `../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));

function acceptance(entry, input) {
  const [batch, root, messageId, index, ids, proof] = inclusionArguments(input);
  const context = solidityContext(entry.context);
  assert.equal(root, context.messageRoot);
  assert.equal(batch.batchId, context.batchId);
  assert.equal(batch.sourceDomain, context.sourceDomain);
  assert.equal(batch.sourceGateway, normalizeAddress(context.sourceGateway));
  assert.equal(batch.epoch, context.batchEpoch);
  const original = entry.snapshot.batch.messages[input.index];
  assert.equal(original.messageId, messageId);
  const [message, payload] = canonicalDomainMessage(original);
  return { certificate: entry.encoded, context, batchVersion: batch.version, index,
    orderedMessageIds: ids, proof, message, payload, messageId };
}

export async function createMessageReplayChecks({ client, rpcUrl, context, domainContext,
  certificateVerifierAddress, merkleInclusionVerifierAddress, certificateChecks, merkleChecks, domainChecks }) {
  const address = normalizeAddress(context.harnessAddress);
  const receiverAddress = normalizeAddress(context.receiverAddress);
  const harness = artifact("AuthenticatedMessageReplayHarness");
  const receiver = artifact("ReplayTestReceiver");
  // Propagated upstream errors are decoded precisely, including library and external registry errors.
  const upstreamErrors = ["PBFTCertificateVerifier", "MerkleInclusionVerifier", "MessageDomainVerifier",
    "RemoteGatewayRegistry", "ValidatorSetRegistry"].flatMap((name) => artifact(name).abi.filter((item) => item.type === "error"));
  const abi = [...harness.abi, ...receiver.abi.filter((item) => item.type === "error"), ...upstreamErrors];
  const read = (functionName, args = []) => client.readContract({ address, abi, functionName, args });
  for (const [getter, expected] of [["CERTIFICATE_VERIFIER", certificateVerifierAddress],
    ["MERKLE_VERIFIER", merkleInclusionVerifierAddress], ["DOMAIN_VERIFIER", domainContext.verifierAddress],
    ["EXPECTED_GATEWAY", domainContext.expectedGateway]]) {
    assert.equal(normalizeAddress(await read(getter)), normalizeAddress(expected), `test replay harness ${getter} binding`);
  }
  // Key six is outside the five-validator directory and distinct from the Tx Manager's exclusive EOA.
  // Anvil-only fixture funding changes no production account nonce and sends no ETH transfer transaction.
  const alternateKey = developmentKeys(6)[5];
  const wallets = [domainContext.registryOperatorKey, alternateKey].map((key) =>
    createWalletClient({ account: privateKeyToAccount(key), transport: http(rpcUrl, { retryCount: 0, timeout: 10000 }) }));
  assert.notEqual(wallets[0].account.address, wallets[1].account.address, "duplicate submitters must be distinct identities");
  await client.request({ method: "anvil_setBalance", params: [wallets[1].account.address, toHex(100n * 10n ** 18n)] });
  const state = (id) => read("isMessageExecuted", [id]);
  const callback = (functionName) => client.readContract({ address: receiverAddress, abi: receiver.abi, functionName });
  const call = (request, withCallback = false) => ({ address, abi,
    functionName: withCallback ? "acceptMessageThenCall" : "acceptMessage",
    args: withCallback ? [request, receiverAddress] : [request] });

  async function transaction(parameters, wallet, expectedStatus) {
    const hash = await wallet.writeContract({ ...parameters, gas: TEST_TRANSACTION_GAS });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, expectedStatus, "test acceptance must actually commit or revert on Chain B");
    assert.equal(receipt.from.toLowerCase(), wallet.account.address.toLowerCase());
    return receipt;
  }
  async function configureReceiver(failBefore, nested = "0x", failAfter = false) {
    await transaction({ address: receiverAddress, abi: receiver.abi, functionName: "configure",
      args: [failBefore, nested, failAfter] }, wallets[0], "success");
  }
  async function reject(request, errorName, errorArgs, label, { wallet = wallets[0], withCallback = false } = {}) {
    const before = await state(request.messageId);
    const parameters = call(request, withCallback);
    await assert.rejects(() => client.simulateContract({ ...parameters, account: wallet.account }), (error) => {
      for (let cause = error; cause; cause = cause.cause) {
        if (cause.data?.errorName === errorName) {
          assert.deepEqual((cause.data.args ?? []).map(errorValue), errorArgs.map(errorValue), `${label}: exact error arguments`);
          return true;
        }
      }
      return false;
    }, label);
    // An explicit test-only gas budget bypasses estimation so a real reverted receipt proves rollback.
    await transaction(parameters, wallet, "reverted");
    assert.equal(await state(request.messageId), before, `${label}: replay state must not change`);
    console.log(`EXPECTED FAILURE: Chain B replay acceptance / ${label} (${errorName}); transaction reverted, state preserved`);
  }
  async function consume(request, label, { wallet = wallets[0], withCallback = false } = {}) {
    assert.equal(await state(request.messageId), false, "real canonical message must be unexecuted before first acceptance");
    await client.simulateContract({ ...call(request, withCallback), account: wallet.account });
    assert.equal(await state(request.messageId), false, "eth_call/preflight must not consume replay state");
    await transaction(call(request, withCallback), wallet, "success");
    assert.equal(await state(request.messageId), true);
    console.log(`VALID: first Chain B replay consumption / ${label} / ${request.messageId}; false -> true`);
  }
  async function upstream(entry, input, label) {
    await certificateChecks.accept(entry.encoded, entry.context, `${label} / unchanged QC still valid`);
    await merkleChecks.accept(input, `${label} / unchanged membership still valid`);
    await domainChecks.accept(entry.snapshot.batch.messages[input.index], input.messageId,
      domainContext.expectedGateway, `${label} / unchanged full message still valid and fresh`);
  }

  let accepted = [];
  let pendingExpiry;
  async function run(entries) {
    // Reuse the actual old A/B/D batch and rotated single Message E, without producing new source history.
    assert.equal(entries.length, 2);
    const old = entries[0];
    const rotated = entries[1];
    assert.equal(old.inputs.length, 3);
    assert.equal(rotated.inputs.length, 1);
    const [a, b, d] = old.inputs.map((input) => acceptance(old, input));
    pendingExpiry = acceptance(rotated, rotated.inputs[0]);
    for (const request of [a, b, d, pendingExpiry]) assert.equal(await state(request.messageId), false);
    console.log("VALID: real authenticated A/B/D/E replay state is initially false; stateless verification has not consumed it");
    await upstream(old, old.inputs[0], "first real A acceptance");
    await consume(a, "real authenticated A");
    await upstream(old, old.inputs[0], "same exact A / same submitter duplicate");
    await reject(a, "MessageAlreadyExecuted", [a.messageId], "same exact canonical message and evidence");
    await upstream(old, old.inputs[0], "same exact A / different submitter duplicate");
    await reject(a, "MessageAlreadyExecuted", [a.messageId], "different submitter cannot replay the same message",
      { wallet: wallets[1] });
    console.log(`VALID: replay key is independent of submitters ${wallets[0].account.address} and ${wallets[1].account.address}`);

    const wrongQc = { ...old.snapshot.quorumCertificate, qcDigest: flipMerkleHash(old.snapshot.quorumCertificate.qcDigest) };
    await reject({ ...b, certificate: encodeCertificate(wrongQc) }, "QuorumCertificateDigestMismatch", [],
      "invalid QC cannot burn the authentic B message ID");
    assert.ok(old.inputs[1].proof.siblings.length > 0);
    const proof = { ...old.inputs[1].proof,
      siblings: [flipMerkleHash(old.inputs[1].proof.siblings[0]), ...old.inputs[1].proof.siblings.slice(1)] };
    await reject({ ...b, proof: { ...b.proof, siblings: proof.siblings } }, "MerkleRootMismatch",
      [old.context.messageRoot, forgedPathRoot(old.inputs[1], proof)], "tampered Merkle path cannot burn B");
    await reject({ ...b, message: { ...b.message, destinationDomain: BigInt(domainContext.alternateDomain) } },
      "InvalidDestinationDomain", [BigInt(domainContext.localDomain), BigInt(domainContext.alternateDomain)],
      "wrong destination domain cannot burn B");
    assert.equal(await state(b.messageId), false);
    await upstream(old, old.inputs[1], "B remains independently authentic after failed upstream validation");
    await configureReceiver(true);
    await reject(b, "MockExecutionFailed", [b.messageId], "downstream mock failure rolls B consumption back", { withCallback: true });
    assert.equal(await state(b.messageId), false);
    assert.equal(await callback("calls"), 0n);
    console.log("VALID: downstream failure leaves B unexecuted and receiver writes rolled back");
    await configureReceiver(false);
    await consume(b, "retry B after downstream rollback; A remains consumed", { wallet: wallets[1], withCallback: true });
    assert.equal(await callback("observedConsumed"), true);
    assert.equal(await callback("calls"), 1n);
    assert.equal(await state(a.messageId), true);
    console.log("VALID: callback observes B already consumed; distinct real message IDs remain independent");

    await upstream(old, old.inputs[2], "real D reentrancy/outer rollback");
    const nested = encodeFunctionData({ abi: harness.abi, functionName: "acceptMessage", args: [d] });
    await configureReceiver(false, nested, true);
    await reject(d, "MockExecutionFailed", [d.messageId], "outer callback failure after same-message reentry rolls D back",
      { withCallback: true });
    assert.equal(await state(d.messageId), false);
    assert.equal(await callback("calls"), 0n);
    assert.equal(await callback("observedConsumed"), false);
    await configureReceiver(false, nested, false);
    await consume(d, "retry D with same-message reentry caught by the mock", { withCallback: true });
    assert.equal(await callback("observedConsumed"), true);
    assert.equal(await callback("reentrySucceeded"), false);
    assert.equal(await callback("reentryResult"), encodeErrorResult({ abi: harness.abi,
      errorName: "MessageAlreadyExecuted", args: [d.messageId] }));
    assert.equal(await callback("calls"), 1n);
    console.log("VALID: D is consumed before callback; authenticated same-message reentry cannot execute twice");
    console.log("EXPECTED FAILURE: same-message nested acceptance rejected with exact MessageAlreadyExecuted(D)");
    accepted = [a, b, d];
    await upstream(rotated, rotated.inputs[0], "real E remains fresh and authenticated but deliberately unconsumed");
    await assertState("after real replay and callback checks");
  }
  async function assertState(label) {
    assert.equal(accepted.length, 3);
    for (const request of accepted) assert.equal(await state(request.messageId), true);
    assert.equal(await state(pendingExpiry.messageId), false);
    console.log(`VALID: replay state / ${label}; A/B/D stay consumed, E stays unconsumed`);
  }
  async function expired(expiryTimestamp) {
    assert.equal(await state(pendingExpiry.messageId), false);
    await reject(pendingExpiry, "MessageExpired", [pendingExpiry.message.deadline, expiryTimestamp],
      "authentic expired E cannot become executed", { wallet: wallets[1] });
    await assertState("after destination expiry; consumed IDs are never pruned");
  }
  return { run, assertState, expired };
}
