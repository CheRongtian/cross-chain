// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageMerkle} from "./MessageMerkle.sol";
import {MessageBatchCodec} from "./libraries/MessageBatchCodec.sol";

/// @notice Stateless ordered membership verification under independently trusted batch/root expectations.
/// @dev This does not authenticate a QC, validate complete message fields, consume or execute messages.
contract MerkleInclusionVerifier {
    struct BatchContext {
        uint8 version;
        uint256 sourceDomain;
        address sourceGateway;
        uint256 epoch;
        bytes32 batchId;
    }

    error BatchIdMismatch(bytes32 expected, bytes32 actual);
    error MessageIndexOutOfBounds(uint256 index, uint256 leafCount);
    error MemberMessageIdMismatch(uint256 index, bytes32 expected, bytes32 actual);
    error ProofIndexMismatch(uint256 expected, uint256 actual);

    function verifyInclusion(
        BatchContext calldata expectedBatch,
        bytes32 expectedRoot,
        bytes32 expectedMessageId,
        uint256 expectedIndex,
        bytes32[] calldata orderedMessageIds,
        MessageMerkle.Proof calldata proof
    ) external pure returns (bool) {
        bytes32 actualBatchId = MessageBatchCodec.computeBatchId(
            expectedBatch.version,
            expectedBatch.sourceDomain,
            expectedBatch.sourceGateway,
            expectedBatch.epoch,
            orderedMessageIds
        );
        if (actualBatchId != expectedBatch.batchId) revert BatchIdMismatch(expectedBatch.batchId, actualBatchId);
        uint256 count = orderedMessageIds.length;
        if (expectedIndex >= count) revert MessageIndexOutOfBounds(expectedIndex, count);
        if (orderedMessageIds[expectedIndex] != expectedMessageId) {
            revert MemberMessageIdMismatch(expectedIndex, expectedMessageId, orderedMessageIds[expectedIndex]);
        }
        if (proof.index != expectedIndex) revert ProofIndexMismatch(expectedIndex, proof.index);
        MessageMerkle.requireProof(expectedBatch.batchId, expectedMessageId, count, expectedRoot, proof);
        return true;
    }

    function computeBatchId(
        uint8 version,
        uint256 sourceDomain,
        address sourceGateway,
        uint256 epoch,
        bytes32[] calldata orderedMessageIds
    ) external pure returns (bytes32) {
        return MessageBatchCodec.computeBatchId(version, sourceDomain, sourceGateway, epoch, orderedMessageIds);
    }

    function computeLeaf(bytes32 batchId, uint256 index, bytes32 messageId) external pure returns (bytes32) {
        return MessageMerkle.computeLeaf(batchId, index, messageId);
    }

    function hashNode(bytes32 left, bytes32 right) external pure returns (bytes32) {
        return MessageMerkle.hashNode(left, right);
    }
}
