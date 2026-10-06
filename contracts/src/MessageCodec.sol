// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Protocol-level schema separator for canonical cross-chain messages.
bytes32 constant CROSS_CHAIN_MESSAGE_TYPEHASH = keccak256(
    "CrossChainMessage(uint8 version,uint256 sourceDomain,address sourceGateway,address sourceSender,uint256 destinationDomain,address destinationGateway,address destinationReceiver,uint256 nonce,bytes32 payloadHash,uint256 deadline)"
);

/// @notice Canonical encoding for source-chain cross-chain messages.
library MessageCodec {
    struct CanonicalMessage {
        uint8 version;
        uint256 sourceDomain;
        address sourceGateway;
        address sourceSender;
        uint256 destinationDomain;
        address destinationGateway;
        address destinationReceiver;
        uint256 nonce;
        bytes32 payloadHash;
        uint256 deadline;
    }

    function computeMessageId(CanonicalMessage memory message) internal pure returns (bytes32 messageId) {
        bytes memory encodedMessage = abi.encode(
            CROSS_CHAIN_MESSAGE_TYPEHASH,
            message.version,
            message.sourceDomain,
            message.sourceGateway,
            message.sourceSender,
            message.destinationDomain,
            message.destinationGateway,
            message.destinationReceiver,
            message.nonce,
            message.payloadHash,
            message.deadline
        );

        // Hashes the exact ABI byte sequence constructed above.
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") {
            messageId := keccak256(add(encodedMessage, 0x20), mload(encodedMessage))
        }
    }
}
