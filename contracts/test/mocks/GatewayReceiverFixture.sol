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
    mapping(bytes32 messageId => uint256 count) public callsByMessage;
    mapping(bytes32 messageId => bytes32 payloadHash) public payloadHashByMessage;
    bytes public nestedCall;
    bytes public nestedResult;
    bool public nestedSuccess;

    error ReceiverRejected();

    function configure(DestinationGateway gateway_, bool fail_, bytes calldata nestedCall_) external {
        gateway = gateway_;
        fail = fail_;
        nestedCall = nestedCall_;
    }

    // Payload observation belongs to the test receiver, without introducing a second execution authority.
    // forge-lint: disable-next-item(asm-keccak256)
    function handleCrossChainMessage(bytes32 messageId, bytes calldata payload) external override {
        observedConsumed = gateway.isMessageExecuted(messageId);
        calls++;
        callsByMessage[messageId]++;
        payloadHashByMessage[messageId] = keccak256(payload);
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
