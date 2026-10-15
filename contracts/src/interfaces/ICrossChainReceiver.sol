// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Business receiver invoked by the independently configured destination Gateway.
/// @dev The Gateway must authenticate the message and enforce replay protection before this call.
interface ICrossChainReceiver {
    function handleCrossChainMessage(bytes32 messageId, bytes calldata payload) external;
}
