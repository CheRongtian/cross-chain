// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICredentialVerifier} from "./interfaces/ICredentialVerifier.sol";
import {ISourceGateway} from "./interfaces/ISourceGateway.sol";

/// @notice Applies Chain A supplier policy to credential authorization proofs.
contract IdentityApplicationA {
    enum AuthorizationStatus {
        UNVERIFIED,
        VERIFIED_SUPPLIER,
        REVOKED
    }

    uint256 public constant VERIFIED_SUPPLIER_ROLE = 1;
    uint256 public constant ACTION_VERIFY_SUPPLIER = 1;
    uint256 public constant INITIAL_POLICY_EPOCH = 1;
    uint256 public constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    bytes32 public constant APPLICATION_DOMAIN_NAMESPACE = keccak256("cross-chain:identity-application-domain:v1");

    // Lower camel case gives the public configuration getters conventional ABI names.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    ICredentialVerifier public immutable credentialVerifier;
    // Lower camel case preserves the project-facing getter name.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    ISourceGateway public immutable sourceGateway;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint256 public immutable trustedIssuer;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint256 public immutable requiredRole;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint256 public immutable maxProofAge;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable credentialStateAuthority;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint256 public immutable applicationDomain;

    uint256 public credentialStateRoot;
    uint256 public currentPolicyEpoch = INITIAL_POLICY_EPOCH;

    mapping(uint256 credentialCommitment => AuthorizationStatus status) public authorizationStatus;
    mapping(uint256 nullifier => bool used) public usedNullifiers;

    error InvalidCredentialVerifier();
    error InvalidSourceGateway();
    error InvalidRequiredRole();
    error InvalidMaxProofAge();
    error InvalidCredentialStateAuthority();
    error InvalidCredentialStateRoot();
    error UnauthorizedCredentialStateAuthority();
    error UnauthorizedPolicyEpochAuthority();
    error RevokedCredential();
    error InvalidIssuerPolicy();
    error InvalidRolePolicy();
    error FutureProofTimestamp();
    error StaleProofTimestamp();
    error InvalidApplicationDomain();
    error InvalidPolicyEpoch();
    error InvalidActionContext();
    error InvalidNullifier();
    error NullifierAlreadyUsed();
    error InvalidCredentialProof();

    event SupplierVerified(uint256 indexed credentialCommitment, address indexed submitter, uint256 proofTimestamp);
    event CredentialStateRootUpdated(uint256 indexed oldRoot, uint256 indexed newRoot);
    event CredentialRevoked(uint256 indexed credentialCommitment);
    event NullifierConsumed(
        uint256 indexed nullifier,
        uint256 indexed credentialCommitment,
        uint256 policyEpoch,
        uint256 actionContext
    );
    event PolicyEpochAdvanced(uint256 indexed oldEpoch, uint256 indexed newEpoch);

    constructor(
        address credentialVerifierAddress,
        address sourceGatewayAddress,
        uint256 trustedIssuer_,
        uint256 requiredRole_,
        uint256 maxProofAge_,
        address credentialStateAuthorityAddress,
        uint256 initialCredentialStateRoot
    ) {
        if (credentialVerifierAddress.code.length == 0) {
            revert InvalidCredentialVerifier();
        }
        if (sourceGatewayAddress.code.length == 0) {
            revert InvalidSourceGateway();
        }
        if (requiredRole_ != VERIFIED_SUPPLIER_ROLE) {
            revert InvalidRequiredRole();
        }
        if (maxProofAge_ == 0) {
            revert InvalidMaxProofAge();
        }
        if (credentialStateAuthorityAddress == address(0)) {
            revert InvalidCredentialStateAuthority();
        }
        if (initialCredentialStateRoot == 0) {
            revert InvalidCredentialStateRoot();
        }

        credentialVerifier = ICredentialVerifier(credentialVerifierAddress);
        sourceGateway = ISourceGateway(sourceGatewayAddress);
        trustedIssuer = trustedIssuer_;
        requiredRole = requiredRole_;
        maxProofAge = maxProofAge_;
        credentialStateAuthority = credentialStateAuthorityAddress;
        credentialStateRoot = initialCredentialStateRoot;
        applicationDomain = uint256(
            keccak256(abi.encode(APPLICATION_DOMAIN_NAMESPACE, block.chainid, address(this)))
        ) % SNARK_SCALAR_FIELD;
    }

    function updateCredentialStateRoot(uint256 newRoot, uint256[] calldata revokedCredentialCommitments) external {
        if (msg.sender != credentialStateAuthority) {
            revert UnauthorizedCredentialStateAuthority();
        }
        if (newRoot == 0) {
            revert InvalidCredentialStateRoot();
        }

        uint256 oldRoot = credentialStateRoot;
        credentialStateRoot = newRoot;
        emit CredentialStateRootUpdated(oldRoot, newRoot);

        for (uint256 index = 0; index < revokedCredentialCommitments.length; index++) {
            uint256 credentialCommitment = revokedCredentialCommitments[index];

            if (authorizationStatus[credentialCommitment] != AuthorizationStatus.REVOKED) {
                // Every listed commitment must retain an explicit on-chain revoked state.
                // forge-lint: disable-next-line(costly-loop)
                authorizationStatus[credentialCommitment] = AuthorizationStatus.REVOKED;
                emit CredentialRevoked(credentialCommitment);
            }
        }
    }

    function advancePolicyEpoch() external {
        if (msg.sender != credentialStateAuthority) {
            revert UnauthorizedPolicyEpochAuthority();
        }

        uint256 oldEpoch = currentPolicyEpoch;
        uint256 newEpoch = oldEpoch + 1;
        currentPolicyEpoch = newEpoch;
        emit PolicyEpochAdvanced(oldEpoch, newEpoch);
    }

    function verifySupplier(
        uint256[2] calldata proofA,
        uint256[2][2] calldata proofB,
        uint256[2] calldata proofC,
        ICredentialVerifier.CredentialPublicInputs calldata publicInputs
    ) external {
        _validateProofPolicy(publicInputs);
        _validateCredentialState(publicInputs);
        _validateNullifierContext(publicInputs);

        bool valid = credentialVerifier.verifyCredentialProof(proofA, proofB, proofC, publicInputs);
        if (!valid) {
            revert InvalidCredentialProof();
        }

        usedNullifiers[publicInputs.nullifier] = true;
        authorizationStatus[publicInputs.credentialCommitment] = AuthorizationStatus.VERIFIED_SUPPLIER;

        emit NullifierConsumed(
            publicInputs.nullifier,
            publicInputs.credentialCommitment,
            publicInputs.policyEpoch,
            publicInputs.actionContext
        );
        emit SupplierVerified(publicInputs.credentialCommitment, msg.sender, publicInputs.currentTimestamp);
    }

    function sendCrossChainMessage(
        uint256 destinationDomain,
        address destinationGateway,
        address destinationReceiver,
        bytes calldata payload,
        uint256 deadline
    ) external returns (bytes32 messageId, uint256 nonce) {
        return sourceGateway.sendMessage(
            destinationDomain,
            destinationGateway,
            destinationReceiver,
            payload,
            deadline
        );
    }

    function isVerifiedSupplier(uint256 credentialCommitment) external view returns (bool) {
        return authorizationStatus[credentialCommitment] == AuthorizationStatus.VERIFIED_SUPPLIER;
    }

    function _validateProofPolicy(ICredentialVerifier.CredentialPublicInputs calldata publicInputs) internal view {
        if (publicInputs.trustedIssuer != trustedIssuer) {
            revert InvalidIssuerPolicy();
        }
        if (publicInputs.requiredRole != requiredRole) {
            revert InvalidRolePolicy();
        }
        // Proof freshness is intentionally anchored to Chain A's consensus timestamp.
        // forge-lint: disable-next-line(block-timestamp)
        if (publicInputs.currentTimestamp > block.timestamp) {
            revert FutureProofTimestamp();
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp - publicInputs.currentTimestamp > maxProofAge) {
            revert StaleProofTimestamp();
        }
    }

    function _validateCredentialState(ICredentialVerifier.CredentialPublicInputs calldata publicInputs)
        internal
        view
    {
        if (publicInputs.credentialStateRoot != credentialStateRoot) {
            revert InvalidCredentialStateRoot();
        }
        if (authorizationStatus[publicInputs.credentialCommitment] == AuthorizationStatus.REVOKED) {
            revert RevokedCredential();
        }
    }

    function _validateNullifierContext(ICredentialVerifier.CredentialPublicInputs calldata publicInputs)
        internal
        view
    {
        if (publicInputs.applicationDomain != applicationDomain) {
            revert InvalidApplicationDomain();
        }
        if (publicInputs.policyEpoch != currentPolicyEpoch) {
            revert InvalidPolicyEpoch();
        }
        if (publicInputs.actionContext != ACTION_VERIFY_SUPPLIER) {
            revert InvalidActionContext();
        }
        if (publicInputs.nullifier >= SNARK_SCALAR_FIELD) {
            revert InvalidNullifier();
        }
        if (usedNullifiers[publicInputs.nullifier]) {
            revert NullifierAlreadyUsed();
        }
    }
}
