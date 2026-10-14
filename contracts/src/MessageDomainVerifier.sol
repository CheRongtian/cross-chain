// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageCodec, CROSS_CHAIN_MESSAGE_VERSION} from "./MessageCodec.sol";
import {IRemoteGatewayRegistry} from "./interfaces/IRemoteGatewayRegistry.sol";

/// @notice Read-only full-message identity, current remote trust and destination policy checks.
/// @dev The caller must authenticate expectedMessageId through QC and Merkle verification first.
///      This component supplies no membership, execution, replay state or receiver callback.
contract MessageDomainVerifier {
    uint8 public constant MESSAGE_VERSION = CROSS_CHAIN_MESSAGE_VERSION;

    // Match existing project-facing registry getter naming.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    IRemoteGatewayRegistry public immutable remoteGatewayRegistry;
    // The protocol domain is configured explicitly, independently of the verifier's own address.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint256 public immutable destinationDomain;

    error InvalidRemoteGatewayRegistry();
    error InvalidLocalDestinationDomain(uint256 domain);
    error UnsupportedMessageVersion(uint8 version);
    error InvalidDestinationDomain(uint256 expected, uint256 actual);
    error InvalidSourceDestinationPair(uint256 sourceDomain, uint256 destinationDomain);
    error InvalidDestinationGateway();
    error DestinationGatewayMismatch(address expected, address actual);
    error InvalidDestinationReceiver();
    error MessageExpired(uint256 deadline, uint256 destinationTimestamp);
    error PayloadHashMismatch(bytes32 expected, bytes32 actual);
    error MessageIdMismatch(bytes32 expected, bytes32 actual);

    constructor(address registryAddress, uint256 localDestinationDomain) {
        if (registryAddress == address(0) || registryAddress.code.length == 0) {
            revert InvalidRemoteGatewayRegistry();
        }
        if (localDestinationDomain == 0) revert InvalidLocalDestinationDomain(localDestinationDomain);
        IRemoteGatewayRegistry registry = IRemoteGatewayRegistry(registryAddress);
        // Domain zero is a valid registry key. Probe the existing getter/pair semantics without writing trust.
        try registry.trustedRemoteGateway(0) returns (address registered) {
            try registry.isTrustedRemoteGateway(0, registered) returns (bool trusted) {
                if (trusted != (registered != address(0))) revert InvalidRemoteGatewayRegistry();
            } catch {
                revert InvalidRemoteGatewayRegistry();
            }
        } catch {
            revert InvalidRemoteGatewayRegistry();
        }
        remoteGatewayRegistry = registry;
        destinationDomain = localDestinationDomain;
    }

    /// @notice Returns true for a domain-valid message, or reverts with a precise policy/identity error.
    /// @dev expectedDestinationGateway must come from the caller's destination policy, not the message itself.
    function verifyMessage(
        MessageCodec.CanonicalMessage calldata message,
        bytes calldata payload,
        bytes32 expectedMessageId,
        address expectedDestinationGateway
    ) external view returns (bool) {
        if (message.version != MESSAGE_VERSION) revert UnsupportedMessageVersion(message.version);
        // Remote identity is resolved by exact domain/address; no remote extcodesize check is meaningful here.
        remoteGatewayRegistry.requireTrustedRemoteGateway(message.sourceDomain, message.sourceGateway);
        if (message.destinationDomain != destinationDomain) {
            revert InvalidDestinationDomain(destinationDomain, message.destinationDomain);
        }
        // SourceGateway prohibits sending to its own protocol domain.
        if (message.sourceDomain == message.destinationDomain) {
            revert InvalidSourceDestinationPair(message.sourceDomain, message.destinationDomain);
        }
        if (message.destinationGateway == address(0) || expectedDestinationGateway == address(0)) {
            revert InvalidDestinationGateway();
        }
        if (message.destinationGateway != expectedDestinationGateway) {
            revert DestinationGatewayMismatch(expectedDestinationGateway, message.destinationGateway);
        }
        if (message.destinationReceiver == address(0)) revert InvalidDestinationReceiver();
        // Match SourceGateway's strict deadline boundary; QC/membership cannot override destination expiry.
        uint256 destinationTimestamp = block.timestamp;
        // forge-lint: disable-next-line(block-timestamp)
        if (message.deadline <= destinationTimestamp) revert MessageExpired(message.deadline, destinationTimestamp);
        bytes32 actualMessageId = _messageId(message, payload);
        if (actualMessageId != expectedMessageId) revert MessageIdMismatch(expectedMessageId, actualMessageId);
        return true;
    }

    /// @notice Encoding parity helper, without version/trust/expiry acceptance policy.
    /// @dev Unsupported versions may be encoded canonically but are always rejected by verifyMessage.
    function computeMessageId(MessageCodec.CanonicalMessage calldata message, bytes calldata payload)
        external
        pure
        returns (bytes32)
    {
        return _messageId(message, payload);
    }

    function _messageId(MessageCodec.CanonicalMessage calldata message, bytes calldata payload)
        private
        pure
        returns (bytes32)
    {
        // Hash the exact dynamic calldata payload, matching SourceGateway; keep compiler-managed memory copying.
        // forge-lint: disable-next-line(asm-keccak256)
        bytes32 actualPayloadHash = keccak256(payload);
        if (message.payloadHash != actualPayloadHash) revert PayloadHashMismatch(message.payloadHash, actualPayloadHash);
        return MessageCodec.computeMessageId(message);
    }
}
