import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from "viem";
import { protocolInteger } from "./committee.mjs";
import { normalizeBytes32 } from "../../indexer/src/canonical-message.mjs";

export const CONSENSUS_VERSION = "3";

export function validatorFields(input) {
  if (String(input.protocolVersion) !== "3") return {};
  return { validatorEpoch: protocolInteger(input.validatorEpoch, "validator epoch").toString(),
    committeeDigest: normalizeBytes32(input.committeeDigest, "committee digest") };
}

export function envelopeFields(fields, version, { hasCommittee = false } = {}) {
  version = String(version);
  return fields.filter((field) => (field !== "view" || version !== "1") &&
    (field !== "validatorEpoch" || !["1", "2"].includes(version)) && (field !== "committeeDigest" || hasCommittee || !["1", "2"].includes(version)));
}

// Version 1 is retained solely for historical evidence. Its bytes never acquire a view.
export function viewFields(input) {
  if (String(input.protocolVersion) === "1") {
    if (input.view !== undefined && protocolInteger(input.view, "view") !== 0n) throw new Error("legacy view must be zero");
    return {};
  }
  return { view: protocolInteger(input.view, "view").toString() };
}

export function consensusDigest(type, parameters, values, version) {
  if (String(version) === "3") throw new Error("version-three digests require a validator epoch context");
  if (version === "1") {
    type = type.replace(",uint256 view", "");
    parameters = [...parameters]; values = [...values];
    parameters.splice(4, 1); values.splice(4, 1);
  }
  const domain = keccak256(stringToHex(type));
  return keccak256(encodeAbiParameters(parseAbiParameters(["bytes32", ...parameters].join(",")), [domain, ...values]));
}

// Append the new signed fields only for v3. Old v1/v2 type domains and ABI bytes
// remain untouched, including the pre-existing COMMIT/QC committeeDigest field.
export function versionedDigest(type, parameters, values, input, { hasCommittee = false } = {}) {
  if (String(input.protocolVersion) !== "3") {
    const legacyType = type.replace(",uint256 validatorEpoch", "");
    return consensusDigest(hasCommittee ? legacyType : legacyType.replace(",bytes32 committeeDigest", ""), parameters, values, String(input.protocolVersion));
  }
  const fields = validatorFields(input);
  const domain = keccak256(stringToHex(type));
  const extraParameters = hasCommittee ? ["uint256"] : ["uint256", "bytes32"];
  const extraValues = hasCommittee ? [BigInt(fields.validatorEpoch)] : [BigInt(fields.validatorEpoch), fields.committeeDigest];
  return keccak256(encodeAbiParameters(parseAbiParameters(["bytes32", ...parameters, ...extraParameters].join(",")),
    [domain, ...values, ...extraValues]));
}

export function consensusType(legacyType, { hasCommittee = false } = {}) {
  return legacyType.slice(0,-1) + (hasCommittee ? ",uint256 validatorEpoch)" : ",uint256 validatorEpoch,bytes32 committeeDigest)");
}
