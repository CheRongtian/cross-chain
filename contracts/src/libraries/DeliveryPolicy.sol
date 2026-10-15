// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Operational limits; these values never enter a protocol hash preimage.
/// @dev Mirrored by test-vectors/delivery-policy.json and checked across languages.
library DeliveryPolicy {
    uint256 internal constant MAX_PAYLOAD_BYTES = 4096;
    uint256 internal constant MAX_BATCH_MESSAGES = 128;
    uint256 internal constant MAX_PACKAGE_BYTES = 11232;
    uint256 internal constant MAX_JOB_ID_BYTES = 192;
    uint256 internal constant MAX_MERKLE_DEPTH = 7;
}
