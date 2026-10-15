// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICrossChainReceiver} from "../../src/interfaces/ICrossChainReceiver.sol";
import {DestinationGateway} from "../../src/DestinationGateway.sol";

/// @dev Test-only callback observation/failure. Production execution always authenticates the package first.
contract GatewayReceiverFixture is ICrossChainReceiver {
    DestinationGateway public gateway;
    bool public fail;
    bool public observedConsumed;
    uint256 public calls;
    bytes public nestedCall;
    bytes public nestedResult;
    bool public nestedSuccess;

    error ReceiverRejected();

    function configure(DestinationGateway gateway_, bool fail_, bytes calldata nestedCall_) external {
        gateway = gateway_;
        fail = fail_;
        nestedCall = nestedCall_;
    }

    function handleCrossChainMessage(bytes32 messageId, bytes calldata) external override {
        observedConsumed = gateway.isMessageExecuted(messageId);
        calls++;
        if (nestedCall.length != 0) {
            bytes memory data = nestedCall;
            delete nestedCall;
            // This test deliberately captures the exact nested error without reverting the outer call.
            // forge-lint: disable-next-line(low-level-calls)
            (nestedSuccess, nestedResult) = address(gateway).call(data);
        }
        if (fail) revert ReceiverRejected();
    }
}
