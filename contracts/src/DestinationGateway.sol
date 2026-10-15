// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageReplayProtection} from "./MessageReplayProtection.sol";
import {MessageMerkle} from "./MessageMerkle.sol";
import {MerkleInclusionVerifier} from "./MerkleInclusionVerifier.sol";
import {MessageDomainVerifier} from "./MessageDomainVerifier.sol";
import {PBFTCertificateVerifier} from "./PBFTCertificateVerifier.sol";
import {IPBFTCertificateVerifier} from "./interfaces/IPBFTCertificateVerifier.sol";
import {ICrossChainReceiver} from "./interfaces/ICrossChainReceiver.sol";
import {DeliveryPackageCodec as Codec} from "./libraries/DeliveryPackageCodec.sol";
import {PBFTCertificateCodec} from "./libraries/PBFTCertificateCodec.sol";
import {DeliveryPolicy} from "./libraries/DeliveryPolicy.sol";

/// @notice Permissionless, atomic destination authentication, consumption and application dispatch.
contract DestinationGateway is MessageReplayProtection {
    uint256 private constant WORD = 32;

    PBFTCertificateVerifier public immutable CERTIFICATE_VERIFIER;
    MerkleInclusionVerifier public immutable MERKLE_VERIFIER;
    MessageDomainVerifier public immutable DOMAIN_VERIFIER;
    uint256 public constant MAX_PAYLOAD_BYTES = DeliveryPolicy.MAX_PAYLOAD_BYTES;
    uint256 public constant MAX_BATCH_MESSAGES = DeliveryPolicy.MAX_BATCH_MESSAGES;
    uint256 public constant MAX_PACKAGE_BYTES = DeliveryPolicy.MAX_PACKAGE_BYTES;

    error InvalidVerifierDependency(address dependency);
    error VerificationReturnedFalse();
    error InvalidDestinationReceiver(address receiver);
    error InvalidExecutionEncoding();

    event CrossChainMessageExecuted(
        bytes32 indexed messageId, uint256 indexed sourceDomain, address indexed destinationReceiver, bytes32 batchId
    );

    constructor(address certificateVerifier, address merkleVerifier, address domainVerifier) {
        _requireDependency(certificateVerifier);
        _requireDependency(merkleVerifier);
        _requireDependency(domainVerifier);
        CERTIFICATE_VERIFIER = PBFTCertificateVerifier(certificateVerifier);
        MERKLE_VERIFIER = MerkleInclusionVerifier(merkleVerifier);
        DOMAIN_VERIFIER = MessageDomainVerifier(domainVerifier);
    }

    function execute(bytes calldata packageBytes) external {
        // Reject an oversized input before copying/re-encoding the function wrapper.
        if (packageBytes.length > MAX_PACKAGE_BYTES) {
            revert Codec.PackageLimitExceeded(packageBytes.length, MAX_PACKAGE_BYTES);
        }
        _requireCanonicalCall(packageBytes);
        Codec.Package memory pack = Codec.decode(packageBytes);
        IPBFTCertificateVerifier.ExpectedContext memory context =
            PBFTCertificateCodec.context(pack.envelope.certificate);
        // Source, batch and root expectations come from this one decoded snapshot.
        context.sourceDomain = pack.message.sourceDomain;
        context.sourceGateway = pack.message.sourceGateway;
        context.batchEpoch = pack.batch.epoch;
        context.batchId = pack.batch.batchId;
        context.messageRoot = pack.envelope.messageRoot;
        if (context.protocolVersion != PBFTCertificateCodec.EPOCH_VERSION) {
            context.authorityEpoch = CERTIFICATE_VERIFIER.validatorSetRegistry().initialValidatorEpoch();
        }
        if (!CERTIFICATE_VERIFIER.verifyCertificate(pack.envelope.certificate, context)) revert VerificationReturnedFalse();
        MerkleInclusionVerifier.BatchContext memory batch = MerkleInclusionVerifier.BatchContext({
            version: pack.batch.version, sourceDomain: context.sourceDomain, sourceGateway: context.sourceGateway,
            epoch: context.batchEpoch, batchId: context.batchId
        });
        MessageMerkle.Proof memory proof = MessageMerkle.Proof({
            batchId: pack.batch.batchId, messageId: pack.message.messageId, index: pack.envelope.messageIndex,
            leafCount: pack.envelope.leafCount, siblings: pack.envelope.siblings
        });
        if (!MERKLE_VERIFIER.verifyInclusion(batch, context.messageRoot, pack.message.messageId,
            pack.envelope.messageIndex, pack.batch.messageIds, proof)) revert VerificationReturnedFalse();
        if (!DOMAIN_VERIFIER.verifyMessage(Codec.canonicalMessage(pack.message), pack.message.payload,
            pack.message.messageId, address(this))) revert VerificationReturnedFalse();
        address receiver = pack.message.destinationReceiver;
        if (receiver.code.length == 0) revert InvalidDestinationReceiver(receiver);
        _consumeMessage(pack.message.messageId);
        ICrossChainReceiver(receiver).handleCrossChainMessage(pack.message.messageId, pack.message.payload);
        // Receiver success and replay consumption are committed in this same transaction.
        // forge-lint: disable-next-line(reentrancy-events)
        emit CrossChainMessageExecuted(pack.message.messageId, context.sourceDomain, receiver, pack.batch.batchId);
    }

    function _requireDependency(address dependency) private view {
        if (dependency == address(0) || dependency.code.length == 0) revert InvalidVerifierDependency(dependency);
    }

    function _requireCanonicalCall(bytes calldata packageBytes) private pure {
        bytes memory canonical = abi.encodeWithSelector(DestinationGateway.execute.selector, packageBytes);
        if (msg.data.length != canonical.length) revert InvalidExecutionEncoding();
        for (uint256 index = 4; index < canonical.length; index += WORD) {
            bytes32 actual;
            bytes32 expected;
            // The selector is checked by Solidity dispatch; every remaining complete ABI word is compared.
            // forge-lint: disable-next-line(inline-assembly)
            assembly ("memory-safe") {
                actual := calldataload(index)
                expected := mload(add(add(canonical, WORD), index))
            }
            // Exact equality also rejects noncanonical offsets and dirty outer ABI padding.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (actual != expected) revert InvalidExecutionEncoding();
        }
    }
}
