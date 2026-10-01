// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISourceGateway} from "../../src/interfaces/ISourceGateway.sol";

contract MockSourceGateway is ISourceGateway {
    address public caller;
    uint256 public destinationDomain;
    address public destinationReceiver;
    bytes public payload;
    uint256 public deadline;

    bytes32 public returnMessageId = keccak256("mock-source-message");
    uint256 public returnNonce = 41;

    function setReturnValues(bytes32 messageId, uint256 nonce) external {
        returnMessageId = messageId;
        returnNonce = nonce;
    }

    function sendMessage(
        uint256 destinationDomain_,
        address destinationReceiver_,
        bytes calldata payload_,
        uint256 deadline_
    ) external returns (bytes32 messageId, uint256 nonce) {
        caller = msg.sender;
        destinationDomain = destinationDomain_;
        destinationReceiver = destinationReceiver_;
        payload = payload_;
        deadline = deadline_;
        return (returnMessageId, returnNonce);
    }
}
