import { keccak256, recoverMessageAddress, stringToHex } from "viem";
import { normalizeAddress, normalizeBytes32 } from "../../indexer/src/canonical-message.mjs";
import { deterministicPrimary, protocolInteger } from "./committee.mjs";
import { validatorAccount } from "./identity.mjs";

import { consensusBinding, consensusCommittee } from "./validator-sets.mjs";
import { consensusType, CONSENSUS_VERSION, versionedDigest, envelopeFields, validatorFields, viewFields } from "./protocol.mjs";

function committee(config, input) {
  try { return consensusCommittee(config, input); }
  catch (error) { throw new PrePrepareError(error.code ?? "WRONG_COMMITTEE"); }
}

export const PRE_PREPARE_VERSION = CONSENSUS_VERSION;
export const PRE_PREPARE_TYPE = consensusType("PBFTPrePrepare(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,address primaryIdentity)");
export const PRE_PREPARE_DOMAIN = keccak256(stringToHex(PRE_PREPARE_TYPE));
export const PRE_PREPARE_FIELDS = Object.freeze([
  "messageType", "protocolVersion", "sourceDomain", "sourceGateway", "epoch", "view", "validatorEpoch", "committeeDigest", "batchId", "messageRoot", "primaryIdentity",
]);
export const PRE_PREPARE_ENVELOPE_FIELDS = Object.freeze([...PRE_PREPARE_FIELDS, "proposalDigest", "signature"]);
const PARAMETERS = ["uint8", "uint256", "address", "uint256", "uint256", "bytes32", "bytes32", "address"];

export class PrePrepareError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function normalizePrePrepare(input) {
  try {
    if (!input || input.messageType !== "PRE_PREPARE") throw new Error("wrong message type");
    const version = protocolInteger(input.protocolVersion, "protocol version");
    if (version > 255n) throw new Error("protocol version exceeds uint8");
    return {
      messageType: "PRE_PREPARE", protocolVersion: version.toString(),
      sourceDomain: protocolInteger(input.sourceDomain, "source domain").toString(),
      sourceGateway: normalizeAddress(input.sourceGateway), epoch: protocolInteger(input.epoch).toString(),
      ...viewFields(input), ...validatorFields(input), batchId: normalizeBytes32(input.batchId), messageRoot: normalizeBytes32(input.messageRoot),
      primaryIdentity: normalizeAddress(input.primaryIdentity),
    };
  } catch { throw new PrePrepareError("MALFORMED"); }
}

export function prePrepareDigest(input) {
  const p = normalizePrePrepare(input);
  return versionedDigest(PRE_PREPARE_TYPE, PARAMETERS, [Number(p.protocolVersion),
    BigInt(p.sourceDomain), p.sourceGateway, BigInt(p.epoch), BigInt(p.view ?? "0"), p.batchId, p.messageRoot, p.primaryIdentity], p);
}

export async function signPrePrepare(config, input) {
  const proposal = normalizePrePrepare(String(input.protocolVersion) === "3" ? { ...consensusBinding(config, input.epoch), ...input } : input);
  if (![CONSENSUS_VERSION, "2"].includes(proposal.protocolVersion)) throw new PrePrepareError("WRONG_VERSION");
  const set = committee(config, proposal);
  if (proposal.primaryIdentity !== config.validatorAddress ||
      deterministicPrimary(set.validators, proposal.epoch, proposal.view ?? "0") !== config.validatorAddress) throw new PrePrepareError("WRONG_PRIMARY");
  const proposalDigest = prePrepareDigest(proposal);
  const signature = await validatorAccount(config.privateKey).signMessage({ message: { raw: proposalDigest } });
  return { ...proposal, proposalDigest, signature };
}

export async function authenticatePrePrepare(config, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== envelopeFields(PRE_PREPARE_ENVELOPE_FIELDS, input.protocolVersion).sort().join(",")) {
    throw new PrePrepareError("MALFORMED");
  }
  const p = normalizePrePrepare(input);
  if (p.protocolVersion !== PRE_PREPARE_VERSION && !(config.allowHistorical && ["1", "2"].includes(p.protocolVersion))) throw new PrePrepareError("WRONG_VERSION");
  if (p.sourceDomain !== config.chainDomain.toString() || p.sourceGateway !== config.sourceGateway) throw new PrePrepareError("WRONG_CONTEXT");
  let digest;
  try { digest = normalizeBytes32(input.proposalDigest); } catch { throw new PrePrepareError("MALFORMED"); }
  if (digest !== prePrepareDigest(p)) throw new PrePrepareError("INVALID_DIGEST");
  const set = committee(config, p);
  if (!set.validators.includes(p.primaryIdentity) ||
      deterministicPrimary(set.validators, p.epoch, p.view ?? "0") !== p.primaryIdentity) throw new PrePrepareError("WRONG_PRIMARY");
  let signer;
  try {
    if (typeof input.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) throw new Error("signature length");
    signer = normalizeAddress(await recoverMessageAddress({ message: { raw: digest }, signature: input.signature }));
  } catch { throw new PrePrepareError("INVALID_SIGNATURE"); }
  if (signer !== p.primaryIdentity) throw new PrePrepareError("INVALID_SIGNATURE");
  return { ...p, proposalDigest: digest, signature: input.signature.toLowerCase() };
}
