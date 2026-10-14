// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Canonical batch commitment encoding shared with message-batch.mjs.
library MessageBatchCodec {
    bytes32 internal constant TYPEHASH =
        keccak256("MessageBatch(uint8 version,uint256 sourceDomain,address sourceGateway,uint256 epoch,bytes32[] messageIds)");

    error UnsupportedBatchVersion(uint8 version);
    error EmptyMessageBatch();
    error DuplicateMessageId(bytes32 messageId);

    function computeBatchId(
        uint8 version,
        uint256 sourceDomain,
        address sourceGateway,
        uint256 epoch,
        bytes32[] calldata orderedMessageIds
    ) internal pure returns (bytes32) {
        if (version != 1) revert UnsupportedBatchVersion(version);
        if (orderedMessageIds.length == 0) revert EmptyMessageBatch();
        _requireUnique(orderedMessageIds);
        // Dynamic ordered membership must retain the existing canonical ABI preimage.
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(abi.encode(TYPEHASH, version, sourceDomain, sourceGateway, epoch, orderedMessageIds));
    }

    /// @dev Sort one scratch copy in O(N log N) to detect duplicates. The committed order is untouched.
    function _requireUnique(bytes32[] calldata orderedMessageIds) private pure {
        bytes32[] memory scratch = orderedMessageIds;
        uint256 count = scratch.length;
        for (uint256 root = count / 2; root > 0; root--) {
            _siftDown(scratch, root - 1, count);
        }
        for (uint256 length = count; length > 1; length--) {
            (scratch[0], scratch[length - 1]) = (scratch[length - 1], scratch[0]);
            _siftDown(scratch, 0, length - 1);
        }
        for (uint256 index = 1; index < count; index++) {
            // Stop at the first duplicate; continuing this scratch-array scan cannot validate the batch.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (scratch[index] == scratch[index - 1]) revert DuplicateMessageId(scratch[index]);
        }
    }

    function _siftDown(bytes32[] memory values, uint256 root, uint256 length) private pure {
        // A parent exists only in this half; child arithmetic stays within the allocated array.
        while (root < length / 2) {
            uint256 child = root * 2 + 1;
            if (child + 1 < length && values[child] < values[child + 1]) child++;
            if (values[root] >= values[child]) return;
            (values[root], values[child]) = (values[child], values[root]);
            root = child;
        }
    }
}
