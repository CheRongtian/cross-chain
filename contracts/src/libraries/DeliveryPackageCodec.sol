// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageCodec} from "../MessageCodec.sol";
import {DeliveryPolicy} from "./DeliveryPolicy.sol";

/// @notice The existing flat transport-v1 ABI, without changing its inner bytes.
library DeliveryPackageCodec {
    uint256 private constant WORD = 32;

    struct Envelope {
        string domain;
        uint8 version;
        string deliveryJobId;
        bytes messageBytes;
        bytes batchBytes;
        uint256 messageIndex;
        uint256 leafCount;
        bytes32 messageRoot;
        bytes32[] siblings;
        bytes certificate;
    }

    struct WireMessage {
        uint8 version;
        uint256 sourceDomain;
        address sourceGateway;
        address sourceSender;
        uint256 destinationDomain;
        address destinationGateway;
        address destinationReceiver;
        uint256 nonce;
        bytes payload;
        bytes32 payloadHash;
        uint256 deadline;
        bytes32 messageId;
    }

    struct Batch {
        uint8 version;
        uint256 epoch;
        bytes32 batchId;
        bytes32[] messageIds;
    }

    struct Package {
        Envelope envelope;
        WireMessage message;
        Batch batch;
    }

    error InvalidPackageEncoding();
    error UnsupportedTransportVersion(uint8 version);
    error InvalidTransportDomain();
    error PackageLimitExceeded(uint256 actual, uint256 maximum);
    error PayloadLimitExceeded(uint256 actual, uint256 maximum);
    error BatchLimitExceeded(uint256 actual, uint256 maximum);
    error InvalidPackageMembership();

    // Keep the single bounded decoding entry separate from policy/authentication consumers.
    // Each structural/bound check belongs to the one decoded snapshot before cryptographic work.
    // forge-lint: disable-next-item(internal-function-used-once, cyclomatic-complexity)
    function decode(bytes calldata encoded) internal pure returns (Package memory pack) {
        if (encoded.length > DeliveryPolicy.MAX_PACKAGE_BYTES) {
            revert PackageLimitExceeded(encoded.length, DeliveryPolicy.MAX_PACKAGE_BYTES);
        }
        // A flat ABI argument list and a dynamic tuple differ only by the tuple's outer offset.
        // Solidity bounds-checks nested lengths before allocating; total input is bounded above.
        pack.envelope = abi.decode(bytes.concat(abi.encode(WORD), encoded), (Envelope));
        _requireCanonical(encoded, abi.encode(pack.envelope));
        Envelope memory envelope = pack.envelope;
        if (envelope.version != 1) revert UnsupportedTransportVersion(envelope.version);
        if (!_same(bytes(envelope.domain), bytes("CrossChainDeliveryPackage"), 0)) revert InvalidTransportDomain();
        if (bytes(envelope.deliveryJobId).length == 0 || bytes(envelope.deliveryJobId).length > DeliveryPolicy.MAX_JOB_ID_BYTES) {
            revert InvalidPackageEncoding();
        }
        pack.message = abi.decode(bytes.concat(abi.encode(WORD), envelope.messageBytes), (WireMessage));
        _requireCanonical(envelope.messageBytes, abi.encode(pack.message));
        pack.batch = abi.decode(bytes.concat(abi.encode(WORD), envelope.batchBytes), (Batch));
        _requireCanonical(envelope.batchBytes, abi.encode(pack.batch));
        uint256 count = pack.batch.messageIds.length;
        if (count > DeliveryPolicy.MAX_BATCH_MESSAGES) revert BatchLimitExceeded(count, DeliveryPolicy.MAX_BATCH_MESSAGES);
        if (pack.message.payload.length > DeliveryPolicy.MAX_PAYLOAD_BYTES) {
            revert PayloadLimitExceeded(pack.message.payload.length, DeliveryPolicy.MAX_PAYLOAD_BYTES);
        }
        if (count == 0 || envelope.leafCount != count || envelope.messageIndex >= count
            || envelope.siblings.length > DeliveryPolicy.MAX_MERKLE_DEPTH) revert InvalidPackageMembership();
    }

    // One projection bridges the transport snapshot to the existing complete-message verifier ABI.
    // forge-lint: disable-next-item(internal-function-used-once)
    function canonicalMessage(WireMessage memory message) internal pure returns (MessageCodec.CanonicalMessage memory) {
        return MessageCodec.CanonicalMessage({
            version: message.version, sourceDomain: message.sourceDomain, sourceGateway: message.sourceGateway,
            sourceSender: message.sourceSender, destinationDomain: message.destinationDomain,
            destinationGateway: message.destinationGateway, destinationReceiver: message.destinationReceiver,
            nonce: message.nonce, payloadHash: message.payloadHash, deadline: message.deadline
        });
    }

    function _requireCanonical(bytes memory original, bytes memory tupleEncoding) private pure {
        if (!_same(original, tupleEncoding, WORD)) revert InvalidPackageEncoding();
    }

    /// @dev Compare actual bytes, not a new protocol fingerprint. ABI encodings are word aligned.
    function _same(bytes memory left, bytes memory right, uint256 skip) private pure returns (bool) {
        if (right.length < skip || left.length != right.length - skip) return false;
        if (left.length % WORD == 0) {
            for (uint256 index = 0; index < left.length; index += WORD) {
                bytes32 a;
                bytes32 b;
                // Both buffers contain this entire word; compare bytes directly without hashing.
                // forge-lint: disable-next-line(inline-assembly)
                assembly ("memory-safe") {
                    a := mload(add(add(left, WORD), index))
                    b := mload(add(add(add(right, WORD), skip), index))
                }
                if (a != b) return false;
            }
            return true;
        }
        for (uint256 index = 0; index < left.length; ++index) {
            if (left[index] != right[index + skip]) return false;
        }
        return true;
    }
}
