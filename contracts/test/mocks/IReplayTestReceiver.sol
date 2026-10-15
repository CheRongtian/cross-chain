// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Callback surface used only by replay atomicity fixtures.
interface IReplayTestReceiver {
    function onMessage(bytes32 messageId) external;
}
