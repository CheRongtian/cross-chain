import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from "viem";
import { protocolInteger } from "./committee.mjs";

export const CONSENSUS_VERSION = "2";

// Version 1 is retained solely for historical evidence. Its bytes never acquire a view.
export function viewFields(input) {
  if (String(input.protocolVersion) === "1") {
    if (input.view !== undefined && protocolInteger(input.view, "view") !== 0n) throw new Error("legacy view must be zero");
    return {};
  }
  return { view: protocolInteger(input.view, "view").toString() };
}

export function consensusDigest(type, parameters, values, version) {
  if (version === "1") {
    type = type.replace(",uint256 view", "");
    parameters = [...parameters]; values = [...values];
    parameters.splice(4, 1); values.splice(4, 1);
  }
  const domain = keccak256(stringToHex(type));
  return keccak256(encodeAbiParameters(parseAbiParameters(["bytes32", ...parameters].join(",")), [domain, ...values]));
}
