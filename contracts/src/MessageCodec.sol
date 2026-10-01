// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Canonical encoding for source-chain cross-chain messages.
library MessageCodec {
    struct CanonicalMessage {
        uint8 version;
        uint256 sourceDomain;
        address sourceGateway;
        address sourceSender;
        uint256 destinationDomain;
        address destinationReceiver;
        uint256 nonce;
        bytes32 payloadHash;
        uint256 deadline;
    }

    function computeMessageId(CanonicalMessage memory message) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                message.version,
                message.sourceDomain,
                message.sourceGateway,
                message.sourceSender,
                message.destinationDomain,
                message.destinationReceiver,
                message.nonce,
                message.payloadHash,
                message.deadline
            )
        );
    }
}
