import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbiParameters, parseAbi } from "viem";
import { verifyDeliveryPackage } from "../delivery/package.mjs";
import { DELIVERY_POLICY, requireDeliveryBounds } from "../delivery/policy.mjs";

export const DESTINATION_SUBMISSION_VERSION = 1;
export const DESTINATION_SUBMISSION_DOMAIN = "CrossChainDeliveryPackage";
export const MESSAGE_PARAMETERS = parseAbiParameters("uint8,uint256,address,address,uint256,address,address,uint256,bytes,bytes32,uint256,bytes32");
export const BATCH_PARAMETERS = parseAbiParameters("uint8,uint256,bytes32,bytes32[]");
const LEGACY_STATEMENT = "uint256,address,uint256,bytes32,bytes32,bytes32,bytes32";
const VIEW_STATEMENT = "uint256,address,uint256,uint256,bytes32,bytes32,bytes32,bytes32";
export const QC_STATEMENT_PARAMETERS = Object.freeze({
  "1": parseAbiParameters(LEGACY_STATEMENT),
  "2": parseAbiParameters(VIEW_STATEMENT),
  "3": parseAbiParameters(`${VIEW_STATEMENT},uint256`),
});
export const QC_PARAMETERS = parseAbiParameters("uint8,bytes,bytes32,(address voterIdentity,bytes32 commitDigest,bytes signature)[]");
export const ENVELOPE_PARAMETERS = parseAbiParameters("string,uint8,string,bytes,bytes,uint256,uint256,bytes32,bytes32[],bytes");
export const DESTINATION_GATEWAY_ABI = parseAbi(["function execute(bytes packageBytes)"]);

// Transport encoding only. Existing message/batch/Merkle/PBFT digests are unchanged.
export async function encodeDestinationSubmission(input,options) {
  const pack = await verifyDeliveryPackage(input,options);
  const m = pack.message;
  const messageBytes = encodeAbiParameters(MESSAGE_PARAMETERS,[Number(m.version),BigInt(m.sourceDomain),m.sourceGateway,
    m.sourceSender,BigInt(m.destinationDomain),m.destinationGateway,m.destinationReceiver,BigInt(m.nonce),m.payload,
    m.payloadHash,BigInt(m.deadline),m.messageId]);
  const batchBytes = encodeAbiParameters(BATCH_PARAMETERS,[Number(pack.batchVersion),BigInt(pack.batchEpoch),pack.batchId,pack.batchMessageIds]);
  const q = pack.quorumCertificate;
  const statement = [BigInt(q.sourceDomain),q.sourceGateway,BigInt(q.epoch),
    ...(q.protocolVersion !== "1" ? [BigInt(q.view)] : []),q.batchId,q.messageRoot,q.proposalDigest,q.committeeDigest,
    ...(q.protocolVersion === "3" ? [BigInt(q.validatorEpoch)] : [])];
  const statementBytes = encodeAbiParameters(QC_STATEMENT_PARAMETERS[q.protocolVersion],statement);
  const qcBytes = encodeAbiParameters(QC_PARAMETERS,[Number(q.protocolVersion),statementBytes,q.qcDigest,
    q.commits.map((vote) => ({ voterIdentity: vote.voterIdentity,commitDigest: vote.commitDigest,signature: vote.signature }))]);
  const data = encodeAbiParameters(ENVELOPE_PARAMETERS,[DESTINATION_SUBMISSION_DOMAIN,DESTINATION_SUBMISSION_VERSION,
    pack.deliveryJobId,messageBytes,batchBytes,BigInt(pack.messageIndex),BigInt(pack.leafCount),pack.messageRoot,
    pack.merkleProof.siblings,qcBytes]);
  // Comparing this digest avoids storing/comparing full ABI payloads in submission rows.
  return Object.freeze({ data,packageDigest: keccak256(data).toLowerCase(),package: pack });
}

// One production entry format. The transport-v1 bytes and their existing digest remain unchanged.
export async function encodeGatewaySubmission(input, options) {
  requireDeliveryBounds(input);
  const encoded = await encodeDestinationSubmission(input, options);
  if ((encoded.data.length - 2) / 2 > DELIVERY_POLICY.maxPackageBytes) throw new Error("PACKAGE_LIMIT_EXCEEDED");
  return Object.freeze({ ...encoded, calldata: encodeFunctionData({ abi: DESTINATION_GATEWAY_ABI,
    functionName: "execute", args: [encoded.data] }) });
}
