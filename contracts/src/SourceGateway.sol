// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISourceGateway} from "./interfaces/ISourceGateway.sol";
import {MessageCodec} from "./MessageCodec.sol";

/// @notice Creates canonical outbound messages on the source chain.
contract SourceGateway is ISourceGateway {
    uint8 public constant MESSAGE_VERSION = 2;

    uint256 public nextNonce = 1;

    error InvalidDestinationDomain();
    error InvalidDestinationReceiver();
    error InvalidDeadline();

    event CrossChainMessage(
        bytes32 indexed messageId,
        uint8 version,
        uint256 sourceDomain,
        address sourceGateway,
        address indexed sourceSender,
        uint256 indexed destinationDomain,
        address destinationReceiver,
        uint256 nonce,
        bytes payload,
        uint256 deadline
    );

    function sendMessage(
        uint256 destinationDomain,
        address destinationReceiver,
        bytes calldata payload,
        uint256 deadline
    ) external returns (bytes32 messageId, uint256 nonce) {
        if (destinationDomain == 0 || destinationDomain == block.chainid) {
            revert InvalidDestinationDomain();
        }
        if (destinationReceiver == address(0)) {
            revert InvalidDestinationReceiver();
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (deadline <= block.timestamp) {
            revert InvalidDeadline();
        }

        nonce = nextNonce;
        nextNonce = nonce + 1;
        messageId = computeMessageId(
            msg.sender,
            destinationDomain,
            destinationReceiver,
            nonce,
            keccak256(payload),
            deadline
        );

        emit CrossChainMessage(
            messageId,
            MESSAGE_VERSION,
            block.chainid,
            address(this),
            msg.sender,
            destinationDomain,
            destinationReceiver,
            nonce,
            payload,
            deadline
        );
    }

    function computeMessageId(
        address sourceSender,
        uint256 destinationDomain,
        address destinationReceiver,
        uint256 nonce,
        bytes32 payloadHash,
        uint256 deadline
    ) public view returns (bytes32) {
        return MessageCodec.computeMessageId(
            MessageCodec.CanonicalMessage({
                version: MESSAGE_VERSION,
                sourceDomain: block.chainid,
                sourceGateway: address(this),
                sourceSender: sourceSender,
                destinationDomain: destinationDomain,
                destinationReceiver: destinationReceiver,
                nonce: nonce,
                payloadHash: payloadHash,
                deadline: deadline
            })
        );
    }
}
