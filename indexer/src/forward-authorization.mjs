import { encodeAbiParameters,keccak256,parseAbiParameters,stringToHex } from "viem";
import { computePayloadHash,normalizeAddress,normalizeBytes32,toUint256 } from "./canonical-message.mjs";

export const FORWARD_AUTHORIZATION_TYPE =
  "ForwardAuthorizationIntent(uint8 protocolVersion,uint256 action,uint256 sourceDomain,address application,address sourceGateway,uint256 destinationDomain,address destinationGateway,address destinationReceiver,bytes32 payloadHash,uint256 deadline,address authorizedExecutor)";
export const FORWARD_AUTHORIZATION_TYPEHASH = keccak256(stringToHex(FORWARD_AUTHORIZATION_TYPE));
export const FORWARD_MESSAGE_VERSION = 2n;
export const ACTION_FORWARD_MESSAGE = 3n;
export const CREDENTIAL_PUBLIC_SIGNAL_ORDER = Object.freeze([
  "credentialCommitment","trustedIssuer","requiredRole","currentTimestamp","credentialStateRoot",
  "applicationDomain","policyEpoch","actionContext","nullifier","forwardIntentDigestHi","forwardIntentDigestLo",
  "authorizationValidUntil",
]);
export const AUTHORIZATION_VALID_UNTIL_INDEX = CREDENTIAL_PUBLIC_SIGNAL_ORDER.indexOf("authorizationValidUntil");
const PARAMETERS = parseAbiParameters("bytes32,uint8,uint256,uint256,address,address,uint256,address,address,bytes32,uint256,address");

function exactUint(value,label) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("unsafe " + label);
  return toUint256(value,label);
}

export function normalizeForwardIntent(intent) {
  const protocolVersion = exactUint(intent.protocolVersion,"forward version");
  if (protocolVersion > 255n) throw new Error("invalid forward version");
  const payloadHash = intent.payload === undefined ? normalizeBytes32(intent.payloadHash,"forward payload hash") : computePayloadHash(intent.payload);
  if (intent.payloadHash !== undefined && normalizeBytes32(intent.payloadHash) !== payloadHash) throw new Error("forward payload hash mismatch");
  return {
    protocolVersion,action: exactUint(intent.action,"forward action"),sourceDomain: exactUint(intent.sourceDomain,"source domain"),
    application: normalizeAddress(intent.application),sourceGateway: normalizeAddress(intent.sourceGateway),
    destinationDomain: exactUint(intent.destinationDomain,"destination domain"),
    destinationGateway: normalizeAddress(intent.destinationGateway),destinationReceiver: normalizeAddress(intent.destinationReceiver),
    payloadHash,deadline: exactUint(intent.deadline,"deadline"),authorizedExecutor: normalizeAddress(intent.authorizedExecutor),
  };
}

export function encodeForwardIntent(intent) {
  const value = normalizeForwardIntent(intent);
  return encodeAbiParameters(PARAMETERS,[FORWARD_AUTHORIZATION_TYPEHASH,Number(value.protocolVersion),value.action,value.sourceDomain,
    value.application,value.sourceGateway,value.destinationDomain,value.destinationGateway,value.destinationReceiver,
    value.payloadHash,value.deadline,value.authorizedExecutor]);
}

export function computeForwardIntentDigest(intent) { return keccak256(encodeForwardIntent(intent)); }
export function splitForwardIntentDigest(digest) {
  const value = BigInt(normalizeBytes32(digest,"forward intent digest"));
  return Object.freeze({ forwardIntentDigestHi: value >> 128n,forwardIntentDigestLo: value & ((1n << 128n) - 1n) });
}
