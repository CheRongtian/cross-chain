// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Canonical cross-chain message definition and identity encoding.
/// @dev Epoch and status are operational lifecycle fields. They are assigned
///      outside this model and must never be included in a message ID.
library MessageCodec {
    /// @notice Protocol inputs from which payloadHash and messageId are derived.
    struct Message {
        uint8 version;
        uint256 sourceDomain;
        address sourceGateway;
        address sourceSender;
        uint256 destinationDomain;
        address destinationReceiver;
        uint256 nonce;
        bytes payload;
    }

    function hashPayload(bytes memory payload) internal pure returns (bytes32) {
        // Keep the protocol definition expressed directly as keccak256(payload).
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(payload);
    }

    /// @notice Computes a message ID from already-hashed payload bytes.
    /// @dev The field order and types in this abi.encode call are protocol-level
    ///      canonical encoding and must remain identical across implementations.
    function computeMessageId(
        uint8 version,
        uint256 sourceDomain,
        address sourceGateway,
        address sourceSender,
        uint256 destinationDomain,
        address destinationReceiver,
        uint256 nonce,
        bytes32 payloadHash
    ) internal pure returns (bytes32) {
        bytes memory encodedMessage = abi.encode(
            version,
            sourceDomain,
            sourceGateway,
            sourceSender,
            destinationDomain,
            destinationReceiver,
            nonce,
            payloadHash
        );

        // abi.encode above is the canonical, cross-language protocol encoding.
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(encodedMessage);
    }

    function computeMessageId(Message memory message) internal pure returns (bytes32) {
        return computeMessageId(
            message.version,
            message.sourceDomain,
            message.sourceGateway,
            message.sourceSender,
            message.destinationDomain,
            message.destinationReceiver,
            message.nonce,
            hashPayload(message.payload)
        );
    }
}
