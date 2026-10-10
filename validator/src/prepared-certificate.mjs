import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from "viem";
import { authenticatePrePrepare } from "./pre-prepare.mjs";
import { authenticatePrepare } from "./prepare.mjs";
import { normalizeAddress } from "../../indexer/src/canonical-message.mjs";

export class ViewChangeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function strictFields(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== [...fields].sort().join(",")) throw new ViewChangeError("MALFORMED_EVIDENCE");
}
export function canonicalEvidence(entries, field) {
  if (!Array.isArray(entries) || entries.length < 3 || entries.length > 4) throw new ViewChangeError("QUORUM_REQUIRED");
  let identities;
  try { identities = entries.map((entry) => ({ entry, identity: normalizeAddress(entry[field]) })); }
  catch { throw new ViewChangeError("MALFORMED_EVIDENCE"); }
  if (new Set(identities.map(({ identity }) => identity)).size !== identities.length) throw new ViewChangeError("DUPLICATE_SIGNER");
  return identities.sort((a, b) => a.identity < b.identity ? -1 : 1).map(({ entry }) => entry);
}
export function proposalIdentity(proposal) {
  return { sourceDomain: proposal.sourceDomain, sourceGateway: proposal.sourceGateway,
    epoch: proposal.epoch, ...(proposal.validatorEpoch === undefined ? {} : { validatorEpoch: proposal.validatorEpoch, committeeDigest: proposal.committeeDigest }), batchId: proposal.batchId, messageRoot: proposal.messageRoot };
}
export function sameProposal(a, b) {
  return ["sourceDomain", "sourceGateway", "epoch", "validatorEpoch", "committeeDigest", "batchId", "messageRoot"].every((field) => a[field] === b[field]);
}
export async function verifyPreparedCertificate(input, config) {
  strictFields(input, ["messageType", "proposal", "prepares"]);
  if (input.messageType !== "PREPARED_CERTIFICATE") throw new ViewChangeError("MALFORMED_PREPARED_CERTIFICATE");
  const proposal = await authenticatePrePrepare({ ...config, allowHistorical: true }, input.proposal);
  const ordered = canonicalEvidence(input.prepares, "voterIdentity");
  if (input.prepares.some((vote, index) => vote.voterIdentity !== ordered[index].voterIdentity)) throw new ViewChangeError("NONCANONICAL_EVIDENCE");
  const prepares = [];
  for (const evidence of ordered) {
    const vote = await authenticatePrepare({ ...config, allowHistorical: proposal.protocolVersion !== "3" }, evidence);
    if (!sameProposal(vote, proposal) || vote.protocolVersion !== proposal.protocolVersion ||
        (vote.view ?? "0") !== (proposal.view ?? "0") || vote.proposalDigest !== proposal.proposalDigest) {
      throw new ViewChangeError("WRONG_PREPARED_PROPOSAL");
    }
    prepares.push(vote);
  }
  return { messageType: "PREPARED_CERTIFICATE", proposal, prepares };
}
export async function buildPreparedCertificate(proposal, prepares, config) {
  return verifyPreparedCertificate({ messageType: "PREPARED_CERTIFICATE", proposal,
    prepares: canonicalEvidence(prepares, "voterIdentity") }, config);
}
export function preparedCertificateDigest(certificate) {
  if (!certificate) return `0x${"00".repeat(32)}`;
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32,bytes32,address[],bytes32[]"),
    [keccak256(stringToHex("PBFTPreparedCertificate")), certificate.proposal.proposalDigest,
      certificate.prepares.map((vote) => normalizeAddress(vote.voterIdentity)), certificate.prepares.map((vote) => vote.prepareDigest)]));
}
