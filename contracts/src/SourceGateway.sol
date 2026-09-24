// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract SourceGateway {
    uint8 public constant MESSAGE_VERSION = 1;

    uint256 public nextNonce = 1;

    error InvalidDestinationDomain();
    error InvalidDestinationReceiver();

    event CrossChainMessage(
        bytes32 indexed messageId,
        uint8 version,
        uint256 sourceDomain,
        address sourceGateway,
        address indexed sourceSender,
        uint256 indexed destinationDomain,
        address destinationReceiver,
        uint256 nonce,
        bytes payload
    );

    function sendMessage(uint256 destinationDomain, address destinationReceiver, bytes calldata payload)
        external
        returns (bytes32 messageId, uint256 nonce)
    {
        if (destinationDomain == 0 || destinationDomain == block.chainid) {
            revert InvalidDestinationDomain();
        }

        if (destinationReceiver == address(0)) {
            revert InvalidDestinationReceiver();
        }

        nonce = nextNonce;
        nextNonce++;

        bytes32 payloadHash = keccak256(payload);

        messageId = computeMessageId(msg.sender, destinationDomain, destinationReceiver, nonce, payloadHash);

        emit CrossChainMessage(
            messageId,
            MESSAGE_VERSION,
            block.chainid,
            address(this),
            msg.sender,
            destinationDomain,
            destinationReceiver,
            nonce,
            payload
        );
    }

    function computeMessageId(
        address sourceSender,
        uint256 destinationDomain,
        address destinationReceiver,
        uint256 nonce,
        bytes32 payloadHash
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                MESSAGE_VERSION,
                block.chainid,
                address(this),
                sourceSender,
                destinationDomain,
                destinationReceiver,
                nonce,
                payloadHash
            )
        );
    }
}
