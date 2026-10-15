// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageReplayProtection} from "../../src/MessageReplayProtection.sol";

/// @dev Shows the inherited production-facing ABI without adding test mutation methods.
contract ReplayQueryHarness is MessageReplayProtection {}
