// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {IdentityApplicationA} from "../src/IdentityApplicationA.sol";
import {ICredentialVerifier} from "../src/interfaces/ICredentialVerifier.sol";
import {SourceGateway} from "../src/SourceGateway.sol";
import {MockCredentialVerifier} from "./mocks/MockCredentialVerifier.sol";
import {MockSourceGateway} from "./mocks/MockSourceGateway.sol";
import {ForwardAuthorizationCodec} from "../src/ForwardAuthorizationCodec.sol";

contract IdentityApplicationATest is Test {
    enum ForwardIntentMutation {
        PAYLOAD,
        DESTINATION_DOMAIN,
        DESTINATION_GATEWAY,
        DESTINATION_RECEIVER,
        DEADLINE
    }

    enum ForwardPolicyMutation {
        ISSUER,
        ROLE,
        FUTURE_TIMESTAMP,
        STALE_TIMESTAMP,
        CREDENTIAL_STATE_ROOT,
        POLICY_EPOCH,
        INTENT_HIGH_LIMB,
        INTENT_LOW_LIMB,
        AUTHORIZATION_DEADLINE,
        VERIFIER_REJECTION
    }

    uint256 internal constant FORWARD_NULLIFIER = 555_551;
    uint256 internal constant ACTION_FORWARD_MESSAGE = 3;
    uint8 internal constant FORWARD_PROTOCOL_VERSION = 2;
    uint256 internal constant PROOF_PAIR_SIZE = 2;
    uint256 internal constant OTHER_ROLE = 2;
    uint256 internal constant FORWARD_EVENT_COUNT = 3;
    uint256 internal constant FORWARD_EVENT_TOPIC_COUNT = 4;
    uint256 internal constant FORWARD_INTENT_MUTATION_COUNT = uint256(ForwardIntentMutation.DEADLINE) + 1;
    uint256 internal constant FORWARD_POLICY_MUTATION_COUNT = uint256(ForwardPolicyMutation.VERIFIER_REJECTION) + 1;
    uint256 internal constant TRUSTED_ISSUER = 12_345;
    uint256 internal constant REQUIRED_ROLE = 1;
    uint256 internal constant ONE_HOUR = 1 hours;
    uint256 internal constant MAX_PROOF_AGE = ONE_HOUR;
    uint256 internal constant MESSAGE_LIFETIME = ONE_HOUR;
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
    address internal constant NO_CODE_ADDRESS = address(0xCAFE);

    MockCredentialVerifier internal verifier;
    MockSourceGateway internal sourceGateway;
    IdentityApplicationA internal application;
    uint256 internal proofApplicationDomain;

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
            NO_CODE_ADDRESS,
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
            NO_CODE_ADDRESS,
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

    function testProofFreshnessPolicyCanExceedOneHour() public {
        IdentityApplicationA longerFreshness = new IdentityApplicationA(address(verifier), address(sourceGateway),
            TRUSTED_ISSUER, REQUIRED_ROLE, 2 * ONE_HOUR, STATE_AUTHORITY, ROOT_N);
        assertEq(longerFreshness.maxProofAge(), 2 * ONE_HOUR);
    }

    function testStandaloneAuthorizationBeforeDeadlineSucceeds() public {
        ICredentialVerifier.CredentialPublicInputs memory inputs = _standaloneDeadlineInputs(CURRENT_TIME + 1);
        application.verifySupplier(_mockProofA(), _mockProofB(), _mockProofC(), inputs);
        assertTrue(application.usedNullifiers(inputs.nullifier));
        assertTrue(application.isVerifiedSupplier(inputs.credentialCommitment));
    }

    function testStandaloneAuthorizationAtDeadlineIsRejected() public {
        _assertStandaloneDeadlineRejected(CURRENT_TIME);
    }

    function testStandaloneAuthorizationAfterDeadlineIsRejected() public {
        _assertStandaloneDeadlineRejected(CURRENT_TIME - 1);
    }

    function _standaloneDeadlineInputs(uint256 deadline)
        internal view returns (ICredentialVerifier.CredentialPublicInputs memory inputs)
    {
        IdentityApplicationA.ForwardRequest memory request = _forwardRequest("deadline policy", CURRENT_TIME + ONE_HOUR);
        inputs = _forwardInputs(application, request, SUBMITTER, NULLIFIER_A_EPOCH_ONE);
        inputs.actionContext = ACTION_VERIFY_SUPPLIER;
        inputs.forwardIntentDigestHi = 0;
        inputs.forwardIntentDigestLo = 0;
        inputs.authorizationValidUntil = deadline;
    }

    function _assertStandaloneDeadlineRejected(uint256 deadline) internal {
        ICredentialVerifier.CredentialPublicInputs memory inputs = _standaloneDeadlineInputs(deadline);
        _expectNoForwardCalls();
        vm.recordLogs();
        vm.expectRevert(IdentityApplicationA.AuthorizationExpired.selector);
        application.verifySupplier(_mockProofA(), _mockProofB(), _mockProofC(), inputs);
        assertEq(vm.getRecordedLogs().length, 0);
        assertFalse(application.usedNullifiers(inputs.nullifier));
        assertFalse(application.isVerifiedSupplier(inputs.credentialCommitment));
        assertEq(application.credentialStateRoot(), ROOT_N);
        assertEq(application.currentPolicyEpoch(), INITIAL_POLICY_EPOCH);
    }

    function testForwardAuthorizationDeadlineGuardPrecedesVerifierAndGateway() public {
        IdentityApplicationA.ForwardRequest memory request = _forwardRequest("deadline policy", CURRENT_TIME + ONE_HOUR);
        ICredentialVerifier.CredentialPublicInputs memory inputs = _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER);
        inputs.authorizationValidUntil = CURRENT_TIME;
        _expectNoForwardCalls();
        _assertForwardRequestGuard(request, inputs, IdentityApplicationA.AuthorizationExpired.selector);
        assertEq(sourceGateway.caller(), address(0));
        assertEq(application.credentialStateRoot(), ROOT_N);
        assertEq(application.currentPolicyEpoch(), INITIAL_POLICY_EPOCH);
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
            INITIAL_POLICY_EPOCH,
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
            INITIAL_POLICY_EPOCH + 1,
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
            INITIAL_POLICY_EPOCH,
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
            INITIAL_POLICY_EPOCH,
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

        uint256 nextPolicyEpoch = INITIAL_POLICY_EPOCH + 1;
        vm.prank(STATE_AUTHORITY);
        application.advancePolicyEpoch();

        _verifySupplierWithContext(
            CREDENTIAL_COMMITMENT,
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            CURRENT_TIME,
            ROOT_N,
            proofApplicationDomain,
            nextPolicyEpoch,
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
        uint256 deadline = CURRENT_TIME + MESSAGE_LIFETIME;
        bytes32 expectedMessageId = keccak256("configured-mock-message");
        uint256 expectedNonce = 73;
        sourceGateway.setReturnValues(expectedMessageId, expectedNonce);

        IdentityApplicationA.ForwardRequest memory request = _forwardRequest(payload, deadline);
        ICredentialVerifier.CredentialPublicInputs memory inputs = _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER);
        vm.prank(SUBMITTER);
        (bytes32 messageId, uint256 nonce) = _invokeForward(application, inputs, request);

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
        SourceGateway realSourceGateway = new SourceGateway(address(this));
        IdentityApplicationA realGatewayApplication = new IdentityApplicationA(
            address(verifier),
            address(realSourceGateway),
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            MAX_PROOF_AGE,
            STATE_AUTHORITY,
            ROOT_N
        );
        realSourceGateway.setSourceApplicationAuthorization(address(realGatewayApplication), true);
        bytes memory payload = "supplier update";
        uint256 deadline = CURRENT_TIME + MESSAGE_LIFETIME;
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

        IdentityApplicationA.ForwardRequest memory request = _forwardRequest(payload, deadline);
        ICredentialVerifier.CredentialPublicInputs memory inputs = _forwardInputs(realGatewayApplication, request, SUBMITTER, FORWARD_NULLIFIER);
        vm.recordLogs();
        vm.prank(SUBMITTER);
        (bytes32 messageId, uint256 nonce) = _invokeForward(realGatewayApplication, inputs, request);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(messageId, expectedMessageId);
        assertEq(nonce, 1);
        assertEq(realSourceGateway.nextNonce(), 2);
        _assertRealGatewayEvent(
            logs, realSourceGateway, realGatewayApplication, expectedMessageId, payload, deadline
        );
    }

    function testRealSourceGatewayRejectsUnauthorizedIdentityApplication() public {
        SourceGateway realSourceGateway = new SourceGateway(address(this));
        IdentityApplicationA realGatewayApplication = new IdentityApplicationA(
            address(verifier),
            address(realSourceGateway),
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            MAX_PROOF_AGE,
            STATE_AUTHORITY,
            ROOT_N
        );

        IdentityApplicationA.ForwardRequest memory request = _forwardRequest("supplier update", CURRENT_TIME + MESSAGE_LIFETIME);
        ICredentialVerifier.CredentialPublicInputs memory inputs = _forwardInputs(realGatewayApplication, request, SUBMITTER, FORWARD_NULLIFIER);
        vm.prank(SUBMITTER);
        vm.expectRevert(SourceGateway.UnauthorizedSourceApplication.selector);
        _invokeForward(realGatewayApplication, inputs, request);
        assertFalse(realGatewayApplication.usedNullifiers(inputs.nullifier));
        assertEq(realSourceGateway.nextNonce(), 1);
        realSourceGateway.setSourceApplicationAuthorization(address(realGatewayApplication), true);
        vm.prank(SUBMITTER);
        (, uint256 nonce) = _invokeForward(realGatewayApplication, inputs, request);
        assertEq(nonce, 1);
        assertTrue(realGatewayApplication.usedNullifiers(inputs.nullifier));
    }

    function testRealSourceGatewayRejectsRevokedIdentityApplicationWithoutConsumingNonce() public {
        SourceGateway realSourceGateway = new SourceGateway(address(this));
        IdentityApplicationA realGatewayApplication = new IdentityApplicationA(
            address(verifier),
            address(realSourceGateway),
            TRUSTED_ISSUER,
            REQUIRED_ROLE,
            MAX_PROOF_AGE,
            STATE_AUTHORITY,
            ROOT_N
        );
        realSourceGateway.setSourceApplicationAuthorization(address(realGatewayApplication), true);

        IdentityApplicationA.ForwardRequest memory request = _forwardRequest("supplier update", CURRENT_TIME + MESSAGE_LIFETIME);
        ICredentialVerifier.CredentialPublicInputs memory inputs = _forwardInputs(realGatewayApplication, request, SUBMITTER, FORWARD_NULLIFIER);
        vm.prank(SUBMITTER);
        (, uint256 acceptedNonce) = _invokeForward(realGatewayApplication, inputs, request);
        assertEq(acceptedNonce, 1);
        realSourceGateway.setSourceApplicationAuthorization(address(realGatewayApplication), false);

        request.deadline += 1;
        inputs = _forwardInputs(realGatewayApplication, request, SUBMITTER, FORWARD_NULLIFIER + 1);
        vm.prank(SUBMITTER);
        vm.expectRevert(SourceGateway.UnauthorizedSourceApplication.selector);
        _invokeForward(realGatewayApplication, inputs, request);

        assertFalse(realGatewayApplication.usedNullifiers(inputs.nullifier));
        assertEq(realSourceGateway.nextNonce(), 2);
    }

    function _forwardRequest(bytes memory payload, uint256 deadline) internal pure returns (IdentityApplicationA.ForwardRequest memory) {
        return IdentityApplicationA.ForwardRequest({
            destinationDomain: DESTINATION_DOMAIN,
            destinationGateway: DESTINATION_GATEWAY,
            destinationReceiver: DESTINATION_RECEIVER,
            payload: payload,
            deadline: deadline
        });
    }

    function _intentFor(IdentityApplicationA target, IdentityApplicationA.ForwardRequest memory request, address executor)
        internal view returns (ForwardAuthorizationCodec.Intent memory intent)
    {
        intent.protocolVersion = FORWARD_PROTOCOL_VERSION;
        intent.action = ACTION_FORWARD_MESSAGE;
        intent.sourceDomain = block.chainid;
        intent.application = address(target);
        // Local fixture getters are intentionally read for each bounded mutation.
        // forge-lint: disable-next-line(calls-loop)
        intent.sourceGateway = address(target.sourceGateway());
        intent.destinationDomain = request.destinationDomain;
        intent.destinationGateway = request.destinationGateway;
        intent.destinationReceiver = request.destinationReceiver;
        intent.payloadHash = keccak256(request.payload);
        intent.deadline = request.deadline;
        intent.authorizedExecutor = executor;
    }

    function _forwardInputs(IdentityApplicationA target, IdentityApplicationA.ForwardRequest memory request, address executor, uint256 nullifier)
        internal view returns (ICredentialVerifier.CredentialPublicInputs memory inputs)
    {
        inputs.credentialCommitment = CREDENTIAL_COMMITMENT;
        inputs.trustedIssuer = TRUSTED_ISSUER;
        inputs.requiredRole = REQUIRED_ROLE;
        inputs.currentTimestamp = CURRENT_TIME;
        inputs.authorizationValidUntil = CURRENT_TIME + 2 * ONE_HOUR;
        // Local fixture getters are intentionally read for each bounded mutation.
        // forge-lint: disable-next-line(calls-loop)
        inputs.credentialStateRoot = target.credentialStateRoot();
        // Local fixture getters are intentionally read for each bounded mutation.
        // forge-lint: disable-next-line(calls-loop)
        inputs.applicationDomain = target.applicationDomain();
        // Local fixture getters are intentionally read for each bounded mutation.
        // forge-lint: disable-next-line(calls-loop)
        inputs.policyEpoch = target.currentPolicyEpoch();
        inputs.actionContext = ACTION_FORWARD_MESSAGE;
        inputs.nullifier = nullifier;
        (inputs.forwardIntentDigestHi, inputs.forwardIntentDigestLo) = ForwardAuthorizationCodec.split(ForwardAuthorizationCodec.digest(_intentFor(target, request, executor)));
    }

    function _invokeForward(IdentityApplicationA target, ICredentialVerifier.CredentialPublicInputs memory inputs, IdentityApplicationA.ForwardRequest memory request)
        internal returns (bytes32, uint256)
    {
        // Mutation tests deliberately exercise the actual local authorization entry point.
        // forge-lint: disable-next-line(calls-loop)
        return target.forwardAuthorizedMessage(_mockProofA(), _mockProofB(), _mockProofC(), inputs, request);
    }

    function testExpiredForwardDeadlinePrecedesProofVerification() public {
        _expectNoForwardCalls();
        IdentityApplicationA.ForwardRequest memory request = _forwardRequest("supplier update", CURRENT_TIME);
        _assertForwardRequestGuard(
            request, _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER),
            IdentityApplicationA.InvalidDeadline.selector
        );
    }

    function testZeroForwardGatewayPrecedesProofVerification() public {
        _expectNoForwardCalls();
        IdentityApplicationA.ForwardRequest memory request = _forwardRequest("supplier update", CURRENT_TIME + MESSAGE_LIFETIME);
        request.destinationGateway = address(0);
        _assertForwardRequestGuard(
            request, _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER),
            IdentityApplicationA.InvalidDestinationGateway.selector
        );
    }

    function testLocalForwardDomainPrecedesProofVerification() public {
        _expectNoForwardCalls();
        IdentityApplicationA.ForwardRequest memory request = _forwardRequest("supplier update", CURRENT_TIME + MESSAGE_LIFETIME);
        request.destinationDomain = block.chainid;
        _assertForwardRequestGuard(
            request, _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER),
            IdentityApplicationA.InvalidDestinationDomain.selector
        );
    }

    function testZeroForwardReceiverPrecedesProofVerification() public {
        _expectNoForwardCalls();
        IdentityApplicationA.ForwardRequest memory request = _forwardRequest("supplier update", CURRENT_TIME + MESSAGE_LIFETIME);
        request.destinationReceiver = address(0);
        _assertForwardRequestGuard(
            request, _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER),
            IdentityApplicationA.InvalidDestinationReceiver.selector
        );
    }

    function testForwardRequestGuardsPrecedeAlreadyUsedNullifier() public {
        IdentityApplicationA.ForwardRequest memory original = _forwardRequest("supplier update", CURRENT_TIME + MESSAGE_LIFETIME);
        ICredentialVerifier.CredentialPublicInputs memory inputs = _forwardInputs(application, original, SUBMITTER, FORWARD_NULLIFIER);
        vm.prank(SUBMITTER);
        _invokeForward(application, inputs, original);
        assertTrue(application.usedNullifiers(inputs.nullifier));

        // Counted expectations are registered once, after the legitimate forward,
        // and cover all four following rejected requests in this test.
        _expectNoForwardCalls();
        IdentityApplicationA.ForwardRequest memory request = _forwardRequest(original.payload, CURRENT_TIME);
        _assertForwardRequestGuard(request, inputs, IdentityApplicationA.InvalidDeadline.selector);
        request = _forwardRequest(original.payload, original.deadline);
        request.destinationGateway = address(0);
        _assertForwardRequestGuard(request, inputs, IdentityApplicationA.InvalidDestinationGateway.selector);
        request = _forwardRequest(original.payload, original.deadline);
        request.destinationDomain = block.chainid;
        _assertForwardRequestGuard(request, inputs, IdentityApplicationA.InvalidDestinationDomain.selector);
        request = _forwardRequest(original.payload, original.deadline);
        request.destinationReceiver = address(0);
        _assertForwardRequestGuard(request, inputs, IdentityApplicationA.InvalidDestinationReceiver.selector);
    }

    function _expectNoForwardCalls() internal {
        vm.expectCall(address(verifier), abi.encodeWithSelector(ICredentialVerifier.verifyCredentialProof.selector), uint64(0));
        vm.expectCall(address(sourceGateway), abi.encodeWithSelector(MockSourceGateway.sendMessage.selector), uint64(0));
    }

    function _assertForwardRequestGuard(
        IdentityApplicationA.ForwardRequest memory request,
        ICredentialVerifier.CredentialPublicInputs memory inputs,
        bytes4 expectedError
    ) internal {
        bool nullifierBefore = application.usedNullifiers(inputs.nullifier);
        IdentityApplicationA.AuthorizationStatus statusBefore = application.authorizationStatus(inputs.credentialCommitment);
        verifier.setVerificationResult(false);
        vm.recordLogs();
        vm.prank(SUBMITTER);
        vm.expectRevert(expectedError);
        _invokeForward(application, inputs, request);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 0);
        assertEq(application.usedNullifiers(inputs.nullifier), nullifierBefore);
        assertEq(uint256(application.authorizationStatus(inputs.credentialCommitment)), uint256(statusBefore));
    }

    function testForwardIntentMutationsNeverConsumeNullifier() public {
        IdentityApplicationA.ForwardRequest memory original = _forwardRequest("supplier update", CURRENT_TIME + MESSAGE_LIFETIME);
        ICredentialVerifier.CredentialPublicInputs memory inputs = _forwardInputs(application, original, SUBMITTER, FORWARD_NULLIFIER);
        for (uint256 variant = 0; variant < FORWARD_INTENT_MUTATION_COUNT; ++variant) {
            IdentityApplicationA.ForwardRequest memory request = _forwardRequest(original.payload, original.deadline);
            // The loop only visits declared mutation cases.
            // forge-lint: disable-next-line(unsafe-typecast)
            _mutateForwardIntent(request, ForwardIntentMutation(variant));
            // Each case deliberately invokes local fixture contracts and VM assertions.
            // forge-lint: disable-next-line(calls-loop)
            vm.prank(SUBMITTER);
            // forge-lint: disable-next-line(calls-loop)
            vm.expectRevert(IdentityApplicationA.InvalidForwardIntent.selector);
            _invokeForward(application, inputs, request);
            // forge-lint: disable-next-line(calls-loop)
            assertFalse(application.usedNullifiers(inputs.nullifier));
            // forge-lint: disable-next-line(calls-loop)
            assertEq(sourceGateway.caller(), address(0));
        }
    }

    function _mutateForwardIntent(
        IdentityApplicationA.ForwardRequest memory request,
        ForwardIntentMutation variant
    ) private pure {
        if (variant == ForwardIntentMutation.PAYLOAD) request.payload = "different payload";
        if (variant == ForwardIntentMutation.DESTINATION_DOMAIN) request.destinationDomain += 1;
        if (variant == ForwardIntentMutation.DESTINATION_GATEWAY) request.destinationGateway = address(0xD00E);
        if (variant == ForwardIntentMutation.DESTINATION_RECEIVER) request.destinationReceiver = address(0xBEE1);
        if (variant == ForwardIntentMutation.DEADLINE) request.deadline += 1;
    }

    function testForwardProofTheftAndReplayAreRejected() public {
        IdentityApplicationA.ForwardRequest memory request = _forwardRequest("supplier update", CURRENT_TIME + MESSAGE_LIFETIME);
        ICredentialVerifier.CredentialPublicInputs memory inputs = _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER);
        vm.prank(UNAUTHORIZED_CALLER);
        vm.expectRevert(IdentityApplicationA.InvalidForwardIntent.selector);
        _invokeForward(application, inputs, request);
        assertFalse(application.usedNullifiers(inputs.nullifier));
        vm.prank(SUBMITTER);
        _invokeForward(application, inputs, request);
        assertTrue(application.usedNullifiers(inputs.nullifier));
        vm.prank(SUBMITTER);
        vm.expectRevert(IdentityApplicationA.NullifierAlreadyUsed.selector);
        _invokeForward(application, inputs, request);
    }

    function testStandaloneVerificationDoesNotAuthorizeForwarding() public {
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);
        IdentityApplicationA.ForwardRequest memory request = _forwardRequest("supplier update", CURRENT_TIME + MESSAGE_LIFETIME);
        ICredentialVerifier.CredentialPublicInputs memory inputs = _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER);
        inputs.actionContext = 1;
        inputs.forwardIntentDigestHi = 0;
        inputs.forwardIntentDigestLo = 0;
        vm.prank(SUBMITTER);
        vm.expectRevert(IdentityApplicationA.InvalidActionContext.selector);
        _invokeForward(application, inputs, request);
        assertEq(sourceGateway.caller(), address(0));
        inputs = _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER);
        vm.expectRevert(IdentityApplicationA.InvalidActionContext.selector);
        application.verifySupplier(_mockProofA(), _mockProofB(),
            _mockProofC(), inputs);
    }

    function testForwardingCannotReuseAnotherApplicationOrGatewayIntent() public {
        IdentityApplicationA.ForwardRequest memory request = _forwardRequest("supplier update", CURRENT_TIME + MESSAGE_LIFETIME);
        ICredentialVerifier.CredentialPublicInputs memory inputs = _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER);
        ForwardAuthorizationCodec.Intent memory intent = _intentFor(application, request, SUBMITTER);
        intent.sourceGateway = address(0x1002);
        (inputs.forwardIntentDigestHi, inputs.forwardIntentDigestLo) = ForwardAuthorizationCodec.split(ForwardAuthorizationCodec.digest(intent));
        vm.prank(SUBMITTER);
        vm.expectRevert(IdentityApplicationA.InvalidForwardIntent.selector);
        _invokeForward(application, inputs, request);
        IdentityApplicationA other = new IdentityApplicationA(address(verifier), address(sourceGateway), TRUSTED_ISSUER,
            REQUIRED_ROLE, MAX_PROOF_AGE, STATE_AUTHORITY, ROOT_N);
        inputs = _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER);
        vm.prank(SUBMITTER);
        vm.expectRevert(IdentityApplicationA.InvalidApplicationDomain.selector);
        _invokeForward(other, inputs, request);
    }

    function testForwardPolicyAndVerifierRejectionsLeaveNoGatewayCall() public {
        IdentityApplicationA.ForwardRequest memory request = _forwardRequest("supplier update", CURRENT_TIME + MESSAGE_LIFETIME);
        for (uint256 variant = 0; variant < FORWARD_POLICY_MUTATION_COUNT; ++variant) {
            ICredentialVerifier.CredentialPublicInputs memory inputs = _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER);
            // Every enum case returns its exact expected error, without an uninitialized selector.
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes4 reason = _mutateForwardPolicy(inputs, ForwardPolicyMutation(variant));
            // Each case deliberately invokes local fixture contracts and VM assertions.
            // forge-lint: disable-next-line(calls-loop)
            vm.prank(SUBMITTER);
            // forge-lint: disable-next-line(calls-loop)
            vm.expectRevert(reason);
            _invokeForward(application, inputs, request);
            // forge-lint: disable-next-line(calls-loop)
            assertFalse(application.usedNullifiers(inputs.nullifier));
            // forge-lint: disable-next-line(calls-loop)
            assertEq(sourceGateway.caller(), address(0));
        }
    }

    function _mutateForwardPolicy(
        ICredentialVerifier.CredentialPublicInputs memory inputs,
        ForwardPolicyMutation variant
    ) private returns (bytes4) {
        if (variant == ForwardPolicyMutation.ISSUER) {
            inputs.trustedIssuer += 1;
            return IdentityApplicationA.InvalidIssuerPolicy.selector;
        }
        if (variant == ForwardPolicyMutation.ROLE) {
            inputs.requiredRole = OTHER_ROLE;
            return IdentityApplicationA.InvalidRolePolicy.selector;
        }
        if (variant == ForwardPolicyMutation.FUTURE_TIMESTAMP) {
            inputs.currentTimestamp += 1;
            return IdentityApplicationA.FutureProofTimestamp.selector;
        }
        if (variant == ForwardPolicyMutation.STALE_TIMESTAMP) {
            inputs.currentTimestamp -= MAX_PROOF_AGE + 1;
            return IdentityApplicationA.StaleProofTimestamp.selector;
        }
        if (variant == ForwardPolicyMutation.CREDENTIAL_STATE_ROOT) {
            inputs.credentialStateRoot += 1;
            return IdentityApplicationA.InvalidCredentialStateRoot.selector;
        }
        if (variant == ForwardPolicyMutation.POLICY_EPOCH) {
            inputs.policyEpoch += 1;
            return IdentityApplicationA.InvalidPolicyEpoch.selector;
        }
        if (variant == ForwardPolicyMutation.INTENT_HIGH_LIMB) {
            inputs.forwardIntentDigestHi += 1;
            return IdentityApplicationA.InvalidForwardIntent.selector;
        }
        if (variant == ForwardPolicyMutation.INTENT_LOW_LIMB) {
            inputs.forwardIntentDigestLo += 1;
            return IdentityApplicationA.InvalidForwardIntent.selector;
        }
        if (variant == ForwardPolicyMutation.AUTHORIZATION_DEADLINE) {
            inputs.authorizationValidUntil = CURRENT_TIME;
            return IdentityApplicationA.AuthorizationExpired.selector;
        }
        // VERIFIER_REJECTION is the final enum member and is visited last by this fixture.
        // forge-lint: disable-next-line(calls-loop)
        verifier.setVerificationResult(false);
        return IdentityApplicationA.InvalidCredentialProof.selector;
    }

    function testRevokedCredentialAndOldEpochCannotForward() public {
        IdentityApplicationA.ForwardRequest memory request = _forwardRequest("supplier update", CURRENT_TIME + MESSAGE_LIFETIME);
        ICredentialVerifier.CredentialPublicInputs memory inputs = _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER);
        vm.prank(STATE_AUTHORITY);
        application.advancePolicyEpoch();
        vm.prank(SUBMITTER);
        vm.expectRevert(IdentityApplicationA.InvalidPolicyEpoch.selector);
        _invokeForward(application, inputs, request);
        _revokeCredential(CREDENTIAL_COMMITMENT);
        inputs = _forwardInputs(application, request, SUBMITTER, FORWARD_NULLIFIER);
        vm.prank(SUBMITTER);
        vm.expectRevert(IdentityApplicationA.RevokedCredential.selector);
        _invokeForward(application, inputs, request);
    }

    function testNoProofSelectorCannotEmitMessage() public {
        bytes memory legacyCalldata = abi.encodeWithSignature(
            "sendCrossChainMessage(uint256,address,address,bytes,uint256)",
            DESTINATION_DOMAIN, DESTINATION_GATEWAY, DESTINATION_RECEIVER, "supplier update", CURRENT_TIME + MESSAGE_LIFETIME);
        // A raw selector call is required to prove the no-proof entry point is absent.
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory result) = address(application).call(legacyCalldata);
        assertFalse(success);
        assertEq(result.length, 0);
        assertEq(sourceGateway.caller(), address(0));
    }

    function _assertRealGatewayEvent(
        Vm.Log[] memory logs,
        SourceGateway realSourceGateway,
        IdentityApplicationA realGatewayApplication,
        bytes32 expectedMessageId,
        bytes memory expectedPayload,
        uint256 expectedDeadline
    ) internal view {
        assertEq(logs.length, FORWARD_EVENT_COUNT);
        assertEq(logs[0].topics[0], IdentityApplicationA.NullifierConsumed.selector);
        assertEq(logs[FORWARD_EVENT_COUNT - 1].topics[0], IdentityApplicationA.AuthorizedMessageForwarded.selector);
        assertEq(logs[FORWARD_EVENT_COUNT - 1].topics[1], ForwardAuthorizationCodec.digest(
            _intentFor(realGatewayApplication, _forwardRequest(expectedPayload, expectedDeadline), SUBMITTER)));
        assertEq(logs[FORWARD_EVENT_COUNT - 1].topics[2], bytes32(FORWARD_NULLIFIER));
        assertEq(logs[FORWARD_EVENT_COUNT - 1].topics[FORWARD_EVENT_TOPIC_COUNT - 1], expectedMessageId);
        assertEq(logs[1].emitter, address(realSourceGateway));
        assertEq(logs[1].topics.length, GATEWAY_EVENT_TOPIC_COUNT);
        assertEq(logs[1].topics[0], SourceGateway.CrossChainMessage.selector);
        assertEq(logs[1].topics[1], expectedMessageId);
        assertEq(logs[1].topics[2], bytes32(uint256(uint160(address(realGatewayApplication)))));
        assertEq(logs[1].topics[GATEWAY_EVENT_TOPIC_COUNT - 1], bytes32(DESTINATION_DOMAIN));

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
            logs[1].data,
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
            INITIAL_POLICY_EPOCH,
            ACTION_VERIFY_SUPPLIER,
            _nullifierFor(credentialCommitment, INITIAL_POLICY_EPOCH)
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
            INITIAL_POLICY_EPOCH,
            ACTION_VERIFY_SUPPLIER,
            _nullifierFor(credentialCommitment, INITIAL_POLICY_EPOCH)
        );
    }

    function _verifySupplierWithContext(
        uint256 credentialCommitment,
        uint256 proofTrustedIssuer,
        uint256 proofRequiredRole,
        uint256 proofTimestamp,
        uint256 proofCredentialStateRoot,
        uint256 proofApplicationDomainValue,
        uint256 proofPolicyEpochValue,
        uint256 proofActionContext,
        uint256 proofNullifier
    ) internal {
        ICredentialVerifier.CredentialPublicInputs memory publicInputs;
        publicInputs.credentialCommitment = credentialCommitment;
        publicInputs.trustedIssuer = proofTrustedIssuer;
        publicInputs.requiredRole = proofRequiredRole;
        publicInputs.currentTimestamp = proofTimestamp;
        publicInputs.credentialStateRoot = proofCredentialStateRoot;
        publicInputs.applicationDomain = proofApplicationDomainValue;
        publicInputs.policyEpoch = proofPolicyEpochValue;
        publicInputs.actionContext = proofActionContext;
        publicInputs.nullifier = proofNullifier;
        publicInputs.forwardIntentDigestHi = 0;
        publicInputs.forwardIntentDigestLo = 0;
        publicInputs.authorizationValidUntil = CURRENT_TIME + 2 * ONE_HOUR;

        application.verifySupplier(
            _mockProofA(),
            _mockProofB(),
            _mockProofC(),
            publicInputs
        );
    }

    function _mockProofA() internal pure returns (uint256[PROOF_PAIR_SIZE] memory) {
        return [uint256(1), uint256(2)];
    }

    function _mockProofB() internal pure returns (uint256[PROOF_PAIR_SIZE][PROOF_PAIR_SIZE] memory) {
        return [[uint256(3), uint256(4)], [uint256(5), uint256(6)]];
    }

    function _mockProofC() internal pure returns (uint256[PROOF_PAIR_SIZE] memory) {
        return [uint256(7), uint256(8)];
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
