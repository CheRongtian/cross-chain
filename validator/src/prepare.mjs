import { keccak256, recoverMessageAddress, stringToHex } from "viem";
import { normalizeAddress, normalizeBytes32 } from "../../indexer/src/canonical-message.mjs";
import { protocolInteger } from "./committee.mjs";
import { validatorAccount } from "./identity.mjs";

import { CONSENSUS_VERSION, consensusDigest, viewFields } from "./protocol.mjs";

export const PREPARE_VERSION = CONSENSUS_VERSION;
export const PREPARE_TYPE = "PBFTPrepare(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,address voterIdentity)";
export const PREPARE_DOMAIN = keccak256(stringToHex(PREPARE_TYPE));
export const PREPARE_FIELDS = Object.freeze([
  "messageType", "protocolVersion", "sourceDomain", "sourceGateway", "epoch", "view", "batchId", "messageRoot",
  "proposalDigest", "voterIdentity",
]);
export const PREPARE_ENVELOPE_FIELDS = Object.freeze([...PREPARE_FIELDS, "prepareDigest", "signature"]);
const PARAMETERS = ["uint8", "uint256", "address", "uint256", "uint256", "bytes32", "bytes32", "bytes32", "address"];

export class PrepareError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function normalizePrepare(input) {
  try {
    if (!input || input.messageType !== "PREPARE") throw new Error("wrong message type");
    const version = protocolInteger(input.protocolVersion, "protocol version");
    if (version > 255n) throw new Error("protocol version exceeds uint8");
    return {
      messageType: "PREPARE", protocolVersion: version.toString(),
      sourceDomain: protocolInteger(input.sourceDomain, "source domain").toString(),
      sourceGateway: normalizeAddress(input.sourceGateway), epoch: protocolInteger(input.epoch).toString(),
      ...viewFields(input), batchId: normalizeBytes32(input.batchId), messageRoot: normalizeBytes32(input.messageRoot),
      proposalDigest: normalizeBytes32(input.proposalDigest), voterIdentity: normalizeAddress(input.voterIdentity),
    };
  } catch { throw new PrepareError("MALFORMED"); }
}

export function prepareDigest(input) {
  const vote = normalizePrepare(input);
  return consensusDigest(PREPARE_TYPE, PARAMETERS, [
    Number(vote.protocolVersion), BigInt(vote.sourceDomain), vote.sourceGateway,
    BigInt(vote.epoch), BigInt(vote.view ?? "0"), vote.batchId, vote.messageRoot, vote.proposalDigest, vote.voterIdentity,
  ], vote.protocolVersion);
}

export async function signPrepare(config, input) {
  const vote = normalizePrepare(input);
  if (vote.protocolVersion !== CONSENSUS_VERSION) throw new PrepareError("WRONG_VERSION");
  if (vote.voterIdentity !== config.validatorAddress ||
      !config.peers.some((peer) => peer.address === vote.voterIdentity)) throw new PrepareError("UNKNOWN_VALIDATOR");
  const digest = prepareDigest(vote);
  const signature = await validatorAccount(config.privateKey).signMessage({ message: { raw: digest } });
  return { ...vote, prepareDigest: digest, signature };
}

export async function authenticatePrepare(config, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== [...PREPARE_ENVELOPE_FIELDS].filter((field) => field !== "view" || input.protocolVersion !== "1").sort().join(",")) {
    throw new PrepareError("MALFORMED");
  }
  const vote = normalizePrepare(input);
  if (vote.protocolVersion !== PREPARE_VERSION && !(config.allowHistorical && vote.protocolVersion === "1")) throw new PrepareError("WRONG_VERSION");
  if (vote.sourceDomain !== config.chainDomain.toString() || vote.sourceGateway !== config.sourceGateway) {
    throw new PrepareError("WRONG_CONTEXT");
  }
  if (!config.peers.some((peer) => peer.address === vote.voterIdentity)) throw new PrepareError("UNKNOWN_VALIDATOR");
  let suppliedDigest;
  try { suppliedDigest = normalizeBytes32(input.prepareDigest); } catch { throw new PrepareError("MALFORMED"); }
  if (suppliedDigest !== prepareDigest(vote)) throw new PrepareError("INVALID_DIGEST");
  let signer;
  try {
    if (typeof input.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) {
      throw new Error("signature length");
    }
    signer = normalizeAddress(await recoverMessageAddress({ message: { raw: suppliedDigest }, signature: input.signature }));
  } catch { throw new PrepareError("INVALID_SIGNATURE"); }
  if (signer !== vote.voterIdentity) throw new PrepareError("INVALID_SIGNATURE");
  return { ...vote, prepareDigest: suppliedDigest, signature: input.signature.toLowerCase() };
}
