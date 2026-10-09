// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

bytes32 constant MESSAGE_MERKLE_LEAF_DOMAIN =
    keccak256("MessageMerkleLeaf(bytes32 batchId,uint256 index,bytes32 messageId)");
bytes32 constant MESSAGE_MERKLE_NODE_DOMAIN =
    keccak256("MessageMerkleNode(bytes32 leftChild,bytes32 rightChild)");

/// @notice Ordered message commitments shared with the off-chain batch processor.
/// @dev This primitive supplies no consensus or destination authorization.
library MessageMerkle {
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
        if (
            expectedLeafCount == 0 || proof.leafCount != expectedLeafCount || proof.index >= expectedLeafCount
                || proof.batchId != expectedBatchId || proof.messageId != expectedMessageId
        ) return false;

        uint256 depth = 0;
        for (
            uint256 remainingWidth = expectedLeafCount;
            remainingWidth > 1;
            remainingWidth = remainingWidth / 2 + remainingWidth % 2
        ) {
            depth++;
        }
        if (proof.siblings.length != depth) return false;

        bytes32 node = computeLeaf(expectedBatchId, proof.index, expectedMessageId);
        uint256 position = proof.index;
        uint256 width = expectedLeafCount;
        for (uint256 level = 0; level < depth; level++) {
            bytes32 sibling = proof.siblings[level];
            if (position % 2 == 0) {
                if (position == width - 1 && sibling != node) return false;
                node = hashNode(node, sibling);
            } else {
                node = hashNode(sibling, node);
            }
            position /= 2;
            width = width / 2 + width % 2;
        }
        return node == expectedRoot;
    }
}
