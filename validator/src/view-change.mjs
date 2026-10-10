import { keccak256, recoverMessageAddress, stringToHex } from "viem";
import { normalizeAddress, normalizeBytes32 } from "../../indexer/src/canonical-message.mjs";
import { deterministicPrimary, protocolInteger } from "./committee.mjs";
import { consensusBinding, consensusCommittee } from "./validator-sets.mjs";
import { consensusType, CONSENSUS_VERSION, envelopeFields, validatorFields, versionedDigest } from "./protocol.mjs";
import { authenticatePrePrepare } from "./pre-prepare.mjs";
import { validatorAccount } from "./identity.mjs";
import { canonicalEvidence, preparedCertificateDigest, proposalIdentity, sameProposal,
  strictFields, verifyPreparedCertificate, ViewChangeError } from "./prepared-certificate.mjs";

function committee(config, input) {
  try { return consensusCommittee(config, input); }
  catch (error) { throw new ViewChangeError(error.code ?? "WRONG_COMMITTEE"); }
}

export { ViewChangeError };
export const VIEW_CHANGE_TYPE = consensusType("PBFTViewChange(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 targetView,address voterIdentity,bytes32 acceptedProposalDigest,bytes32 preparedCertificateDigest)");
export const NEW_VIEW_TYPE = consensusType("PBFTNewView(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,address primaryIdentity,bytes32 batchId,bytes32 messageRoot,bytes32[] viewChangeDigests)");
export const VIEW_CHANGE_DOMAIN = keccak256(stringToHex(VIEW_CHANGE_TYPE));
export const NEW_VIEW_DOMAIN = keccak256(stringToHex(NEW_VIEW_TYPE));
export const VIEW_CHANGE_FIELDS = ["messageType", "protocolVersion", "sourceDomain", "sourceGateway", "epoch", "validatorEpoch", "committeeDigest", "targetView",
  "voterIdentity", "acceptedProposal", "preparedCertificate", "viewChangeDigest", "signature"];
export const NEW_VIEW_FIELDS = ["messageType", "protocolVersion", "sourceDomain", "sourceGateway", "epoch", "validatorEpoch", "committeeDigest", "view",
  "primaryIdentity", "selectedProposal", "viewChanges", "newViewDigest", "signature"];
const ZERO = `0x${"00".repeat(32)}`;

function context(input, kind) {
  try {
    return { messageType: kind, protocolVersion: protocolInteger(input.protocolVersion).toString(),
      sourceDomain: protocolInteger(input.sourceDomain).toString(), sourceGateway: normalizeAddress(input.sourceGateway),
      epoch: protocolInteger(input.epoch).toString(), ...validatorFields(input) };
  } catch { throw new ViewChangeError("MALFORMED_VIEW_MESSAGE"); }
}
function checkContext(config, message) {
  if (![CONSENSUS_VERSION, "2"].includes(message.protocolVersion)) throw new ViewChangeError("WRONG_VERSION");
  if (message.sourceDomain !== config.chainDomain.toString() || message.sourceGateway !== config.sourceGateway) throw new ViewChangeError("WRONG_CONTEXT");
}
async function recover(config, identity, digest, supplied, signature, message) {
  if (!committee(config, message).validators.includes(identity)) throw new ViewChangeError("UNKNOWN_VALIDATOR");
  if (normalizeBytes32(supplied) !== digest) throw new ViewChangeError("INVALID_DIGEST");
  try {
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature) ||
        normalizeAddress(await recoverMessageAddress({ message: { raw: digest }, signature })) !== identity) throw new Error("signer");
  } catch { throw new ViewChangeError("INVALID_SIGNATURE"); }
}
export function viewChangeDigest(input) {
  const c = context(input, "VIEW_CHANGE");
  return versionedDigest(VIEW_CHANGE_TYPE, ["uint8","uint256","address","uint256","uint256","address","bytes32","bytes32"],
    [ Number(c.protocolVersion), BigInt(c.sourceDomain), c.sourceGateway, BigInt(c.epoch),
      protocolInteger(input.targetView), normalizeAddress(input.voterIdentity), input.acceptedProposal?.proposalDigest ?? ZERO,
      preparedCertificateDigest(input.preparedCertificate)], input);
}
export async function authenticateViewChange(config, input) {
  strictFields(input, envelopeFields(VIEW_CHANGE_FIELDS, input?.protocolVersion));
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
  if (message.protocolVersion === "3") {
    for (const evidence of [message.acceptedProposal, message.preparedCertificate?.proposal].filter(Boolean)) {
      if (evidence.protocolVersion !== "3" || evidence.validatorEpoch !== message.validatorEpoch || evidence.committeeDigest !== message.committeeDigest) throw new ViewChangeError("WRONG_VALIDATOR_EPOCH");
    }
  }
  const digest = viewChangeDigest(message);
  await recover(config, message.voterIdentity, digest, input.viewChangeDigest, input.signature, message);
  return { ...message, viewChangeDigest: digest, signature: input.signature.toLowerCase() };
}
export async function signViewChange(config, input) {
  // Authenticate and normalize nested evidence before hashing or signing it.
  // Invalid quorums must fail at certificate validation, not ABI encoding.
  const preparedCertificate = input.preparedCertificate === null ? null
    : await verifyPreparedCertificate(input.preparedCertificate, config);
  const version = input.protocolVersion ?? CONSENSUS_VERSION;
  const message = { ...(version === "3" ? consensusBinding(config, input.epoch) : {}), ...input, messageType: "VIEW_CHANGE", protocolVersion: version,
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
  return versionedDigest(NEW_VIEW_TYPE, ["uint8","uint256","address","uint256","uint256","address","bytes32","bytes32","bytes32[]"],
    [ Number(c.protocolVersion), BigInt(c.sourceDomain), c.sourceGateway, BigInt(c.epoch), protocolInteger(input.view),
      normalizeAddress(input.primaryIdentity), normalizeBytes32(input.selectedProposal.batchId), normalizeBytes32(input.selectedProposal.messageRoot),
      input.viewChanges.map((vote) => vote.viewChangeDigest)], input);
}
export async function authenticateNewView(config, input, pendingProposal) {
  strictFields(input, envelopeFields(NEW_VIEW_FIELDS, input?.protocolVersion));
  if (input.messageType !== "NEW_VIEW") throw new ViewChangeError("MALFORMED_VIEW_MESSAGE");
  const message = { ...context(input, "NEW_VIEW"), view: protocolInteger(input.view).toString(),
    primaryIdentity: normalizeAddress(input.primaryIdentity) };
  checkContext(config, message);
  if (BigInt(message.view) === 0n || deterministicPrimary(committee(config, message).validators, message.epoch, message.view) !== message.primaryIdentity) throw new ViewChangeError("WRONG_PRIMARY");
  strictFields(input.selectedProposal, ["sourceDomain", "sourceGateway", "epoch", "batchId", "messageRoot", ...(message.protocolVersion === "3" ? ["validatorEpoch", "committeeDigest"] : [])]);
  const selected = { sourceDomain: protocolInteger(input.selectedProposal.sourceDomain).toString(),
    sourceGateway: normalizeAddress(input.selectedProposal.sourceGateway), epoch: protocolInteger(input.selectedProposal.epoch).toString(),
    ...validatorFields({ ...input.selectedProposal, protocolVersion: message.protocolVersion }), batchId: normalizeBytes32(input.selectedProposal.batchId), messageRoot: normalizeBytes32(input.selectedProposal.messageRoot) };
  if (selected.epoch !== message.epoch || selected.sourceDomain !== message.sourceDomain || selected.sourceGateway !== message.sourceGateway) throw new ViewChangeError("WRONG_SELECTED_CONTEXT");
  const ordered = canonicalEvidence(input.viewChanges, "voterIdentity");
  if (input.viewChanges.some((vote, index) => vote.voterIdentity !== ordered[index].voterIdentity)) throw new ViewChangeError("NONCANONICAL_EVIDENCE");
  const viewChanges = [];
  for (const evidence of ordered) {
    const vote = await authenticateViewChange(config, evidence);
    if (vote.epoch !== message.epoch || vote.targetView !== message.view || vote.protocolVersion !== message.protocolVersion || vote.validatorEpoch !== message.validatorEpoch || vote.committeeDigest !== message.committeeDigest) throw new ViewChangeError("WRONG_TARGET_VIEW");
    viewChanges.push(vote);
  }
  const safe = selectSafeProposal(viewChanges, pendingProposal);
  if (!sameProposal(selected, safe) || (pendingProposal && !sameProposal(selected, pendingProposal))) throw new ViewChangeError("UNSAFE_SELECTED_PROPOSAL");
  const result = { ...message, selectedProposal: selected, viewChanges };
  const digest = newViewDigest(result);
  await recover(config, message.primaryIdentity, digest, input.newViewDigest, input.signature, message);
  return { ...result, newViewDigest: digest, signature: input.signature.toLowerCase() };
}
export async function signNewView(config, input, pendingProposal) {
  const viewChanges = canonicalEvidence(input.viewChanges, "voterIdentity");
  const version = input.protocolVersion ?? viewChanges[0].protocolVersion;
  const message = { ...(version === "3" ? consensusBinding(config, input.epoch) : {}), ...input, messageType: "NEW_VIEW", protocolVersion: version,
    sourceDomain: config.chainDomain.toString(), sourceGateway: config.sourceGateway, primaryIdentity: config.validatorAddress, viewChanges };
  const digest = newViewDigest(message);
  return authenticateNewView(config, { ...message, newViewDigest: digest,
    signature: await validatorAccount(config.privateKey).signMessage({ message: { raw: digest } }) }, pendingProposal);
}
