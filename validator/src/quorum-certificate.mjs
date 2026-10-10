import { keccak256, stringToHex } from "viem";
import { normalizeBytes32 } from "../../indexer/src/canonical-message.mjs";
import { committeeDigest, deterministicPrimary } from "./committee.mjs";
import { authenticateCommit, COMMIT_STATEMENT_FIELDS, normalizeCommitStatement } from "./commit.mjs";
import { prePrepareDigest } from "./pre-prepare.mjs";

import { CONSENSUS_VERSION, consensusDigest } from "./protocol.mjs";

export const QC_TYPE = "PBFTQuorumCertificate(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest)";
export const QC_DOMAIN = keccak256(stringToHex(QC_TYPE));
export const QC_FIELDS = Object.freeze(["messageType", ...COMMIT_STATEMENT_FIELDS, "qcDigest", "commits"]);
const PARAMETERS = ["uint8", "uint256", "address", "uint256", "uint256", "bytes32", "bytes32", "bytes32", "bytes32"];

export class QuorumCertificateError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function expectedCommitStatement(context, peers) {
  // Derive the proposal identity from the expected batch and deterministic primary.
  const proposalDigest = prePrepareDigest({ ...context, messageType: "PRE_PREPARE", protocolVersion: context.protocolVersion ?? CONSENSUS_VERSION, view: context.view ?? "0",
    primaryIdentity: deterministicPrimary(peers, context.epoch, context.view ?? "0") });
  const committee = committeeDigest(peers);
  if (context.protocolVersion !== undefined && !["1", CONSENSUS_VERSION].includes(String(context.protocolVersion))) {
    throw new QuorumCertificateError("INVALID_EXPECTED_VERSION");
  }
  if (context.proposalDigest !== undefined && normalizeBytes32(context.proposalDigest) !== proposalDigest) {
    throw new QuorumCertificateError("INVALID_EXPECTED_PROPOSAL");
  }
  if (context.committeeDigest !== undefined && normalizeBytes32(context.committeeDigest) !== committee) {
    throw new QuorumCertificateError("INVALID_EXPECTED_COMMITTEE");
  }
  return normalizeCommitStatement({ ...context, protocolVersion: context.protocolVersion ?? CONSENSUS_VERSION, view: context.view ?? "0", proposalDigest, committeeDigest: committee });
}

export function qcDigest(input) {
  const s = normalizeCommitStatement(input);
  return consensusDigest(QC_TYPE, PARAMETERS, [Number(s.protocolVersion),
    BigInt(s.sourceDomain), s.sourceGateway, BigInt(s.epoch), BigInt(s.view ?? "0"), s.batchId, s.messageRoot,
    s.proposalDigest, s.committeeDigest], s.protocolVersion);
}

export async function verifyQuorumCertificate(input, { peers, expected }) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.messageType !== "QUORUM_CERTIFICATE" ||
      Object.keys(input).sort().join(",") !== [...QC_FIELDS].filter((field) => field !== "view" || input.protocolVersion !== "1").sort().join(",")) throw new QuorumCertificateError("MALFORMED_QC");
  let statement;
  try { statement = normalizeCommitStatement(input); } catch { throw new QuorumCertificateError("MALFORMED_QC"); }
  const required = expectedCommitStatement(expected, peers);
  for (const field of COMMIT_STATEMENT_FIELDS) {
    if (statement[field] !== required[field]) throw new QuorumCertificateError(`WRONG_QC_${field.toUpperCase()}`);
  }
  const digest = qcDigest(statement);
  try {
    if (normalizeBytes32(input.qcDigest) !== digest) throw new Error("digest mismatch");
  } catch { throw new QuorumCertificateError("INVALID_QC_DIGEST"); }
  if (!Array.isArray(input.commits) || input.commits.length < 3 || input.commits.length > 4) {
    throw new QuorumCertificateError("INSUFFICIENT_OR_INVALID_QC_EVIDENCE");
  }
  const commits = [];
  const identities = new Set();
  const config = { allowHistorical: required.protocolVersion === "1", peers, chainDomain: BigInt(required.sourceDomain), sourceGateway: required.sourceGateway };
  for (const evidence of input.commits) {
    const vote = await authenticateCommit(config, evidence);
    if (COMMIT_STATEMENT_FIELDS.some((field) => vote[field] !== statement[field])) throw new QuorumCertificateError("MISMATCHED_COMMIT");
    if (identities.has(vote.voterIdentity)) throw new QuorumCertificateError("DUPLICATE_QC_SIGNER");
    identities.add(vote.voterIdentity); commits.push(vote);
  }
  const ordered = [...commits].sort((a, b) => a.voterIdentity < b.voterIdentity ? -1 : 1);
  if (commits.some((vote, index) => vote.voterIdentity !== ordered[index].voterIdentity)) {
    throw new QuorumCertificateError("NONCANONICAL_QC_EVIDENCE");
  }
  return { messageType: "QUORUM_CERTIFICATE", ...statement, qcDigest: digest, commits: ordered };
}

export async function buildQuorumCertificate(commits, options) {
  const statement = expectedCommitStatement(options.expected, options.peers);
  if (!Array.isArray(commits)) throw new QuorumCertificateError("MALFORMED_QC");
  const ordered = [...commits].sort((a, b) => a.voterIdentity < b.voterIdentity ? -1 : 1);
  return verifyQuorumCertificate({ messageType: "QUORUM_CERTIFICATE", ...statement,
    qcDigest: qcDigest(statement), commits: ordered }, options);
}
