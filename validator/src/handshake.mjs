import { randomBytes } from "node:crypto";
import { encodeAbiParameters, keccak256, parseAbiParameters, recoverMessageAddress, stringToHex } from "viem";
import { normalizeAddress, normalizeBytes32 } from "../../indexer/src/canonical-message.mjs";
import { validatorAccount, publicIdentity } from "./identity.mjs";

export const HANDSHAKE_TYPE = "ValidatorIdentityHandshake(uint256 sourceDomain,address sourceGateway,address validator,bytes32 challenge)";
export const HANDSHAKE_DOMAIN = keccak256(stringToHex(HANDSHAKE_TYPE));
const PARAMETERS = parseAbiParameters("bytes32,uint256,address,address,bytes32");

export function handshakeDigest(config, address, challenge) {
  return keccak256(encodeAbiParameters(PARAMETERS, [
    HANDSHAKE_DOMAIN, config.chainDomain, config.sourceGateway,
    normalizeAddress(address), normalizeBytes32(challenge, "handshake challenge"),
  ]));
}

export async function signHandshake(config, challenge) {
  const normalized = normalizeBytes32(challenge, "handshake challenge");
  const signature = await validatorAccount(config.privateKey).signMessage({
    message: { raw: handshakeDigest(config, config.validatorAddress, normalized) },
  });
  return { ...publicIdentity(config), challenge: normalized, signature };
}

export async function verifyHandshakeResponse(config, peerAddress, challenge, response) {
  try {
    const expected = normalizeAddress(peerAddress);
    if (expected === config.validatorAddress || !config.peers.some((peer) => peer.address === expected)) return false;
    if (response?.validatorAddress !== expected || response.protocolVersion !== "1" ||
        response.sourceDomain !== config.chainDomain.toString() || response.sourceGateway !== config.sourceGateway ||
        response.finalityBlockDepth !== config.finalityBlockDepth.toString() ||
        response.challenge !== normalizeBytes32(challenge, "handshake challenge") ||
        typeof response.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(response.signature)) return false;
    const recovered = await recoverMessageAddress({
      message: { raw: handshakeDigest(config, expected, response.challenge) }, signature: response.signature,
    });
    return normalizeAddress(recovered) === expected;
  } catch { return false; }
}

export async function connectPeer(config, peerAddress, fetchImplementation = fetch) {
  const address = normalizeAddress(peerAddress, "peer validator identity");
  const peer = config.peers.find((entry) => entry.address === address);
  if (!peer || address === config.validatorAddress) throw new Error("unknown or self validator peer");
  const challenge = `0x${randomBytes(32).toString("hex")}`;
  const response = await fetchImplementation(`${peer.url}/handshake`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requesterAddress: config.validatorAddress, challenge }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("peer handshake request failed");
  const body = await response.json();
  if (!await verifyHandshakeResponse(config, address, challenge, body)) throw new Error("peer identity authentication failed");
  return { peerAddress: address, authenticated: true };
}
