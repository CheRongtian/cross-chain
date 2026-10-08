// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISourceGateway} from "./interfaces/ISourceGateway.sol";
import {CROSS_CHAIN_MESSAGE_TYPEHASH, MessageCodec} from "./MessageCodec.sol";

/// @notice Creates canonical outbound messages on the source chain.
contract SourceGateway is ISourceGateway {
    uint8 public constant MESSAGE_VERSION = 2;
    bytes32 public constant MESSAGE_TYPEHASH = CROSS_CHAIN_MESSAGE_TYPEHASH;

    // Lower camel case preserves the project-facing getter name.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable authorizationAdmin;

    uint256 public nextNonce = 1;
    mapping(address application => bool authorized) public authorizedSourceApplications;

    error InvalidAuthorizationAdmin();
    error UnauthorizedAuthorizationAdmin();
    error InvalidSourceApplication();
    error SourceApplicationAuthorizationUnchanged();
    error UnauthorizedSourceApplication();
    error InvalidDestinationDomain();
    error InvalidDestinationGateway();
    error InvalidDestinationReceiver();
    error InvalidDeadline();

    event SourceApplicationAuthorizationUpdated(address indexed application, bool authorized);

    event CrossChainMessage(
        bytes32 indexed messageId,
        uint8 version,
        uint256 sourceDomain,
        address sourceGateway,
        address indexed sourceSender,
        uint256 indexed destinationDomain,
        address destinationGateway,
        address destinationReceiver,
        uint256 nonce,
        bytes payload,
        uint256 deadline
    );

    constructor(address authorizationAdmin_) {
        if (authorizationAdmin_ == address(0)) {
            revert InvalidAuthorizationAdmin();
        }

        authorizationAdmin = authorizationAdmin_;
    }

    function setSourceApplicationAuthorization(address application, bool authorized) external {
        if (msg.sender != authorizationAdmin) {
            revert UnauthorizedAuthorizationAdmin();
        }
        if (application == address(0) || (authorized && application.code.length == 0)) {
            revert InvalidSourceApplication();
        }
        if (authorizedSourceApplications[application] == authorized) {
            revert SourceApplicationAuthorizationUnchanged();
        }

        // The authorization change is emitted immediately below.
        // forge-lint: disable-next-line(missing-events-access-control)
        authorizedSourceApplications[application] = authorized;
        emit SourceApplicationAuthorizationUpdated(application, authorized);
    }

    function sendMessage(
        uint256 destinationDomain,
        address destinationGateway,
        address destinationReceiver,
        bytes calldata payload,
        uint256 deadline
    ) external returns (bytes32 messageId, uint256 nonce) {
        if (!authorizedSourceApplications[msg.sender]) {
            revert UnauthorizedSourceApplication();
        }
        if (destinationDomain == 0 || destinationDomain == block.chainid) {
            revert InvalidDestinationDomain();
        }
        if (destinationGateway == address(0)) {
            revert InvalidDestinationGateway();
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
            destinationGateway,
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
            destinationGateway,
            destinationReceiver,
            nonce,
            payload,
            deadline
        );
    }

    function computeMessageId(
        address sourceSender,
        uint256 destinationDomain,
        address destinationGateway,
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
                destinationGateway: destinationGateway,
                destinationReceiver: destinationReceiver,
                nonce: nonce,
                payloadHash: payloadHash,
                deadline: deadline
            })
        );
    }
}
