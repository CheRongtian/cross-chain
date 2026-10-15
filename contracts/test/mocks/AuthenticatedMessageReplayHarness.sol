// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageReplayProtection} from "../../src/MessageReplayProtection.sol";
import {MessageCodec} from "../../src/MessageCodec.sol";
import {MessageMerkle} from "../../src/MessageMerkle.sol";
import {MerkleInclusionVerifier} from "../../src/MerkleInclusionVerifier.sol";
import {MessageDomainVerifier} from "../../src/MessageDomainVerifier.sol";
import {IPBFTCertificateVerifier} from "../../src/interfaces/IPBFTCertificateVerifier.sol";
import {IReplayTestReceiver} from "./IReplayTestReceiver.sol";

/// @dev TEST ONLY: trusted contexts come from the verification fixture, not a production submission policy.
///      This ABI is not the final Gateway/Relayer envelope. No arbitrary public consume method is exposed.
contract AuthenticatedMessageReplayHarness is MessageReplayProtection {
    struct Acceptance {
        bytes certificate;
        IPBFTCertificateVerifier.ExpectedContext context;
        uint8 batchVersion;
        uint256 index;
        bytes32[] orderedMessageIds;
        MessageMerkle.Proof proof;
        MessageCodec.CanonicalMessage message;
        bytes payload;
        bytes32 messageId;
    }

    IPBFTCertificateVerifier public immutable CERTIFICATE_VERIFIER;
    MerkleInclusionVerifier public immutable MERKLE_VERIFIER;
    MessageDomainVerifier public immutable DOMAIN_VERIFIER;
    address public immutable EXPECTED_GATEWAY;

    error VerificationReturnedFalse();
    error MessageSourceContextMismatch();
    error InvalidExpectedDestinationGateway();

    constructor(address certificateVerifier, address merkleVerifier, address domainVerifier, address expectedGateway) {
        if (expectedGateway == address(0)) revert InvalidExpectedDestinationGateway();
        CERTIFICATE_VERIFIER = IPBFTCertificateVerifier(certificateVerifier);
        MERKLE_VERIFIER = MerkleInclusionVerifier(merkleVerifier);
        DOMAIN_VERIFIER = MessageDomainVerifier(domainVerifier);
        EXPECTED_GATEWAY = expectedGateway;
    }

    function acceptMessage(Acceptance calldata request) external {
        _acceptMessage(request);
    }

    /// @dev The separate receiver is an atomicity mock, not routing to request.message.destinationReceiver.
    function acceptMessageThenCall(Acceptance calldata request, address receiver) external {
        _acceptMessage(request);
        IReplayTestReceiver(receiver).onMessage(request.messageId);
    }

    function _acceptMessage(Acceptance calldata request) private {
        if (!CERTIFICATE_VERIFIER.verifyCertificate(request.certificate, request.context)) {
            revert VerificationReturnedFalse();
        }
        MerkleInclusionVerifier.BatchContext memory batch = MerkleInclusionVerifier.BatchContext({
            version: request.batchVersion,
            sourceDomain: request.context.sourceDomain,
            sourceGateway: request.context.sourceGateway,
            epoch: request.context.batchEpoch,
            batchId: request.context.batchId
        });
        if (!MERKLE_VERIFIER.verifyInclusion(batch, request.context.messageRoot, request.messageId,
            request.index, request.orderedMessageIds, request.proof)) {
            revert VerificationReturnedFalse();
        }
        if (request.message.sourceDomain != request.context.sourceDomain
            || request.message.sourceGateway != request.context.sourceGateway) {
            revert MessageSourceContextMismatch();
        }
        if (!DOMAIN_VERIFIER.verifyMessage(request.message, request.payload, request.messageId, EXPECTED_GATEWAY)) {
            revert VerificationReturnedFalse();
        }
        _consumeMessage(request.messageId);
    }
}
