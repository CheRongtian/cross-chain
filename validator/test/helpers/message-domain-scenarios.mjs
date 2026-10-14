import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { computeCanonicalMessageId, computePayloadHash, normalizeAddress } from "../../../indexer/src/canonical-message.mjs";
import { canonicalDomainMessage, createMessageDomainChecks } from "../../../indexer/test/helpers/message-domain-contract.mjs";
import { flipMerkleHash } from "../../../indexer/test/helpers/merkle-inclusion-contract.mjs";

const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const OTHER_GATEWAY = "0x00000000000000000000000000000000000a11ce";
const OTHER_RECEIVER = "0x000000000000000000000000000000000000cafe";

function rehashed(message, changes) {
  const changed = { ...message, ...changes };
  if (changes.payload !== undefined) changed.payloadHash = computePayloadHash(changes.payload);
  return { ...changed, messageId: computeCanonicalMessageId(changed) };
}

export async function createActualMessageDomainChecks({ client, rpcUrl, sourceConfig, context }) {
  const { verifierAddress, alternateVerifierAddress, registryAddress, localDomain, alternateDomain, expectedGateway } = context;
  const primary = await createMessageDomainChecks({ client, address: verifierAddress, registryAddress, destinationDomain: localDomain });
  const alternate = await createMessageDomainChecks({ client, address: alternateVerifierAddress, registryAddress, destinationDomain: alternateDomain });
  const sourceClient = createPublicClient({ transport: http(sourceConfig.chainRpcUrl, { retryCount: 0, timeout: 10000 }) });
  const sourceArtifact = JSON.parse(readFileSync(new URL(
    "../../../contracts/out/SourceGateway.sol/SourceGateway.json", import.meta.url), "utf8"));
  const registryArtifact = JSON.parse(readFileSync(new URL(
    "../../../contracts/out/RemoteGatewayRegistry.sol/RemoteGatewayRegistry.json", import.meta.url), "utf8"));
  const target = normalizeAddress(expectedGateway);

  async function actual(message, authenticatedId, label) {
    assert.equal(computeCanonicalMessageId(message), authenticatedId, "Indexer identity must match the authenticated member");
    const [m] = canonicalDomainMessage(message);
    assert.equal(m.sourceDomain, BigInt(sourceConfig.chainDomain));
    assert.equal(m.sourceGateway, normalizeAddress(sourceConfig.sourceGateway));
    const sourceId = await sourceClient.readContract({ address: sourceConfig.sourceGateway, abi: sourceArtifact.abi,
      functionName: "computeMessageId", args: [m.sourceSender, m.destinationDomain, m.destinationGateway,
        m.destinationReceiver, m.nonce, m.payloadHash, m.deadline] });
    assert.equal(sourceId, authenticatedId, "actual SourceGateway canonical message ID drift");
    await primary.encoding(message, authenticatedId, `${label} / same SourceGateway, Indexer and authenticated message ID`);
    await primary.accept(message, authenticatedId, target, label);
    console.log(`VALID: authenticated full message ${authenticatedId} / sourceDomain=${m.sourceDomain} sourceGateway=${m.sourceGateway} destinationDomain=${m.destinationDomain} destinationGateway=${m.destinationGateway} receiver=${m.destinationReceiver} nonce=${m.nonce} deadline=${m.deadline}`);
  }
  async function members(snapshot, inputs, label) {
    assert.equal(snapshot.batch.messages.length, inputs.length);
    for (const input of inputs) {
      const message = snapshot.batch.messages[input.index];
      assert.equal(message.messageId, input.messageId);
      await actual(message, input.messageId, `${label} / member ${input.index}`);
    }
    const first = snapshot.batch.messages[0];
    await primary.accept(first, inputs[0].messageId, target, `${label} / repeated stateless verification`);
  }
  async function packages(entries, recoveredPackages) {
    assert.equal(recoveredPackages.length, entries.reduce((count, entry) => count + entry.inputs.length, 0));
    for (const pack of recoveredPackages) {
      const entry = entries.find((item) => item.snapshot.record.batchId === pack.batchId);
      assert.ok(entry, "delivery package must use an authenticated actual batch");
      assert.ok(Number.isSafeInteger(pack.messageIndex) && pack.messageIndex >= 0);
      const input = entry.inputs[pack.messageIndex];
      assert.ok(input);
      assert.equal(pack.messageRoot, input.messageRoot);
      assert.equal(pack.message.messageId, input.messageId);
      assert.deepEqual(canonicalDomainMessage(pack.message), canonicalDomainMessage(entry.snapshot.batch.messages[pack.messageIndex]));
      await actual(pack.message, input.messageId, "recovered READY package preserves the authenticated original full message");
    }
  }
  async function negatives(snapshot, inputs, merkleChecks, label) {
    const input = inputs[0];
    const m = snapshot.batch.messages[input.index];
    const id = input.messageId;
    for (const version of [0n, 1n, 3n, 255n]) {
      const changed = rehashed(m, { version });
      await primary.reject(changed, changed.messageId, target, "UnsupportedMessageVersion", [Number(version)],
        `${label} / self-consistent unsupported message version ${version}`);
    }
    const unknownDomain = (1n << 256n) - 1n;
    const unknown = rehashed(m, { sourceDomain: unknownDomain });
    await primary.reject(unknown, unknown.messageId, target, "UnknownSourceDomain", [unknownDomain], `${label} / unknown full-width source domain`);
    const wrongSourceDomain = rehashed(m, { sourceDomain: BigInt(m.sourceDomain) + 1n });
    await primary.reject(wrongSourceDomain, wrongSourceDomain.messageId, target, "UnknownSourceDomain",
      [BigInt(wrongSourceDomain.sourceDomain)], `${label} / source-domain substitution with the same gateway`);
    const wrongSourceGateway = rehashed(m, { sourceGateway: OTHER_GATEWAY });
    await primary.reject(wrongSourceGateway, wrongSourceGateway.messageId, target, "UntrustedRemoteGateway",
      [BigInt(m.sourceDomain), OTHER_GATEWAY, m.sourceGateway], `${label} / rehashed cross-source-gateway replay`);
    await primary.reject(m, flipMerkleHash(id), target, "MessageIdMismatch", [flipMerkleHash(id), id], `${label} / wrong supplied authenticated ID`);
    for (const [field, value] of [["sourceSender", OTHER_RECEIVER], ["nonce", BigInt(m.nonce) + 1n],
      ["deadline", BigInt(m.deadline) + 1n], ["destinationReceiver", OTHER_RECEIVER]]) {
      const changed = rehashed(m, { [field]: value });
      await primary.reject(changed, id, target, "MessageIdMismatch", [id, changed.messageId], `${label} / stale ID after ${field} mutation`);
    }
    const changedPayload = `${m.payload}00`;
    await primary.reject({ ...m, payload: changedPayload }, id, target, "PayloadHashMismatch",
      [m.payloadHash, computePayloadHash(changedPayload)], `${label} / payload mutation kept the original hash`);
    const payload = rehashed(m, { payload: changedPayload });
    await primary.reject(payload, id, target, "MessageIdMismatch", [id, payload.messageId], `${label} / stale ID after payload rehash`);
    const wrongGateway = rehashed(m, { destinationGateway: OTHER_GATEWAY });
    await primary.reject(wrongGateway, wrongGateway.messageId, target, "DestinationGatewayMismatch",
      [target, OTHER_GATEWAY], `${label} / substituted destination gateway`);
    await primary.reject(m, id, OTHER_GATEWAY, "DestinationGatewayMismatch", [OTHER_GATEWAY, target],
      `${label} / original authentic message with wrong trusted gateway context`);
    const zeroGateway = rehashed(m, { destinationGateway: ZERO_ADDRESS });
    await primary.reject(zeroGateway, zeroGateway.messageId, target, "InvalidDestinationGateway", [], `${label} / self-consistent zero gateway`);
    const zeroReceiver = rehashed(m, { destinationReceiver: ZERO_ADDRESS });
    await primary.reject(zeroReceiver, zeroReceiver.messageId, target, "InvalidDestinationReceiver", [], `${label} / self-consistent zero receiver`);
    const changedDomain = rehashed(m, { destinationDomain: BigInt(alternateDomain) });
    await primary.reject(changedDomain, changedDomain.messageId, target, "InvalidDestinationDomain",
      [BigInt(localDomain), BigInt(alternateDomain)], `${label} / rehashed alternate destination domain`);
    await alternate.reject(m, id, target, "InvalidDestinationDomain", [BigInt(alternateDomain), BigInt(localDomain)],
      `${label} / unchanged authentic message cannot replay on another configured domain`);
    await alternate.accept(changedDomain, changedDomain.messageId, target, `${label} / standalone semantics for a different destination intent`);
    const receiver = rehashed(m, { destinationReceiver: OTHER_RECEIVER });
    for (const [name, changed] of [["receiver", receiver], ["payload", payload]]) {
      await primary.accept(changed, changed.messageId, target, `${label} / standalone domain-valid ${name} variant`);
    }
    for (const [name, changed] of [["alternate-domain", changedDomain], ["receiver", receiver], ["payload", payload]]) {
      await merkleChecks.reject({ ...input, messageId: changed.messageId }, "MemberMessageIdMismatch",
        [BigInt(input.index), changed.messageId, id], `recomputed ${name} mutation is not included in the authenticated actual root`);
    }
  }
  async function policyLifecycle(entries, certificateChecks, merkleChecks) {
    // Run only after the existing destination transport workers have completed and stopped.
    const account = privateKeyToAccount(context.registryOperatorKey);
    const wallet = createWalletClient({ account, transport: http(rpcUrl, { retryCount: 0, timeout: 10000 }) });
    const registryArgs = { address: registryAddress, abi: registryArtifact.abi };
    assert.equal((await client.readContract({ ...registryArgs, functionName: "registryAdmin" })).toLowerCase(), account.address.toLowerCase());
    const first = entries[0].snapshot.batch.messages[0];
    const originalId = entries[0].inputs[0].messageId;
    const domain = BigInt(first.sourceDomain);
    const originalGateway = normalizeAddress(first.sourceGateway);
    assert.equal((await client.readContract({ ...registryArgs, functionName: "trustedRemoteGateway", args: [domain] })).toLowerCase(), originalGateway);
    const chainSnapshot = await client.request({ method: "evm_snapshot", params: [] });
    let failure;
    try {
      const replaceHash = await wallet.writeContract({ ...registryArgs, functionName: "setRemoteGateway", args: [domain, OTHER_GATEWAY] });
      assert.equal((await client.waitForTransactionReceipt({ hash: replaceHash })).status, "success");
      await primary.reject(first, originalId, target, "UntrustedRemoteGateway", [domain, originalGateway, OTHER_GATEWAY],
        "current remote-registry replacement rejects the unchanged original historical message");
      const replacement = rehashed(first, { sourceGateway: OTHER_GATEWAY });
      await primary.accept(replacement, replacement.messageId, target, "standalone message under current remote trust; no historical membership is implied");
      const restoreHash = await wallet.writeContract({ ...registryArgs, functionName: "setRemoteGateway", args: [domain, originalGateway] });
      assert.equal((await client.waitForTransactionReceipt({ hash: restoreHash })).status, "success");
      await primary.accept(first, originalId, target, "canonical remote mapping restored before expiry verification");
      const deadline = entries.flatMap((entry) => entry.snapshot.batch.messages).reduce(
        (latest, message) => BigInt(message.deadline) > latest ? BigInt(message.deadline) : latest, 0n);
      const expiryTimestamp = deadline + 1n;
      // The actual local fixture uses normal block times; protocol values elsewhere remain full uint256.
      assert.ok(expiryTimestamp <= BigInt(Number.MAX_SAFE_INTEGER), "actual Anvil fixture timestamp must be exactly representable");
      const before = await client.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
      assert.ok(BigInt(before.timestamp) < deadline, "actual messages must still be fresh before controlled expiry");
      await client.request({ method: "evm_setNextBlockTimestamp", params: [Number(expiryTimestamp)] });
      await client.request({ method: "evm_mine", params: [] });
      const expiredBlock = await client.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
      assert.equal(BigInt(expiredBlock.timestamp), expiryTimestamp);
      for (const entry of entries) {
        await certificateChecks.accept(entry.encoded, entry.context, "unchanged actual QC remains valid after message deadline");
        await merkleChecks.members(entry.inputs, "unchanged actual inclusion remains valid after message deadline");
        for (const input of entry.inputs) {
          const message = entry.snapshot.batch.messages[input.index];
          await primary.encoding(message, input.messageId, "expiry does not change the historical canonical ID");
          await primary.reject(message, input.messageId, target, "MessageExpired", [BigInt(message.deadline), expiryTimestamp],
            "destination rejects authentic expired message despite valid QC and Merkle evidence");
        }
      }
      console.log("VALID: expiry is destination acceptance policy; source history, QC, roots, proofs and READY packages are unchanged");
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        assert.equal(await client.request({ method: "evm_revert", params: [chainSnapshot] }), true, "restore temporary registry/time changes");
        assert.equal((await client.readContract({ ...registryArgs, functionName: "trustedRemoteGateway", args: [domain] })).toLowerCase(), originalGateway);
      } catch (error) {
        if (!failure) throw error;
        console.error(`Message policy fixture cleanup also failed: ${error.message}`);
      }
    }
  }
  return { members, packages, negatives, policyLifecycle };
}
