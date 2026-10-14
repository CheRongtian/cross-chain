// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

bytes32 constant MESSAGE_MERKLE_LEAF_DOMAIN =
    keccak256("MessageMerkleLeaf(bytes32 batchId,uint256 index,bytes32 messageId)");
bytes32 constant MESSAGE_MERKLE_NODE_DOMAIN =
    keccak256("MessageMerkleNode(bytes32 leftChild,bytes32 rightChild)");

/// @notice Ordered message commitments shared with the off-chain batch processor.
/// @dev This primitive supplies no consensus or destination authorization.
library MessageMerkle {
    error EmptyMerkleTree();
    error ProofBatchIdMismatch(bytes32 expected, bytes32 actual);
    error ProofMessageIdMismatch(bytes32 expected, bytes32 actual);
    error ProofLeafCountMismatch(uint256 expected, uint256 actual);
    error ProofIndexOutOfBounds(uint256 index, uint256 leafCount);
    error InvalidProofLength(uint256 expected, uint256 actual);
    error InvalidOddSibling(uint256 level, bytes32 expected, bytes32 actual);
    error MerkleRootMismatch(bytes32 expected, bytes32 actual);

    enum Failure {
        NONE,
        EMPTY_TREE,
        BATCH_ID,
        MESSAGE_ID,
        LEAF_COUNT,
        INDEX,
        PATH_LENGTH,
        ODD_SIBLING,
        ROOT
    }

    struct Proof {
        bytes32 batchId;
        bytes32 messageId;
        uint256 index;
        uint256 leafCount;
        bytes32[] siblings;
    }

    /// @dev Inputs are already canonical protocol identifiers.
    function computeLeaf(bytes32 batchId, uint256 index, bytes32 messageId) internal pure returns (bytes32) {
        // Keep the exact canonical ABI encoding visible; assembly gas optimization is unnecessary here.
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(abi.encode(MESSAGE_MERKLE_LEAF_DOMAIN, batchId, index, messageId));
    }

    function hashNode(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        // Preserve the readable ordered ABI preimage shared with the off-chain implementation.
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(abi.encode(MESSAGE_MERKLE_NODE_DOMAIN, left, right));
    }

    /// @dev Expected context must come from a trusted snapshot, independently of the proof.
    ///      Root/path alone cannot distinguish every leaf-count change (e.g. some 3/4-leaf paths).
    function verifyProof(
        bytes32 expectedBatchId,
        bytes32 expectedMessageId,
        uint256 expectedLeafCount,
        bytes32 expectedRoot,
        Proof memory proof
    ) internal pure returns (bool) {
        (Failure failure,,) = _checkProof(expectedBatchId, expectedMessageId, expectedLeafCount, expectedRoot, proof);
        return failure == Failure.NONE;
    }

    /// @dev Uses the same verification kernel as the boolean API; the path is folded only once.
    // Retain the revert-based library API without duplicating traversal or moving error handling into callers.
    // forge-lint: disable-next-item(internal-function-used-once)
    function requireProof(
        bytes32 expectedBatchId,
        bytes32 expectedMessageId,
        uint256 expectedLeafCount,
        bytes32 expectedRoot,
        Proof memory proof
    ) internal pure {
        (Failure failure, uint256 detail, bytes32 node) =
            _checkProof(expectedBatchId, expectedMessageId, expectedLeafCount, expectedRoot, proof);
        if (failure == Failure.NONE) return;
        if (failure == Failure.EMPTY_TREE) revert EmptyMerkleTree();
        if (failure == Failure.BATCH_ID) revert ProofBatchIdMismatch(expectedBatchId, proof.batchId);
        if (failure == Failure.MESSAGE_ID) revert ProofMessageIdMismatch(expectedMessageId, proof.messageId);
        if (failure == Failure.LEAF_COUNT) revert ProofLeafCountMismatch(expectedLeafCount, proof.leafCount);
        if (failure == Failure.INDEX) revert ProofIndexOutOfBounds(proof.index, expectedLeafCount);
        if (failure == Failure.PATH_LENGTH) revert InvalidProofLength(detail, proof.siblings.length);
        if (failure == Failure.ODD_SIBLING) revert InvalidOddSibling(detail, node, proof.siblings[detail]);
        revert MerkleRootMismatch(expectedRoot, node);
    }

    // Distinct metadata/structure/odd-sibling guards preserve precise failure context in one shared kernel.
    // Keeping them with the single path fold prevents divergence between boolean and revert-based verification.
    // forge-lint: disable-next-item(cyclomatic-complexity)
    function _checkProof(
        bytes32 expectedBatchId,
        bytes32 expectedMessageId,
        uint256 expectedLeafCount,
        bytes32 expectedRoot,
        Proof memory proof
    ) private pure returns (Failure, uint256, bytes32) {
        if (expectedLeafCount == 0) return (Failure.EMPTY_TREE, 0, 0);
        if (proof.batchId != expectedBatchId) return (Failure.BATCH_ID, 0, 0);
        if (proof.messageId != expectedMessageId) return (Failure.MESSAGE_ID, 0, 0);
        if (proof.leafCount != expectedLeafCount) return (Failure.LEAF_COUNT, 0, 0);
        if (proof.index >= expectedLeafCount) return (Failure.INDEX, 0, 0);

        uint256 depth = 0;
        for (
            uint256 remainingWidth = expectedLeafCount;
            remainingWidth > 1;
            remainingWidth = remainingWidth / 2 + remainingWidth % 2
        ) {
            depth++;
        }
        if (proof.siblings.length != depth) return (Failure.PATH_LENGTH, depth, 0);

        bytes32 node = computeLeaf(expectedBatchId, proof.index, expectedMessageId);
        uint256 position = proof.index;
        uint256 width = expectedLeafCount;
        for (uint256 level = 0; level < depth; level++) {
            bytes32 sibling = proof.siblings[level];
            if (position % 2 == 0) {
                if (position == width - 1 && sibling != node) return (Failure.ODD_SIBLING, level, node);
                node = hashNode(node, sibling);
            } else {
                node = hashNode(sibling, node);
            }
            position /= 2;
            width = width / 2 + width % 2;
        }
        return (node == expectedRoot ? Failure.NONE : Failure.ROOT, 0, node);
    }
}
