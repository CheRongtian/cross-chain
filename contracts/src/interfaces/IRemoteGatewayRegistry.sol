// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read-only boundary for resolving trusted remote source gateways.
interface IRemoteGatewayRegistry {
    /// @notice Returns the currently trusted remote gateway, or zero when the domain is unknown.
    function trustedRemoteGateway(uint256 sourceDomain) external view returns (address);

    /// @notice Returns whether the supplied address is the current gateway for the source domain.
    function isTrustedRemoteGateway(uint256 sourceDomain, address sourceGateway) external view returns (bool);

    /// @notice Reverts unless the supplied domain and gateway are the current trusted pair.
    function requireTrustedRemoteGateway(uint256 sourceDomain, address sourceGateway) external view;
}
