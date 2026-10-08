// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISourceGateway} from "../../src/interfaces/ISourceGateway.sol";

contract MockSourceApplication {
    function sendCrossChainMessage(
        ISourceGateway sourceGateway,
        uint256 destinationDomain,
        address destinationGateway,
        address destinationReceiver,
        bytes calldata payload,
        uint256 deadline
    ) external returns (bytes32 messageId, uint256 nonce) {
        return sourceGateway.sendMessage(
            destinationDomain,
            destinationGateway,
            destinationReceiver,
            payload,
            deadline
        );
    }
}
