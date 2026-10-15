// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Permanent, message-ID-keyed acceptance state within the inheriting destination contract.
/// @dev The caller must authenticate the QC, membership and full message before consuming the ID.
///      Consume before any business callback and propagate its failure so EVM rollback restores this state.
///      This primitive supplies no public mutation, receiver call, reset, expiry or administrator bypass.
abstract contract MessageReplayProtection {
    mapping(bytes32 messageId => bool executed) private _executedMessages;

    error MessageAlreadyExecuted(bytes32 messageId);

    function isMessageExecuted(bytes32 messageId) public view returns (bool) {
        return _executedMessages[messageId];
    }

    function _consumeMessage(bytes32 messageId) internal {
        if (_executedMessages[messageId]) revert MessageAlreadyExecuted(messageId);
        _executedMessages[messageId] = true;
    }
}
