// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageReplayProtection} from "../../src/MessageReplayProtection.sol";
import {IReplayTestReceiver} from "./IReplayTestReceiver.sol";

/// @dev Unit-test-only exposure of the internal primitive. Never a production acceptance endpoint.
contract MessageReplayProtectionHarness is MessageReplayProtection {
    error IntentionalRollback(bytes32 messageId);

    function consume(bytes32 messageId) external {
        _consumeMessage(messageId);
    }

    function consumeThenRevert(bytes32 messageId) external {
        _consumeMessage(messageId);
        revert IntentionalRollback(messageId);
    }

    function consumeThenCall(bytes32 messageId, address receiver) external {
        _consumeMessage(messageId);
        IReplayTestReceiver(receiver).onMessage(messageId);
    }
}

