// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stable project-facing interface for credential authorization proofs.
interface ICredentialVerifier {
    struct CredentialPublicInputs {
        uint256 credentialCommitment;
        uint256 trustedIssuer;
        uint256 requiredRole;
        uint256 currentTimestamp;
        uint256 credentialStateRoot;
        uint256 applicationDomain;
        uint256 policyEpoch;
        uint256 actionContext;
        uint256 nullifier;
    }

    function verifyCredentialProof(
        uint256[2] calldata proofA,
        uint256[2][2] calldata proofB,
        uint256[2] calldata proofC,
        CredentialPublicInputs calldata publicInputs
    ) external view returns (bool);
}
