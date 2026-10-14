// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRemoteGatewayRegistry} from "./interfaces/IRemoteGatewayRegistry.sol";

/// @notice Maintains the current trusted remote source gateway for each source domain.
contract RemoteGatewayRegistry is IRemoteGatewayRegistry {
    // Lower camel case preserves the project-facing getter name.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable registryAdmin;

    mapping(uint256 sourceDomain => address sourceGateway) public override trustedRemoteGateway;

    error InvalidRegistryAdmin();
    error UnauthorizedRegistryAdmin();
    error InvalidRemoteGateway();
    error RemoteGatewayUnchanged(uint256 sourceDomain, address sourceGateway);
    error UnknownSourceDomain(uint256 sourceDomain);
    error UntrustedRemoteGateway(uint256 sourceDomain, address suppliedGateway, address trustedGateway);

    event RemoteGatewayUpdated(
        uint256 indexed sourceDomain,
        address indexed previousGateway,
        address indexed newGateway
    );

    constructor(address registryAdmin_) {
        if (registryAdmin_ == address(0)) {
            revert InvalidRegistryAdmin();
        }

        registryAdmin = registryAdmin_;
    }

    /// @notice Adds or replaces the current trusted remote gateway for a source domain.
    function setRemoteGateway(uint256 sourceDomain, address sourceGateway) external {
        _requireRegistryAdmin();
        if (sourceGateway == address(0)) {
            revert InvalidRemoteGateway();
        }

        address previousGateway = trustedRemoteGateway[sourceDomain];
        if (previousGateway == sourceGateway) {
            revert RemoteGatewayUnchanged(sourceDomain, sourceGateway);
        }

        // The trust change is emitted immediately below.
        // forge-lint: disable-next-line(missing-events-access-control)
        trustedRemoteGateway[sourceDomain] = sourceGateway;
        emit RemoteGatewayUpdated(sourceDomain, previousGateway, sourceGateway);
    }

    /// @notice Removes the current trusted remote gateway for a source domain.
    function removeRemoteGateway(uint256 sourceDomain) external {
        _requireRegistryAdmin();

        address previousGateway = trustedRemoteGateway[sourceDomain];
        if (previousGateway == address(0)) {
            revert UnknownSourceDomain(sourceDomain);
        }

        // The trust change is emitted immediately below.
        // forge-lint: disable-next-line(missing-events-access-control)
        delete trustedRemoteGateway[sourceDomain];
        emit RemoteGatewayUpdated(sourceDomain, previousGateway, address(0));
    }

    /// @inheritdoc IRemoteGatewayRegistry
    function isTrustedRemoteGateway(uint256 sourceDomain, address sourceGateway)
        external
        view
        override
        returns (bool)
    {
        return sourceGateway != address(0) && trustedRemoteGateway[sourceDomain] == sourceGateway;
    }

    /// @inheritdoc IRemoteGatewayRegistry
    function requireTrustedRemoteGateway(uint256 sourceDomain, address sourceGateway) external view override {
        address trustedGateway = trustedRemoteGateway[sourceDomain];
        if (trustedGateway == address(0)) {
            revert UnknownSourceDomain(sourceDomain);
        }
        if (sourceGateway != trustedGateway) {
            revert UntrustedRemoteGateway(sourceDomain, sourceGateway, trustedGateway);
        }
    }

    function _requireRegistryAdmin() private view {
        if (msg.sender != registryAdmin) {
            revert UnauthorizedRegistryAdmin();
        }
    }
}
