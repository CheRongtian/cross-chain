import { encodeAbiParameters, keccak256, parseAbiParameters, recoverMessageAddress, stringToHex } from "viem";
import { normalizeAddress, normalizeBytes32 } from "../../indexer/src/canonical-message.mjs";
import { canonicalCommittee, committeeDigest, protocolInteger } from "./committee.mjs";
import { validatorAccount } from "./identity.mjs";

export const COMMIT_TYPE = "PBFTCommit(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest,address voterIdentity)";
export const COMMIT_DOMAIN = keccak256(stringToHex(COMMIT_TYPE));
export const COMMIT_STATEMENT_FIELDS = Object.freeze([
  "protocolVersion", "sourceDomain", "sourceGateway", "epoch", "batchId", "messageRoot", "proposalDigest", "committeeDigest",
]);
export const COMMIT_ENVELOPE_FIELDS = Object.freeze([
  "messageType", ...COMMIT_STATEMENT_FIELDS, "voterIdentity", "commitDigest", "signature",
]);
const PARAMETERS = parseAbiParameters("bytes32,uint8,uint256,address,uint256,bytes32,bytes32,bytes32,bytes32,address");

export class CommitError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function normalizeCommitStatement(input) {
  try {
    const version = protocolInteger(input.protocolVersion, "protocol version");
    if (version > 255n) throw new Error("version exceeds uint8");
    return { protocolVersion: version.toString(), sourceDomain: protocolInteger(input.sourceDomain).toString(),
      sourceGateway: normalizeAddress(input.sourceGateway), epoch: protocolInteger(input.epoch).toString(),
      batchId: normalizeBytes32(input.batchId), messageRoot: normalizeBytes32(input.messageRoot),
      proposalDigest: normalizeBytes32(input.proposalDigest), committeeDigest: normalizeBytes32(input.committeeDigest) };
  } catch { throw new CommitError("MALFORMED"); }
}

export function normalizeCommit(input) {
  if (input?.messageType !== "COMMIT") throw new CommitError("MALFORMED");
  let voterIdentity;
  try { voterIdentity = normalizeAddress(input.voterIdentity); } catch { throw new CommitError("MALFORMED"); }
  return { messageType: "COMMIT", ...normalizeCommitStatement(input), voterIdentity };
}

export function commitDigest(input) {
  const v = normalizeCommit(input);
  return keccak256(encodeAbiParameters(PARAMETERS, [COMMIT_DOMAIN, Number(v.protocolVersion),
    BigInt(v.sourceDomain), v.sourceGateway, BigInt(v.epoch), v.batchId, v.messageRoot,
    v.proposalDigest, v.committeeDigest, v.voterIdentity]));
}

export async function signCommit(config, input) {
  const vote = normalizeCommit(input);
  if (vote.voterIdentity !== config.validatorAddress || !canonicalCommittee(config.peers).includes(vote.voterIdentity)) {
    throw new CommitError("UNKNOWN_VALIDATOR");
  }
  const digest = commitDigest(vote);
  const signature = await validatorAccount(config.privateKey).signMessage({ message: { raw: digest } });
  return { ...vote, commitDigest: digest, signature };
}

export async function authenticateCommit(config, input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== [...COMMIT_ENVELOPE_FIELDS].sort().join(",")) throw new CommitError("MALFORMED");
  const vote = normalizeCommit(input);
  if (vote.protocolVersion !== "1") throw new CommitError("WRONG_VERSION");
  if (vote.sourceDomain !== config.chainDomain.toString() || vote.sourceGateway !== config.sourceGateway) {
    throw new CommitError("WRONG_CONTEXT");
  }
  if (vote.committeeDigest !== committeeDigest(config.peers)) throw new CommitError("WRONG_COMMITTEE");
  if (!canonicalCommittee(config.peers).includes(vote.voterIdentity)) throw new CommitError("UNKNOWN_VALIDATOR");
  let supplied;
  try { supplied = normalizeBytes32(input.commitDigest); } catch { throw new CommitError("MALFORMED"); }
  const digest = commitDigest(vote);
  if (supplied !== digest) throw new CommitError("INVALID_DIGEST");
  let signer;
  try {
    if (typeof input.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) throw new Error("signature length");
    signer = normalizeAddress(await recoverMessageAddress({ message: { raw: digest }, signature: input.signature }));
  } catch { throw new CommitError("INVALID_SIGNATURE"); }
  if (signer !== vote.voterIdentity) throw new CommitError("INVALID_SIGNATURE");
  return { ...vote, commitDigest: digest, signature: input.signature.toLowerCase() };
}
