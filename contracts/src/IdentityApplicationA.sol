// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICredentialVerifier} from "./interfaces/ICredentialVerifier.sol";

/// @notice Applies Chain A supplier policy to credential authorization proofs.
contract IdentityApplicationA {
    enum AuthorizationStatus {
        UNVERIFIED,
        VERIFIED_SUPPLIER
    }

    uint256 public constant VERIFIED_SUPPLIER_ROLE = 1;

    // Lower camel case gives the public configuration getters conventional ABI names.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    ICredentialVerifier public immutable credentialVerifier;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint256 public immutable trustedIssuer;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint256 public immutable requiredRole;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint256 public immutable maxProofAge;

    mapping(uint256 credentialCommitment => AuthorizationStatus status) public authorizationStatus;

    error InvalidCredentialVerifier();
    error InvalidRequiredRole();
    error InvalidMaxProofAge();
    error InvalidIssuerPolicy();
    error InvalidRolePolicy();
    error FutureProofTimestamp();
    error StaleProofTimestamp();
    error InvalidCredentialProof();

    event SupplierVerified(uint256 indexed credentialCommitment, address indexed submitter, uint256 proofTimestamp);

    constructor(
        address credentialVerifierAddress,
        uint256 trustedIssuer_,
        uint256 requiredRole_,
        uint256 maxProofAge_
    ) {
        if (credentialVerifierAddress.code.length == 0) {
            revert InvalidCredentialVerifier();
        }
        if (requiredRole_ != VERIFIED_SUPPLIER_ROLE) {
            revert InvalidRequiredRole();
        }
        if (maxProofAge_ == 0) {
            revert InvalidMaxProofAge();
        }

        credentialVerifier = ICredentialVerifier(credentialVerifierAddress);
        trustedIssuer = trustedIssuer_;
        requiredRole = requiredRole_;
        maxProofAge = maxProofAge_;
    }

    function verifySupplier(
        uint256[2] calldata proofA,
        uint256[2][2] calldata proofB,
        uint256[2] calldata proofC,
        uint256 credentialCommitment,
        uint256 proofTrustedIssuer,
        uint256 proofRequiredRole,
        uint256 proofTimestamp
    ) external {
        if (proofTrustedIssuer != trustedIssuer) {
            revert InvalidIssuerPolicy();
        }
        if (proofRequiredRole != requiredRole) {
            revert InvalidRolePolicy();
        }
        // Proof freshness is intentionally anchored to Chain A's consensus timestamp.
        // forge-lint: disable-next-line(block-timestamp)
        if (proofTimestamp > block.timestamp) {
            revert FutureProofTimestamp();
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp - proofTimestamp > maxProofAge) {
            revert StaleProofTimestamp();
        }

        bool valid = credentialVerifier.verifyCredentialProof(
            proofA, proofB, proofC, credentialCommitment, proofTrustedIssuer, proofRequiredRole, proofTimestamp
        );
        if (!valid) {
            revert InvalidCredentialProof();
        }

        authorizationStatus[credentialCommitment] = AuthorizationStatus.VERIFIED_SUPPLIER;
        emit SupplierVerified(credentialCommitment, msg.sender, proofTimestamp);
    }
}
