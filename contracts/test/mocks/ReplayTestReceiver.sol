// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageReplayProtection} from "../../src/MessageReplayProtection.sol";
import {IReplayTestReceiver} from "./IReplayTestReceiver.sol";

/// @dev Test-only callback observations. No business role or destination execution result is represented.
contract ReplayTestReceiver is IReplayTestReceiver {
    bool private _failBefore;
    bool private _failAfter;
    bytes private _reentryData;
    bool public observedConsumed;
    bool public reentrySucceeded;
    bytes public reentryResult;
    uint256 public calls;

    error MockExecutionFailed(bytes32 messageId);
    error ReplayStateNotSet(bytes32 messageId);

    function configure(bool failBefore, bytes calldata reentryData, bool failAfter) external {
        _failBefore = failBefore;
        _failAfter = failAfter;
        _reentryData = reentryData;
        observedConsumed = false;
        reentrySucceeded = false;
        delete reentryResult;
        calls = 0;
    }

    function onMessage(bytes32 messageId) external override {
        if (_failBefore) revert MockExecutionFailed(messageId);
        observedConsumed = MessageReplayProtection(msg.sender).isMessageExecuted(messageId);
        if (!observedConsumed) revert ReplayStateNotSet(messageId);
        calls++;
        if (_reentryData.length != 0) {
            // Capture exact nested results for assertions; an outer mock failure still propagates.
            // Raw result bytes are required to assert the exact nested replay rejection.
            // forge-lint: disable-next-line(low-level-calls)
            (reentrySucceeded, reentryResult) = msg.sender.call(_reentryData);
        }
        if (_failAfter) revert MockExecutionFailed(messageId);
    }
}
