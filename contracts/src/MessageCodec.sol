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

    function computeMessageId(CanonicalMessage memory message) internal pure returns (bytes32) {
        // Canonical ABI encoding is shared with the off-chain vector generator.
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(
            abi.encode(
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
            )
        );
    }
}
