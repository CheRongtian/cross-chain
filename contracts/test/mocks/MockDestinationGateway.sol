// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICrossChainReceiver} from "../../src/interfaces/ICrossChainReceiver.sol";

/// @dev TEST ONLY: forwards a receiver call, without QC/Merkle/domain verification or replay consumption.
///      Any caller may use this fixture. It must never serve as a production Gateway.
contract MockDestinationGateway {
    function forwardMessage(ICrossChainReceiver receiver, bytes32 messageId, bytes calldata payload) external {
        receiver.handleCrossChainMessage(messageId, payload);
    }
}
