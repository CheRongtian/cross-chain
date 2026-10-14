// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

bytes32 constant FORWARD_AUTHORIZATION_TYPEHASH = keccak256(
    "ForwardAuthorizationIntent(uint8 protocolVersion,uint256 action,uint256 sourceDomain,address application,address sourceGateway,uint256 destinationDomain,address destinationGateway,address destinationReceiver,bytes32 payloadHash,uint256 deadline,address authorizedExecutor)"
);

/// @notice An exact forwarding authorization, independent of the Gateway nonce.
library ForwardAuthorizationCodec {
    struct Intent {
        uint8 protocolVersion;
        uint256 action;
        uint256 sourceDomain;
        address application;
        address sourceGateway;
        uint256 destinationDomain;
        address destinationGateway;
        address destinationReceiver;
        bytes32 payloadHash;
        uint256 deadline;
        address authorizedExecutor;
    }

    function encode(Intent memory intent) internal pure returns (bytes memory) {
        // All fields are static: this is the flat ABI encoding of the type hash
        // followed by the eleven fields in the declared order.
        return abi.encode(FORWARD_AUTHORIZATION_TYPEHASH, intent);
    }

    function digest(Intent memory intent) internal pure returns (bytes32 result) {
        bytes memory encoded = encode(intent);
        // Hash the exact ABI bytes without another schema or field reduction.
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") {
            result := keccak256(add(encoded, 0x20), mload(encoded))
        }
    }

    function split(bytes32 value) internal pure returns (uint256 hi, uint256 lo) {
        hi = uint256(value) >> 128;
        lo = uint256(value) & type(uint128).max;
    }
}
