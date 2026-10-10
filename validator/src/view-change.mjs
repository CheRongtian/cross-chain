import { encodeAbiParameters, keccak256, parseAbiParameters, recoverMessageAddress, stringToHex } from "viem";
import { normalizeAddress, normalizeBytes32 } from "../../indexer/src/canonical-message.mjs";
import { canonicalCommittee, deterministicPrimary, protocolInteger } from "./committee.mjs";
import { CONSENSUS_VERSION } from "./protocol.mjs";
import { authenticatePrePrepare } from "./pre-prepare.mjs";
import { validatorAccount } from "./identity.mjs";
import { canonicalEvidence, preparedCertificateDigest, proposalIdentity, sameProposal,
  strictFields, verifyPreparedCertificate, ViewChangeError } from "./prepared-certificate.mjs";

export { ViewChangeError };
export const VIEW_CHANGE_TYPE = "PBFTViewChange(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 targetView,address voterIdentity,bytes32 acceptedProposalDigest,bytes32 preparedCertificateDigest)";
export const NEW_VIEW_TYPE = "PBFTNewView(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,address primaryIdentity,bytes32 batchId,bytes32 messageRoot,bytes32[] viewChangeDigests)";
export const VIEW_CHANGE_DOMAIN = keccak256(stringToHex(VIEW_CHANGE_TYPE));
export const NEW_VIEW_DOMAIN = keccak256(stringToHex(NEW_VIEW_TYPE));
export const VIEW_CHANGE_FIELDS = ["messageType", "protocolVersion", "sourceDomain", "sourceGateway", "epoch", "targetView",
  "voterIdentity", "acceptedProposal", "preparedCertificate", "viewChangeDigest", "signature"];
export const NEW_VIEW_FIELDS = ["messageType", "protocolVersion", "sourceDomain", "sourceGateway", "epoch", "view",
  "primaryIdentity", "selectedProposal", "viewChanges", "newViewDigest", "signature"];
const ZERO = `0x${"00".repeat(32)}`;

function context(input, kind) {
  try {
    return { messageType: kind, protocolVersion: protocolInteger(input.protocolVersion).toString(),
      sourceDomain: protocolInteger(input.sourceDomain).toString(), sourceGateway: normalizeAddress(input.sourceGateway),
      epoch: protocolInteger(input.epoch).toString() };
  } catch { throw new ViewChangeError("MALFORMED_VIEW_MESSAGE"); }
}
function checkContext(config, message) {
  if (message.protocolVersion !== CONSENSUS_VERSION) throw new ViewChangeError("WRONG_VERSION");
  if (message.sourceDomain !== config.chainDomain.toString() || message.sourceGateway !== config.sourceGateway) throw new ViewChangeError("WRONG_CONTEXT");
}
async function recover(config, identity, digest, supplied, signature) {
  if (!canonicalCommittee(config.peers).includes(identity)) throw new ViewChangeError("UNKNOWN_VALIDATOR");
  if (normalizeBytes32(supplied) !== digest) throw new ViewChangeError("INVALID_DIGEST");
  try {
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature) ||
        normalizeAddress(await recoverMessageAddress({ message: { raw: digest }, signature })) !== identity) throw new Error("signer");
  } catch { throw new ViewChangeError("INVALID_SIGNATURE"); }
}
export function viewChangeDigest(input) {
  const c = context(input, "VIEW_CHANGE");
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32,uint8,uint256,address,uint256,uint256,address,bytes32,bytes32"),
    [VIEW_CHANGE_DOMAIN, Number(c.protocolVersion), BigInt(c.sourceDomain), c.sourceGateway, BigInt(c.epoch),
      protocolInteger(input.targetView), normalizeAddress(input.voterIdentity), input.acceptedProposal?.proposalDigest ?? ZERO,
      preparedCertificateDigest(input.preparedCertificate)]));
}
export async function authenticateViewChange(config, input) {
  strictFields(input, VIEW_CHANGE_FIELDS);
  if (input.messageType !== "VIEW_CHANGE") throw new ViewChangeError("MALFORMED_VIEW_MESSAGE");
  const message = { ...context(input, "VIEW_CHANGE"), targetView: protocolInteger(input.targetView).toString(),
    voterIdentity: normalizeAddress(input.voterIdentity), acceptedProposal: null, preparedCertificate: null };
  checkContext(config, message);
  if (BigInt(message.targetView) === 0n) throw new ViewChangeError("WRONG_TARGET_VIEW");
  if (input.acceptedProposal !== null) {
    message.acceptedProposal = await authenticatePrePrepare({ ...config, allowHistorical: true }, input.acceptedProposal);
    if (message.acceptedProposal.epoch !== message.epoch || BigInt(message.acceptedProposal.view ?? "0") >= BigInt(message.targetView)) throw new ViewChangeError("WRONG_ACCEPTED_VIEW");
  }
  if (input.preparedCertificate !== null) {
    message.preparedCertificate = await verifyPreparedCertificate(input.preparedCertificate, config);
    const proposal = message.preparedCertificate.proposal;
    if (proposal.epoch !== message.epoch || BigInt(proposal.view ?? "0") >= BigInt(message.targetView)) throw new ViewChangeError("WRONG_PREPARED_VIEW");
    if (message.acceptedProposal && !sameProposal(message.acceptedProposal, proposal)) throw new ViewChangeError("CONFLICTING_SAFETY_EVIDENCE");
  }
  const digest = viewChangeDigest(message);
  await recover(config, message.voterIdentity, digest, input.viewChangeDigest, input.signature);
  return { ...message, viewChangeDigest: digest, signature: input.signature.toLowerCase() };
}
export async function signViewChange(config, input) {
  // Authenticate and normalize nested evidence before hashing or signing it.
  // Invalid quorums must fail at certificate validation, not ABI encoding.
  const preparedCertificate = input.preparedCertificate === null ? null
    : await verifyPreparedCertificate(input.preparedCertificate, config);
  const message = { ...input, messageType: "VIEW_CHANGE", protocolVersion: CONSENSUS_VERSION,
    sourceDomain: config.chainDomain.toString(), sourceGateway: config.sourceGateway, voterIdentity: config.validatorAddress,
    preparedCertificate };
  const digest = viewChangeDigest(message);
  return authenticateViewChange(config, { ...message, viewChangeDigest: digest,
    signature: await validatorAccount(config.privateKey).signMessage({ message: { raw: digest } }) });
}
export function selectSafeProposal(viewChanges, pendingProposal) {
  let highest = null;
  for (const message of viewChanges) {
    const proposal = message.preparedCertificate?.proposal;
    if (!proposal) continue;
    const view = BigInt(proposal.view ?? "0");
    if (!highest || view > BigInt(highest.view ?? "0")) highest = proposal;
    else if (view === BigInt(highest.view ?? "0") && !sameProposal(proposal, highest)) throw new ViewChangeError("CONFLICTING_HIGHEST_PREPARED");
  }
  if (!highest && !pendingProposal) throw new ViewChangeError("PENDING_BATCH_REQUIRED");
  return proposalIdentity(highest ?? pendingProposal);
}
export function newViewDigest(input) {
  const c = context(input, "NEW_VIEW");
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32,uint8,uint256,address,uint256,uint256,address,bytes32,bytes32,bytes32[]"),
    [NEW_VIEW_DOMAIN, Number(c.protocolVersion), BigInt(c.sourceDomain), c.sourceGateway, BigInt(c.epoch), protocolInteger(input.view),
      normalizeAddress(input.primaryIdentity), normalizeBytes32(input.selectedProposal.batchId), normalizeBytes32(input.selectedProposal.messageRoot),
      input.viewChanges.map((vote) => vote.viewChangeDigest)]));
}
export async function authenticateNewView(config, input, pendingProposal) {
  strictFields(input, NEW_VIEW_FIELDS);
  if (input.messageType !== "NEW_VIEW") throw new ViewChangeError("MALFORMED_VIEW_MESSAGE");
  const message = { ...context(input, "NEW_VIEW"), view: protocolInteger(input.view).toString(),
    primaryIdentity: normalizeAddress(input.primaryIdentity) };
  checkContext(config, message);
  if (BigInt(message.view) === 0n || deterministicPrimary(config.peers, message.epoch, message.view) !== message.primaryIdentity) throw new ViewChangeError("WRONG_PRIMARY");
  strictFields(input.selectedProposal, ["sourceDomain", "sourceGateway", "epoch", "batchId", "messageRoot"]);
  const selected = { sourceDomain: protocolInteger(input.selectedProposal.sourceDomain).toString(),
    sourceGateway: normalizeAddress(input.selectedProposal.sourceGateway), epoch: protocolInteger(input.selectedProposal.epoch).toString(),
    batchId: normalizeBytes32(input.selectedProposal.batchId), messageRoot: normalizeBytes32(input.selectedProposal.messageRoot) };
  if (selected.epoch !== message.epoch || selected.sourceDomain !== message.sourceDomain || selected.sourceGateway !== message.sourceGateway) throw new ViewChangeError("WRONG_SELECTED_CONTEXT");
  const ordered = canonicalEvidence(input.viewChanges, "voterIdentity");
  if (input.viewChanges.some((vote, index) => vote.voterIdentity !== ordered[index].voterIdentity)) throw new ViewChangeError("NONCANONICAL_EVIDENCE");
  const viewChanges = [];
  for (const evidence of ordered) {
    const vote = await authenticateViewChange(config, evidence);
    if (vote.epoch !== message.epoch || vote.targetView !== message.view) throw new ViewChangeError("WRONG_TARGET_VIEW");
    viewChanges.push(vote);
  }
  const safe = selectSafeProposal(viewChanges, pendingProposal);
  if (!sameProposal(selected, safe) || (pendingProposal && !sameProposal(selected, pendingProposal))) throw new ViewChangeError("UNSAFE_SELECTED_PROPOSAL");
  const result = { ...message, selectedProposal: selected, viewChanges };
  const digest = newViewDigest(result);
  await recover(config, message.primaryIdentity, digest, input.newViewDigest, input.signature);
  return { ...result, newViewDigest: digest, signature: input.signature.toLowerCase() };
}
export async function signNewView(config, input, pendingProposal) {
  const viewChanges = canonicalEvidence(input.viewChanges, "voterIdentity");
  const message = { ...input, messageType: "NEW_VIEW", protocolVersion: CONSENSUS_VERSION,
    sourceDomain: config.chainDomain.toString(), sourceGateway: config.sourceGateway, primaryIdentity: config.validatorAddress, viewChanges };
  const digest = newViewDigest(message);
  return authenticateNewView(config, { ...message, newViewDigest: digest,
    signature: await validatorAccount(config.privateKey).signMessage({ message: { raw: digest } }) }, pendingProposal);
}
