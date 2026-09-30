// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stable project-facing interface for credential authorization proofs.
interface ICredentialVerifier {
    function verifyCredentialProof(
        uint256[2] calldata proofA,
        uint256[2][2] calldata proofB,
        uint256[2] calldata proofC,
        uint256 credentialCommitment,
        uint256 trustedIssuer,
        uint256 requiredRole,
        uint256 currentTimestamp
    ) external view returns (bool);
}
