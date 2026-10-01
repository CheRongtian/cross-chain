// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Application-facing interface for canonical source message creation.
interface ISourceGateway {
    function sendMessage(
        uint256 destinationDomain,
        address destinationReceiver,
        bytes calldata payload,
        uint256 deadline
    ) external returns (bytes32 messageId, uint256 nonce);
}
