import { encodeAbiParameters } from "viem";
import { QC_PARAMETERS, QC_STATEMENT_PARAMETERS } from "../../../indexer/src/relayer/encoding.mjs";

// Verification tooling uses the existing transport schema; production serialization is unchanged.
export function encodeCertificate(q) {
  const fields = [BigInt(q.sourceDomain), q.sourceGateway, BigInt(q.epoch),
    ...(q.protocolVersion !== "1" ? [BigInt(q.view)] : []), q.batchId, q.messageRoot,
    q.proposalDigest, q.committeeDigest,
    ...(q.protocolVersion === "3" ? [BigInt(q.validatorEpoch)] : [])];
  return encodeAbiParameters(QC_PARAMETERS, [Number(q.protocolVersion),
    encodeAbiParameters(QC_STATEMENT_PARAMETERS[q.protocolVersion], fields), q.qcDigest,
    q.commits.map(({ voterIdentity, commitDigest, signature }) => ({ voterIdentity, commitDigest, signature }))]);
}

export function solidityContext(expected) {
  // Solidity reserves "view"; only the contract ABI object key uses viewNumber.
  return { protocolVersion: Number(expected.protocolVersion), sourceDomain: BigInt(expected.sourceDomain),
    sourceGateway: expected.sourceGateway, batchEpoch: BigInt(expected.batchEpoch), viewNumber: BigInt(expected.view),
    batchId: expected.batchId, messageRoot: expected.messageRoot, authorityEpoch: BigInt(expected.authorityEpoch) };
}

export function consensusContext(expected) {
  return { protocolVersion: expected.protocolVersion, sourceDomain: expected.sourceDomain,
    sourceGateway: expected.sourceGateway, epoch: expected.batchEpoch, view: expected.view,
    batchId: expected.batchId, messageRoot: expected.messageRoot,
    ...(expected.protocolVersion === "3" ? { validatorEpoch: expected.authorityEpoch } : {}) };
}

// Version and authority are pinned batch metadata. The QC contributes the certified view only.
export function snapshotContext(snapshot) {
  if (!snapshot.consensusBinding || snapshot.consensusBinding.protocolVersion !== "3") {
    throw new Error("Rotation verification requires the persisted v3 consensus binding");
  }
  const record = snapshot.record;
  return { protocolVersion: snapshot.consensusBinding.protocolVersion, sourceDomain: record.sourceDomain,
    sourceGateway: record.sourceGateway, batchEpoch: record.epoch, view: snapshot.quorumCertificate.view,
    batchId: record.batchId, messageRoot: record.messageRoot,
    authorityEpoch: snapshot.consensusBinding.validatorEpoch };
}
