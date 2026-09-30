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
    uint256 internal constant CURRENT_TIME = 2_000_000_000;
    uint256 internal constant SUPPLIER_VERIFIED_TOPIC_COUNT = 3;
    address internal constant SUBMITTER = address(0xA11CE);

    MockCredentialVerifier internal verifier;
    IdentityApplicationA internal application;

    function setUp() public {
        vm.warp(CURRENT_TIME);
        verifier = new MockCredentialVerifier();
        verifier.setVerificationResult(true);
        application = new IdentityApplicationA(address(verifier), TRUSTED_ISSUER, REQUIRED_ROLE, MAX_PROOF_AGE);
    }

    function testConstructorConfiguration() public view {
        assertEq(address(application.credentialVerifier()), address(verifier));
        assertEq(application.trustedIssuer(), TRUSTED_ISSUER);
        assertEq(application.requiredRole(), REQUIRED_ROLE);
        assertEq(application.maxProofAge(), MAX_PROOF_AGE);
        assertEq(application.VERIFIED_SUPPLIER_ROLE(), REQUIRED_ROLE);
    }

    function testCommitmentStartsUnverified() public view {
        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.UNVERIFIED)
        );
    }

    function testRejectsZeroVerifierAddress() public {
        vm.expectRevert(IdentityApplicationA.InvalidCredentialVerifier.selector);
        new IdentityApplicationA(address(0), TRUSTED_ISSUER, REQUIRED_ROLE, MAX_PROOF_AGE);
    }

    function testRejectsAddressWithoutVerifierCode() public {
        vm.expectRevert(IdentityApplicationA.InvalidCredentialVerifier.selector);
        new IdentityApplicationA(address(0xBEEF), TRUSTED_ISSUER, REQUIRED_ROLE, MAX_PROOF_AGE);
    }

    function testRejectsNonSupplierRoleConfiguration() public {
        vm.expectRevert(IdentityApplicationA.InvalidRequiredRole.selector);
        new IdentityApplicationA(address(verifier), TRUSTED_ISSUER, 2, MAX_PROOF_AGE);
    }

    function testRejectsZeroMaxProofAge() public {
        vm.expectRevert(IdentityApplicationA.InvalidMaxProofAge.selector);
        new IdentityApplicationA(address(verifier), TRUSTED_ISSUER, REQUIRED_ROLE, 0);
    }

    function testValidProofAuthorizesCredentialCommitment() public {
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);

        assertEq(
            uint256(application.authorizationStatus(CREDENTIAL_COMMITMENT)),
            uint256(IdentityApplicationA.AuthorizationStatus.VERIFIED_SUPPLIER)
        );
    }

    function testEmitsSupplierVerified() public {
        vm.recordLogs();
        vm.prank(SUBMITTER);
        _verifySupplier(CREDENTIAL_COMMITMENT, TRUSTED_ISSUER, REQUIRED_ROLE, CURRENT_TIME);

        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(application));
        assertEq(logs[0].topics.length, SUPPLIER_VERIFIED_TOPIC_COUNT);
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

    function _verifySupplier(
        uint256 credentialCommitment,
        uint256 proofTrustedIssuer,
        uint256 proofRequiredRole,
        uint256 proofTimestamp
    ) internal {
        application.verifySupplier(
            [uint256(1), uint256(2)],
            [[uint256(3), uint256(4)], [uint256(5), uint256(6)]],
            [uint256(7), uint256(8)],
            credentialCommitment,
            proofTrustedIssuer,
            proofRequiredRole,
            proofTimestamp
        );
    }
}
