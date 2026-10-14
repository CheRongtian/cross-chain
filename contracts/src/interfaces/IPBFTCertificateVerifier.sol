// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read-only verification of the existing versioned PBFT transport evidence.
interface IPBFTCertificateVerifier {
    /// @dev The caller must obtain these fields from its trusted batch context.
    /// authorityEpoch is registry metadata for legacy evidence; it is signed only in v3.
    /// viewNumber names the protocol's view field without changing its ABI position or signed bytes.
    struct ExpectedContext {
        uint8 protocolVersion;
        uint256 sourceDomain;
        address sourceGateway;
        uint256 batchEpoch;
        uint256 viewNumber;
        bytes32 batchId;
        bytes32 messageRoot;
        uint256 authorityEpoch;
    }

    /// @notice Returns true for a valid certificate; invalid evidence reverts.
    /// @dev This does not authorize delivery, verify a Merkle proof or consume a message.
    function verifyCertificate(bytes calldata certificate, ExpectedContext calldata expected)
        external
        view
        returns (bool);
}
