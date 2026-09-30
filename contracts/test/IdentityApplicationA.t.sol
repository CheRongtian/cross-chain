// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {IdentityApplicationA} from "../src/IdentityApplicationA.sol";
import {MockCredentialVerifier} from "./mocks/MockCredentialVerifier.sol";

contract IdentityApplicationATest is Test {
    uint256 internal constant TRUSTED_ISSUER = 12_345;
    uint256 internal constant REQUIRED_ROLE = 1;
    uint256 internal constant MAX_PROOF_AGE = 1 hours;
    uint256 internal constant CREDENTIAL_COMMITMENT = 98_765;
    uint256 internal constant SECOND_CREDENTIAL_COMMITMENT = 98_766;
    uint256 internal constant CURRENT_TIME = 2_000_000_000;
    uint256 internal constant ROOT_N = 111_111;
    uint256 internal constant ROOT_N_PLUS_ONE = 222_222;
    uint256 internal constant INDEXED_EVENT_TOPIC_COUNT = 3;
    address internal constant SUBMITTER = address(0xA11CE);
    address internal constant STATE_AUTHORITY = address(0xA11CE5);
    address internal constant UNAUTHORIZED_CALLER = address(0xBAD);

    MockCredentialVerifier internal verifier;
    IdentityApplicationA internal application;

    function setUp() public {
        vm.warp(CURRENT_TIME);
        verifier = new MockCredentialVerifier();
        verifier.setVerificationResult(true);
        application = new IdentityApplicationA(
            address(verifier), TRUSTED_ISSUER, REQUIRED_ROLE, MAX_PROOF_AGE, STATE_AUTHORITY, ROOT_N
        );
    }

    function testConstructorConfiguration() public view {
        assertEq(address(application.credentialVerifier()), address(verifier));
        assertEq(application.trustedIssuer(), TRUSTED_ISSUER);
        assertEq(application.requiredRole(), REQUIRED_ROLE);
        assertEq(application.maxProofAge(), MAX_PROOF_AGE);
        assertEq(application.VERIFIED_SUPPLIER_ROLE(), REQUIRED_ROLE);
        assertEq(application.credentialStateAuthority(), STATE_AUTHORITY);
        assertEq(application.credentialStateRoot(), ROOT_N);
    }

    function testCommitmentStartsUnverified() public view {
        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.UNVERIFIED)
        );
        assertFalse(application.isVerifiedSupplier(CREDENTIAL_COMMITMENT));
    }

    function testRejectsZeroVerifierAddress() public {
        vm.expectRevert(IdentityApplicationA.InvalidCredentialVerifier.selector);
        new IdentityApplicationA(address(0), TRUSTED_ISSUER, REQUIRED_ROLE, MAX_PROOF_AGE, STATE_AUTHORITY, ROOT_N);
    }

    function testRejectsAddressWithoutVerifierCode() public {
        vm.expectRevert(IdentityApplicationA.InvalidCredentialVerifier.selector);
        new IdentityApplicationA(address(0xBEEF), TRUSTED_ISSUER, REQUIRED_ROLE, MAX_PROOF_AGE, STATE_AUTHORITY, ROOT_N);
    }

    function testRejectsNonSupplierRoleConfiguration() public {
        vm.expectRevert(IdentityApplicationA.InvalidRequiredRole.selector);
        new IdentityApplicationA(address(verifier), TRUSTED_ISSUER, 2, MAX_PROOF_AGE, STATE_AUTHORITY, ROOT_N);
    }

    function testRejectsZeroMaxProofAge() public {
        vm.expectRevert(IdentityApplicationA.InvalidMaxProofAge.selector);
        new IdentityApplicationA(address(verifier), TRUSTED_ISSUER, REQUIRED_ROLE, 0, STATE_AUTHORITY, ROOT_N);
    }

    function testRejectsZeroCredentialStateAuthority() public {
        vm.expectRevert(IdentityApplicationA.InvalidCredentialStateAuthority.selector);
        new IdentityApplicationA(address(verifier), TRUSTED_ISSUER, REQUIRED_ROLE, MAX_PROOF_AGE, address(0), ROOT_N);
    }

    function testRejectsZeroInitialCredentialStateRoot() public {
        vm.expectRevert(IdentityApplicationA.InvalidCredentialStateRoot.selector);
        new IdentityApplicationA(address(verifier), TRUSTED_ISSUER, REQUIRED_ROLE, MAX_PROOF_AGE, STATE_AUTHORITY, 0);
    }

    function testValidProofAuthorizesCredentialCommitment() public {
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.VERIFIED_SUPPLIER)
        );
        assertTrue(application.isVerifiedSupplier(CREDENTIAL_COMMITMENT));
    }

    function testEmitsSupplierVerified() public {
        vm.recordLogs();
        vm.prank(SUBMITTER);
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);

        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(application));
        assertEq(logs[0].topics.length, INDEXED_EVENT_TOPIC_COUNT);
        assertEq(logs[0].topics[0], IdentityApplicationA.SupplierVerified.selector);
        assertEq(logs[0].topics[1], bytes32(CREDENTIAL_COMMITMENT));
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(SUBMITTER))));
        assertEq(abi.decode(logs[0].data, (uint256)), CURRENT_TIME);
    }

    function testRejectsVerifierFailureAndLeavesStatusUnchanged() public {
        verifier.setVerificationResult(false);
        vm.expectRevert(IdentityApplicationA.InvalidCredentialProof.selector);

        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.UNVERIFIED)
        );
    }

    function testRejectsWrongIssuerBeforeVerifierCall() public {
        verifier.setVerificationResult(false);
        vm.expectRevert(IdentityApplicationA.InvalidIssuerPolicy.selector);

        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER + 1, REQUIRED_ROLE, CURRENT_TIME);
    }

    function testRejectsWrongRoleBeforeVerifierCall() public {
        verifier.setVerificationResult(false);
        vm.expectRevert(IdentityApplicationA.InvalidRolePolicy.selector);

        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, 2, CURRENT_TIME);
    }

    function testRejectsFutureProofTimestamp() public {
        vm.expectRevert(IdentityApplicationA.FutureProofTimestamp.selector);

        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME + 1);
    }

    function testRejectsStaleProofTimestamp() public {
        vm.expectRevert(IdentityApplicationA.StaleProofTimestamp.selector);

        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME - MAX_PROOF_AGE - 1);
    }

    function testRejectsProofForNonCurrentCredentialStateRoot() public {
        vm.expectRevert(IdentityApplicationA.InvalidCredentialStateRoot.selector);

        _verifySupplierWithRoot(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME, ROOT_N_PLUS_ONE);

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.UNVERIFIED)
        );
    }

    function testAcceptsProofAtMaximumAge() public {
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME - MAX_PROOF_AGE);

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.VERIFIED_SUPPLIER)
        );
    }

    function testDuplicateValidProofIsIdempotent() public {
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.VERIFIED_SUPPLIER)
        );
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
    }

    function _verifySupplier(
        uint256 credentialCommitment,
        uint256 proofTrustedIssuer,
        uint256 proofRequiredRole,
        uint256 proofTimestamp
    ) internal {
        _verifySupplierWithRoot(credentialCommitment, proofTrustedIssuer, proofRequiredRole, proofTimestamp, ROOT_N);
    }

    function _verifySupplierWithRoot(
        uint256 credentialCommitment,
        uint256 proofTrustedIssuer,
        uint256 proofRequiredRole,
        uint256 proofTimestamp,
        uint256 proofCredentialStateRoot
    ) internal {
        application.verifySupplier(
            [uint256(1), uint256(2)],
            [[uint256(3), uint256(4)], [uint256(5), uint256(6)]],
            [uint256(7), uint256(8)],
            credentialCommitment,
            proofTrustedIssuer,
            proofRequiredRole,
            proofTimestamp,
            proofCredentialStateRoot
        );
    }

    function _revokeCredential(uint256 credentialCommitment) internal {
        uint256[] memory revokedCredentialCommitments = new uint256[](1);
        revokedCredentialCommitments[0] = credentialCommitment;

        vm.prank(STATE_AUTHORITY);
        application.updateCredentialStateRoot(ROOT_N_PLUS_ONE, revokedCredentialCommitments);
    }
}
