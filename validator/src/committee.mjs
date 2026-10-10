import { normalizeAddress, toUint256 } from "../../indexer/src/canonical-message.mjs";
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from "viem";

export const COMMITTEE_TYPE = "PBFTStaticCommittee(uint8 protocolVersion,address[4] validators)";
export const COMMITTEE_DOMAIN = keccak256(stringToHex(COMMITTEE_TYPE));

export function committeeDigest(peers) {
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32,uint8,address[4]"),
    [COMMITTEE_DOMAIN, 1, canonicalCommittee(peers)]));
}

export function protocolInteger(value, label = "epoch") {
  if (typeof value !== "bigint" && !(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))) {
    throw new Error(`${label} must be an exact uint256`);
  }
  return toUint256(value, label);
}

export function canonicalCommittee(peers) {
  if (!Array.isArray(peers) || peers.length !== 4) throw new Error("committee must contain exactly four validators");
  const addresses = peers.map((peer) => normalizeAddress(typeof peer === "string" ? peer : peer.address));
  if (new Set(addresses).size !== 4) throw new Error("committee identities must be unique");
  // Equal-length lowercase hex address order is identical to unsigned byte order.
  return Object.freeze(addresses.sort());
}

export function deterministicPrimary(peers, epoch, view = "0") {
  return canonicalCommittee(peers)[Number((protocolInteger(epoch) + protocolInteger(view, "view")) % 4n)];
}
