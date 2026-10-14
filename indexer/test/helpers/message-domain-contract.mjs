import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeAddress, normalizeBytes32, normalizePayload } from "../../src/canonical-message.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";

function exactUint(value, label) {
  if (typeof value === "number") {
    assert.ok(Number.isSafeInteger(value) && value >= 0, `${label} must be an exact uint256`);
    value = BigInt(value);
  }
  return protocolInteger(value, label);
}

// Model/ABI conversion only. Inconsistent payload hashes must reach the contract's negative checks.
export function canonicalDomainMessage(message) {
  const version = exactUint(message.version, "message version");
  assert.ok(version <= 255n, "message version must fit uint8");
  return [{ version: Number(version), sourceDomain: exactUint(message.sourceDomain, "source domain"),
    sourceGateway: normalizeAddress(message.sourceGateway), sourceSender: normalizeAddress(message.sourceSender),
    destinationDomain: exactUint(message.destinationDomain, "destination domain"),
    destinationGateway: normalizeAddress(message.destinationGateway), destinationReceiver: normalizeAddress(message.destinationReceiver),
    nonce: exactUint(message.nonce, "message nonce"), payloadHash: normalizeBytes32(message.payloadHash, "payload hash"),
    deadline: exactUint(message.deadline, "message deadline") }, normalizePayload(message.payload)];
}

export function messageDomainArguments(message, authenticatedMessageId, expectedDestinationGateway) {
  return [...canonicalDomainMessage(message), normalizeBytes32(authenticatedMessageId, "authenticated message ID"),
    normalizeAddress(expectedDestinationGateway, "expected destination gateway")];
}

// Address casing is a display choice; the error must still match exact identity and all integer/hash arguments.
const errorValue = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value;

export async function createMessageDomainChecks({ client, address, registryAddress, destinationDomain }) {
  const artifact = JSON.parse(readFileSync(new URL(
    "../../../contracts/out/MessageDomainVerifier.sol/MessageDomainVerifier.json", import.meta.url), "utf8"));
  const registryArtifact = JSON.parse(readFileSync(new URL(
    "../../../contracts/out/RemoteGatewayRegistry.sol/RemoteGatewayRegistry.json", import.meta.url), "utf8"));
  const abi = [...artifact.abi, ...registryArtifact.abi.filter((item) => item.type === "error")];
  assert.equal((await client.readContract({ address, abi, functionName: "remoteGatewayRegistry" })).toLowerCase(),
    normalizeAddress(registryAddress), "message verifier remote-registry dependency drift");
  assert.equal(await client.readContract({ address, abi, functionName: "destinationDomain" }), BigInt(destinationDomain),
    "message verifier local destination domain drift");
  assert.equal(await client.readContract({ address, abi, functionName: "MESSAGE_VERSION" }), 2,
    "message protocol version must remain distinct from transport/QC versions");
  const read = (message, id, gateway) => client.readContract({ address, abi, functionName: "verifyMessage",
    args: messageDomainArguments(message, id, gateway) });
  async function encoding(message, expectedId, label) {
    assert.equal(await client.readContract({ address, abi, functionName: "computeMessageId",
      args: canonicalDomainMessage(message) }), normalizeBytes32(expectedId), label);
    console.log(`VALID: Chain B canonical message ID / ${label}`);
  }
  async function accept(message, id, gateway, label) {
    assert.equal(await read(message, id, gateway), true, label);
    console.log(`VALID: Chain B message domain verification / ${label}`);
  }
  async function reject(message, id, gateway, errorName, errorArgs, label) {
    await assert.rejects(() => read(message, id, gateway), (error) => {
      // An RPC error or a different revert cannot stand in for this exact protocol rejection.
      for (let cause = error; cause; cause = cause.cause) {
        if (cause.data?.errorName === errorName) {
          assert.deepEqual((cause.data.args ?? []).map(errorValue), errorArgs.map(errorValue), `${label}: error arguments`);
          return true;
        }
      }
      return false;
    }, label);
    console.log(`EXPECTED FAILURE: Chain B message domain verification / ${label} (${errorName})`);
  }
  return { accept, reject, encoding };
}
