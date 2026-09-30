// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICredentialVerifier} from "./interfaces/ICredentialVerifier.sol";
import {IGroth16Verifier} from "./interfaces/IGroth16Verifier.sol";

/// @notice Adapts the generated Groth16 verifier to named credential policy inputs.
contract CredentialVerifier is ICredentialVerifier {
    uint256 public constant CREDENTIAL_COMMITMENT_INDEX = 0;
    uint256 public constant TRUSTED_ISSUER_INDEX = 1;
    uint256 public constant REQUIRED_ROLE_INDEX = 2;
    uint256 public constant CURRENT_TIMESTAMP_INDEX = 3;
    uint256 public constant CREDENTIAL_STATE_ROOT_INDEX = 4;
    uint256 public constant APPLICATION_DOMAIN_INDEX = 5;
    uint256 public constant POLICY_EPOCH_INDEX = 6;
    uint256 public constant ACTION_CONTEXT_INDEX = 7;
    uint256 public constant NULLIFIER_INDEX = 8;

    // Lower camel case preserves the existing project-facing getter name.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    IGroth16Verifier public immutable groth16Verifier;

    error InvalidGroth16Verifier();

    constructor(address groth16VerifierAddress) {
        if (groth16VerifierAddress.code.length == 0) {
            revert InvalidGroth16Verifier();
        }

        groth16Verifier = IGroth16Verifier(groth16VerifierAddress);
    }

    function verifyCredentialProof(
        uint256[2] calldata proofA,
        uint256[2][2] calldata proofB,
        uint256[2] calldata proofC,
        CredentialPublicInputs calldata publicInputs
    ) external view returns (bool) {
        uint256[9] memory publicSignals;
        publicSignals[CREDENTIAL_COMMITMENT_INDEX] = publicInputs.credentialCommitment;
        publicSignals[TRUSTED_ISSUER_INDEX] = publicInputs.trustedIssuer;
        publicSignals[REQUIRED_ROLE_INDEX] = publicInputs.requiredRole;
        publicSignals[CURRENT_TIMESTAMP_INDEX] = publicInputs.currentTimestamp;
        publicSignals[CREDENTIAL_STATE_ROOT_INDEX] = publicInputs.credentialStateRoot;
        publicSignals[APPLICATION_DOMAIN_INDEX] = publicInputs.applicationDomain;
        publicSignals[POLICY_EPOCH_INDEX] = publicInputs.policyEpoch;
        publicSignals[ACTION_CONTEXT_INDEX] = publicInputs.actionContext;
        publicSignals[NULLIFIER_INDEX] = publicInputs.nullifier;

        return groth16Verifier.verifyProof(proofA, proofB, proofC, publicSignals);
    }
}
