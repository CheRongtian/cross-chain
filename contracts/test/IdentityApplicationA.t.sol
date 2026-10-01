// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {IdentityApplicationA} from "../src/IdentityApplicationA.sol";
import {ICredentialVerifier} from "../src/interfaces/ICredentialVerifier.sol";
import {SourceGateway} from "../src/SourceGateway.sol";
import {MockCredentialVerifier} from "./mocks/MockCredentialVerifier.sol";
import {MockSourceGateway} from "./mocks/MockSourceGateway.sol";

contract IdentityApplicationATest is Test {
    uint256 internal constant TRUSTED_ISSUER = 12_345;
    uint256 internal constant REQUIRED_ROLE = 1;
    uint256 internal constant MAX_PROOF_AGE = 1 hours;
    uint256 internal constant CREDENTIAL_COMMITMENT = 98_765;
    uint256 internal constant SECOND_CREDENTIAL_COMMITMENT = 98_766;
    uint256 internal constant CURRENT_TIME = 2_000_000_000;
    uint256 internal constant ROOT_N = 111_111;
    uint256 internal constant ROOT_N_PLUS_ONE = 222_222;
    uint256 internal constant INITIAL_POLICY_EPOCH = 1;
    uint256 internal constant ACTION_VERIFY_SUPPLIER = 1;
    uint256 internal constant NULLIFIER_A_EPOCH_ONE = 333_331;
    uint256 internal constant NULLIFIER_B_EPOCH_ONE = 333_332;
    uint256 internal constant NULLIFIER_A_EPOCH_TWO = 333_333;
    uint256 internal constant NULLIFIER_B_EPOCH_TWO = 333_334;
    uint256 internal constant INDEXED_EVENT_TOPIC_COUNT = 3;
    uint256 internal constant GATEWAY_EVENT_TOPIC_COUNT = 4;
    uint256 internal constant DESTINATION_DOMAIN = 2001;
    address internal constant SUBMITTER = address(0xA11CE);
    address internal constant DESTINATION_GATEWAY = address(0xD00D);
    address internal constant DESTINATION_RECEIVER = address(0xBEEF);
    address internal constant STATE_AUTHORITY = address(0xA11CE5);
    address internal constant UNAUTHORIZED_CALLER = address(0xBAD);

    MockCredentialVerifier internal verifier;
    MockSourceGateway internal sourceGateway;
    IdentityApplicationA internal application;
    uint256 internal proofApplicationDomain;
    uint256 internal proofPolicyEpoch;

    function setUp() public {
        vm.warp(CURRENT_TIME);
        verifier = new MockCredentialVerifier();
        verifier.setVerificationResult(true);
        sourceGateway = new MockSourceGateway();
        application = new IdentityApplicationA(
            address(verifier),
            address(sourceGateway),
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            MAX_PROOF_AGE,
            STATE_AUTHORITY,
            ROOT_N
        );
        proofApplicationDomain = application.applicationDomain();
        proofPolicyEpoch = INITIAL_POLICY_EPOCH;
    }

    function testConstructorConfiguration() public view {
        assertEq(address(application.credentialVerifier()), address(verifier));
        assertEq(address(application.sourceGateway()), address(sourceGateway));
        assertEq(application.trustedIssuer(), TRUSTED_ISSUER);
        assertEq(application.requiredRole(), REQUIRED_ROLE);
        assertEq(application.maxProofAge(), MAX_PROOF_AGE);
        assertEq(application.VERIFIED_SUPPLIER_ROLE(), REQUIRED_ROLE);
        assertEq(application.credentialStateAuthority(), STATE_AUTHORITY);
        assertEq(application.credentialStateRoot(), ROOT_N);
        assertEq(application.currentPolicyEpoch(), application.INITIAL_POLICY_EPOCH());
        assertEq(application.ACTION_VERIFY_SUPPLIER(), 1);

        uint256 expectedApplicationDomain = uint256(
            keccak256(
                abi.encode(application.APPLICATION_DOMAIN_NAMESPACE(), block.chainid, address(application))
            )
        ) % application.SNARK_SCALAR_FIELD();
        assertEq(application.applicationDomain(), expectedApplicationDomain);
    }

    function testCommitmentStartsUnverified() public view {
        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.UNVERIFIED)
        );
        assertFalse(application.isVerifiedSupplier(CREDENTIAL_COMMITMENT));
        assertFalse(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
    }

    function testRejectsZeroVerifierAddress() public {
        vm.expectRevert(IdentityApplicationA.InvalidCredentialVerifier.selector);
        new IdentityApplicationA(
            address(0),
            address(sourceGateway),
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            MAX_PROOF_AGE,
            STATE_AUTHORITY,
            ROOT_N
        );
    }

    function testRejectsAddressWithoutVerifierCode() public {
        vm.expectRevert(IdentityApplicationA.InvalidCredentialVerifier.selector);
        new IdentityApplicationA(
            address(0xBEEF),
            address(sourceGateway),
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            MAX_PROOF_AGE,
            STATE_AUTHORITY,
            ROOT_N
        );
    }

    function testRejectsZeroSourceGatewayAddress() public {
        vm.expectRevert(IdentityApplicationA.InvalidSourceGateway.selector);
        new IdentityApplicationA(
            address(verifier),
            address(0),
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            MAX_PROOF_AGE,
            STATE_AUTHORITY,
            ROOT_N
        );
    }

    function testRejectsSourceGatewayAddressWithoutCode() public {
        vm.expectRevert(IdentityApplicationA.InvalidSourceGateway.selector);
        new IdentityApplicationA(
            address(verifier),
            address(0xBEEF),
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            MAX_PROOF_AGE,
            STATE_AUTHORITY,
            ROOT_N
        );
    }

    function testRejectsNonSupplierRoleConfiguration() public {
        vm.expectRevert(IdentityApplicationA.InvalidRequiredRole.selector);
        new IdentityApplicationA(
            address(verifier), address(sourceGateway), TRUSTED_ISSUER, 2, MAX_PROOF_AGE, STATE_AUTHORITY, ROOT_N
        );
    }

    function testRejectsZeroMaxProofAge() public {
        vm.expectRevert(IdentityApplicationA.InvalidMaxProofAge.selector);
        new IdentityApplicationA(
            address(verifier), address(sourceGateway), TRUSTED_ISSUER, REQUIRED_ROLE, 0, STATE_AUTHORITY, ROOT_N
        );
    }

    function testRejectsZeroCredentialStateAuthority() public {
        vm.expectRevert(IdentityApplicationA.InvalidCredentialStateAuthority.selector);
        new IdentityApplicationA(
            address(verifier),
            address(sourceGateway),
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            MAX_PROOF_AGE,
            address(0),
            ROOT_N
        );
    }

    function testRejectsZeroInitialCredentialStateRoot() public {
        vm.expectRevert(IdentityApplicationA.InvalidCredentialStateRoot.selector);
        new IdentityApplicationA(
            address(verifier),
            address(sourceGateway),
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            MAX_PROOF_AGE,
            STATE_AUTHORITY,
            0
        );
    }

    function testValidProofAuthorizesCredentialCommitment() public {
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.VERIFIED_SUPPLIER)
        );
        assertTrue(application.isVerifiedSupplier(CREDENTIAL_COMMITMENT));
        assertTrue(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
    }

    function testEmitsNullifierConsumedAndSupplierVerified() public {
        vm.recordLogs();
        vm.prank(SUBMITTER);
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);

        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 2);
        assertEq(logs[0].emitter, address(application));
        assertEq(logs[0].topics.length, INDEXED_EVENT_TOPIC_COUNT);
        assertEq(logs[0].topics[0], IdentityApplicationA.NullifierConsumed.selector);
        assertEq(logs[0].topics[1], bytes32(NULLIFIER_A_EPOCH_ONE));
        assertEq(logs[0].topics[2], bytes32(CREDENTIAL_COMMITMENT));
        (uint256 policyEpoch, uint256 actionContext) = abi.decode(logs[0].data, (uint256, uint256));
        assertEq(policyEpoch, application.INITIAL_POLICY_EPOCH());
        assertEq(actionContext, application.ACTION_VERIFY_SUPPLIER());

        assertEq(logs[1].emitter, address(application));
        assertEq(logs[1].topics.length, INDEXED_EVENT_TOPIC_COUNT);
        assertEq(logs[1].topics[0], IdentityApplicationA.SupplierVerified.selector);
        assertEq(logs[1].topics[1], bytes32(CREDENTIAL_COMMITMENT));
        assertEq(logs[1].topics[2], bytes32(uint256(uint160(SUBMITTER))));
        assertEq(abi.decode(logs[1].data, (uint256)), CURRENT_TIME);
    }

    function testRejectsVerifierFailureAndLeavesStatusUnchanged() public {
        verifier.setVerificationResult(false);
        vm.expectRevert(IdentityApplicationA.InvalidCredentialProof.selector);

        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.UNVERIFIED)
        );
        assertFalse(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
    }

    function testRejectsWrongIssuerBeforeVerifierCall() public {
        verifier.setVerificationResult(false);
        vm.expectRevert(IdentityApplicationA.InvalidIssuerPolicy.selector);

        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER + 1, REQUIRED_ROLE, CURRENT_TIME);

        assertFalse(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
    }

    function testRejectsWrongRoleBeforeVerifierCall() public {
        verifier.setVerificationResult(false);
        vm.expectRevert(IdentityApplicationA.InvalidRolePolicy.selector);

        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, 2, CURRENT_TIME);

        assertFalse(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
    }

    function testRejectsFutureProofTimestamp() public {
        vm.expectRevert(IdentityApplicationA.FutureProofTimestamp.selector);

        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME + 1);

        assertFalse(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
    }

    function testRejectsStaleProofTimestamp() public {
        vm.expectRevert(IdentityApplicationA.StaleProofTimestamp.selector);

        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME - MAX_PROOF_AGE - 1);

        assertFalse(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
    }

    function testRejectsProofForNonCurrentCredentialStateRoot() public {
        vm.expectRevert(IdentityApplicationA.InvalidCredentialStateRoot.selector);

        _verifySupplierWithRoot(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME, ROOT_N_PLUS_ONE);

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.UNVERIFIED)
        );
        assertFalse(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
    }

    function testAcceptsProofAtMaximumAge() public {
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME - MAX_PROOF_AGE);

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.VERIFIED_SUPPLIER)
        );
    }

    function testDuplicateValidProofIsRejectedByNullifier() public {
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);
        vm.expectRevert(IdentityApplicationA.NullifierAlreadyUsed.selector);
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.VERIFIED_SUPPLIER)
        );
        assertTrue(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
    }

    function testWrongApplicationDomainDoesNotConsumeNullifier() public {
        vm.expectRevert(IdentityApplicationA.InvalidApplicationDomain.selector);

        _verifySupplierWithContext(
            CREDENTIAL_COMMITMENT,
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            CURRENT_TIME,
            ROOT_N,
            proofApplicationDomain + 1,
            proofPolicyEpoch,
            ACTION_VERIFY_SUPPLIER,
            NULLIFIER_A_EPOCH_ONE
        );

        assertFalse(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
    }

    function testWrongPolicyEpochDoesNotConsumeNullifier() public {
        vm.expectRevert(IdentityApplicationA.InvalidPolicyEpoch.selector);

        _verifySupplierWithContext(
            CREDENTIAL_COMMITMENT,
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            CURRENT_TIME,
            ROOT_N,
            proofApplicationDomain,
            proofPolicyEpoch + 1,
            ACTION_VERIFY_SUPPLIER,
            NULLIFIER_A_EPOCH_TWO
        );

        assertFalse(application.usedNullifiers(NULLIFIER_A_EPOCH_TWO));
    }

    function testWrongActionContextDoesNotConsumeNullifier() public {
        vm.expectRevert(IdentityApplicationA.InvalidActionContext.selector);

        _verifySupplierWithContext(
            CREDENTIAL_COMMITMENT,
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            CURRENT_TIME,
            ROOT_N,
            proofApplicationDomain,
            proofPolicyEpoch,
            ACTION_VERIFY_SUPPLIER + 1,
            NULLIFIER_A_EPOCH_ONE
        );

        assertFalse(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
    }

    function testOutOfFieldNullifierIsRejectedWithoutConsumption() public {
        uint256 outOfFieldNullifier = application.SNARK_SCALAR_FIELD();
        vm.expectRevert(IdentityApplicationA.InvalidNullifier.selector);

        _verifySupplierWithContext(
            CREDENTIAL_COMMITMENT,
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            CURRENT_TIME,
            ROOT_N,
            proofApplicationDomain,
            proofPolicyEpoch,
            ACTION_VERIFY_SUPPLIER,
            outOfFieldNullifier
        );

        assertFalse(application.usedNullifiers(outOfFieldNullifier));
    }

    function testUnauthorizedPolicyEpochAdvanceIsRejected() public {
        vm.prank(UNAUTHORIZED_CALLER);
        vm.expectRevert(IdentityApplicationA.UnauthorizedPolicyEpochAuthority.selector);
        application.advancePolicyEpoch();

        assertEq(application.currentPolicyEpoch(), application.INITIAL_POLICY_EPOCH());
    }

    function testAuthorizedPolicyEpochAdvancesAndEmitsEvent() public {
        vm.recordLogs();
        vm.prank(STATE_AUTHORITY);
        application.advancePolicyEpoch();

        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(application.currentPolicyEpoch(), application.INITIAL_POLICY_EPOCH() + 1);
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(application));
        assertEq(logs[0].topics.length, INDEXED_EVENT_TOPIC_COUNT);
        assertEq(logs[0].topics[0], IdentityApplicationA.PolicyEpochAdvanced.selector);
        assertEq(logs[0].topics[1], bytes32(application.INITIAL_POLICY_EPOCH()));
        assertEq(logs[0].topics[2], bytes32(application.INITIAL_POLICY_EPOCH() + 1));
        assertEq(logs[0].data.length, 0);
    }

    function testNewPolicyEpochAllowsDifferentNullifierAndPreservesHistory() public {
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);

        vm.prank(STATE_AUTHORITY);
        application.advancePolicyEpoch();
        proofPolicyEpoch += 1;

        _verifySupplierWithContext(
            CREDENTIAL_COMMITMENT,
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            CURRENT_TIME,
            ROOT_N,
            proofApplicationDomain,
            proofPolicyEpoch,
            ACTION_VERIFY_SUPPLIER,
            NULLIFIER_A_EPOCH_TWO
        );

        assertTrue(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
        assertTrue(application.usedNullifiers(NULLIFIER_A_EPOCH_TWO));
        assertTrue(application.isVerifiedSupplier(CREDENTIAL_COMMITMENT));
    }

    function testAuthorizedCredentialStateRootUpdateSucceeds() public {
        vm.prank(STATE_AUTHORITY);
        application.updateCredentialStateRoot(ROOT_N_PLUS_ONE, new uint256[](0));

        assertEq(application.credentialStateRoot(), ROOT_N_PLUS_ONE);
    }

    function testUnauthorizedCredentialStateRootUpdateIsRejected() public {
        vm.prank(UNAUTHORIZED_CALLER);
        vm.expectRevert(IdentityApplicationA.UnauthorizedCredentialStateAuthority.selector);
        application.updateCredentialStateRoot(ROOT_N_PLUS_ONE, new uint256[](0));

        assertEq(application.credentialStateRoot(), ROOT_N);
    }

    function testZeroCredentialStateRootUpdateIsRejected() public {
        vm.prank(STATE_AUTHORITY);
        vm.expectRevert(IdentityApplicationA.InvalidCredentialStateRoot.selector);
        application.updateCredentialStateRoot(0, new uint256[](0));

        assertEq(application.credentialStateRoot(), ROOT_N);
    }

    function testCredentialStateRootUpdateEmitsEvent() public {
        vm.recordLogs();
        vm.prank(STATE_AUTHORITY);
        application.updateCredentialStateRoot(ROOT_N_PLUS_ONE, new uint256[](0));

        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(application));
        assertEq(logs[0].topics.length, INDEXED_EVENT_TOPIC_COUNT);
        assertEq(logs[0].topics[0], IdentityApplicationA.CredentialStateRootUpdated.selector);
        assertEq(logs[0].topics[1], bytes32(ROOT_N));
        assertEq(logs[0].topics[2], bytes32(ROOT_N_PLUS_ONE));
        assertEq(logs[0].data.length, 0);
    }

    function testRevocationRemovesEffectiveSupplierAuthorization() public {
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);

        vm.recordLogs();
        _revokeCredential(CREDENTIAL_COMMITMENT);

        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.REVOKED)
        );
        assertFalse(application.isVerifiedSupplier(CREDENTIAL_COMMITMENT));
        assertTrue(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
        assertEq(logs.length, 2);
        assertEq(logs[1].emitter, address(application));
        assertEq(logs[1].topics.length, 2);
        assertEq(logs[1].topics[0], IdentityApplicationA.CredentialRevoked.selector);
        assertEq(logs[1].topics[1], bytes32(CREDENTIAL_COMMITMENT));
        assertEq(logs[1].data.length, 0);
    }

    function testOldRootProofIsRejectedAfterCredentialStateUpdate() public {
        _revokeCredential(CREDENTIAL_COMMITMENT);
        vm.expectRevert(IdentityApplicationA.InvalidCredentialStateRoot.selector);

        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.REVOKED)
        );
        assertFalse(application.isVerifiedSupplier(CREDENTIAL_COMMITMENT));
        assertFalse(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
    }

    function testRevokedCredentialCannotBeReauthorizedAgainstCurrentRoot() public {
        _revokeCredential(CREDENTIAL_COMMITMENT);
        vm.expectRevert(IdentityApplicationA.RevokedCredential.selector);

        _verifySupplierWithRoot(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME, ROOT_N_PLUS_ONE);

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.REVOKED)
        );
        assertFalse(application.isVerifiedSupplier(CREDENTIAL_COMMITMENT));
    }

    function testRevokingCredentialDoesNotAffectDifferentVerifiedCredential() public {
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);
        _verifySupplier(SECOND_CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);
        _revokeCredential(CREDENTIAL_COMMITMENT);

        assertFalse(application.isVerifiedSupplier(CREDENTIAL_COMMITMENT));
        assertTrue(application.isVerifiedSupplier(SECOND_CREDENTIAL_COMMITMENT));
        assertTrue(application.usedNullifiers(NULLIFIER_A_EPOCH_ONE));
        assertTrue(application.usedNullifiers(NULLIFIER_B_EPOCH_ONE));
    }

    function testForwardsCrossChainMessageToConfiguredGateway() public {
        bytes memory payload = "supplier update";
        uint256 deadline = CURRENT_TIME + 1 hours;
        bytes32 expectedMessageId = keccak256("configured-mock-message");
        uint256 expectedNonce = 73;
        sourceGateway.setReturnValues(expectedMessageId, expectedNonce);

        vm.prank(SUBMITTER);
        (bytes32 messageId, uint256 nonce) = application.sendCrossChainMessage(
            DESTINATION_DOMAIN,
            DESTINATION_GATEWAY,
            DESTINATION_RECEIVER,
            payload,
            deadline
        );

        assertEq(messageId, expectedMessageId);
        assertEq(nonce, expectedNonce);
        assertEq(sourceGateway.caller(), address(application));
        assertEq(sourceGateway.destinationDomain(), DESTINATION_DOMAIN);
        assertEq(sourceGateway.destinationGateway(), DESTINATION_GATEWAY);
        assertEq(sourceGateway.destinationReceiver(), DESTINATION_RECEIVER);
        assertEq(sourceGateway.payload(), payload);
        assertEq(sourceGateway.deadline(), deadline);
    }

    function testIdentityApplicationCallsRealSourceGateway() public {
        SourceGateway realSourceGateway = new SourceGateway();
        IdentityApplicationA realGatewayApplication = new IdentityApplicationA(
            address(verifier),
            address(realSourceGateway),
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            MAX_PROOF_AGE,
            STATE_AUTHORITY,
            ROOT_N
        );
        bytes memory payload = "supplier update";
        uint256 deadline = CURRENT_TIME + 1 hours;
        bytes32 payloadHash = keccak256(payload);
        bytes32 expectedMessageId = realSourceGateway.computeMessageId(
            address(realGatewayApplication),
            DESTINATION_DOMAIN,
            DESTINATION_GATEWAY,
            DESTINATION_RECEIVER,
            1,
            payloadHash,
            deadline
        );

        vm.recordLogs();
        vm.prank(SUBMITTER);
        (bytes32 messageId, uint256 nonce) = realGatewayApplication.sendCrossChainMessage(
            DESTINATION_DOMAIN,
            DESTINATION_GATEWAY,
            DESTINATION_RECEIVER,
            payload,
            deadline
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(messageId, expectedMessageId);
        assertEq(nonce, 1);
        assertEq(realSourceGateway.nextNonce(), 2);
        _assertRealGatewayEvent(
            logs, realSourceGateway, realGatewayApplication, expectedMessageId, payload, deadline
        );
    }

    function _assertRealGatewayEvent(
        Vm.Log[] memory logs,
        SourceGateway realSourceGateway,
        IdentityApplicationA realGatewayApplication,
        bytes32 expectedMessageId,
        bytes memory expectedPayload,
        uint256 expectedDeadline
    ) internal view {
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(realSourceGateway));
        assertEq(logs[0].topics.length, GATEWAY_EVENT_TOPIC_COUNT);
        assertEq(logs[0].topics[0], SourceGateway.CrossChainMessage.selector);
        assertEq(logs[0].topics[1], expectedMessageId);
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(address(realGatewayApplication)))));
        assertEq(logs[0].topics[3], bytes32(DESTINATION_DOMAIN));

        (
            uint8 version,
            uint256 sourceDomain,
            address eventSourceGateway,
            address eventDestinationGateway,
            address eventDestinationReceiver,
            uint256 eventNonce,
            bytes memory eventPayload,
            uint256 eventDeadline
        ) = abi.decode(
            logs[0].data,
            (uint8, uint256, address, address, address, uint256, bytes, uint256)
        );

        assertEq(version, realSourceGateway.MESSAGE_VERSION());
        assertEq(sourceDomain, block.chainid);
        assertEq(eventSourceGateway, address(realSourceGateway));
        assertEq(eventDestinationGateway, DESTINATION_GATEWAY);
        assertEq(eventDestinationReceiver, DESTINATION_RECEIVER);
        assertEq(eventNonce, 1);
        assertEq(eventPayload, expectedPayload);
        assertEq(eventDeadline, expectedDeadline);
    }

    function _verifySupplier(
        uint256 credentialCommitment,
        uint256 proofTrustedIssuer,
        uint256 proofRequiredRole,
        uint256 proofTimestamp
    ) internal {
        _verifySupplierWithContext(
            credentialCommitment,
            proofTrustedIssuer,
            proofRequiredRole,
            proofTimestamp,
            ROOT_N,
            proofApplicationDomain,
            proofPolicyEpoch,
            ACTION_VERIFY_SUPPLIER,
            _nullifierFor(credentialCommitment, proofPolicyEpoch)
        );
    }

    function _verifySupplierWithRoot(
        uint256 credentialCommitment,
        uint256 proofTrustedIssuer,
        uint256 proofRequiredRole,
        uint256 proofTimestamp,
        uint256 proofCredentialStateRoot
    ) internal {
        _verifySupplierWithContext(
            credentialCommitment,
            proofTrustedIssuer,
            proofRequiredRole,
            proofTimestamp,
            proofCredentialStateRoot,
            proofApplicationDomain,
            proofPolicyEpoch,
            ACTION_VERIFY_SUPPLIER,
            _nullifierFor(credentialCommitment, proofPolicyEpoch)
        );
    }

    function _verifySupplierWithContext(
        uint256 credentialCommitment,
        uint256 proofTrustedIssuer,
        uint256 proofRequiredRole,
        uint256 proofTimestamp,
        uint256 proofCredentialStateRoot,
        uint256 proofApplicationDomain,
        uint256 proofPolicyEpoch,
        uint256 proofActionContext,
        uint256 proofNullifier
    ) internal {
        ICredentialVerifier.CredentialPublicInputs memory publicInputs = ICredentialVerifier.CredentialPublicInputs({
            credentialCommitment: credentialCommitment,
            trustedIssuer: proofTrustedIssuer,
            requiredRole: proofRequiredRole,
            currentTimestamp: proofTimestamp,
            credentialStateRoot: proofCredentialStateRoot,
            applicationDomain: proofApplicationDomain,
            policyEpoch: proofPolicyEpoch,
            actionContext: proofActionContext,
            nullifier: proofNullifier
        });

        application.verifySupplier(
            [uint256(1), uint256(2)],
            [[uint256(3), uint256(4)], [uint256(5), uint256(6)]],
            [uint256(7), uint256(8)],
            publicInputs
        );
    }

    function _nullifierFor(uint256 credentialCommitment, uint256 policyEpoch) internal pure returns (uint256) {
        if (credentialCommitment == SECOND_CREDENTIAL_COMMITMENT) {
            return policyEpoch == 1 ? NULLIFIER_B_EPOCH_ONE : NULLIFIER_B_EPOCH_TWO;
        }

        return policyEpoch == 1 ? NULLIFIER_A_EPOCH_ONE : NULLIFIER_A_EPOCH_TWO;
    }

    function _revokeCredential(uint256 credentialCommitment) internal {
        uint256[] memory revokedCredentialCommitments = new uint256[](1);
        revokedCredentialCommitments[0] = credentialCommitment;

        vm.prank(STATE_AUTHORITY);
        application.updateCredentialStateRoot(ROOT_N_PLUS_ONE, revokedCredentialCommitments);
    }
}
