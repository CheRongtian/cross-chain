// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SourceGateway} from "../src/SourceGateway.sol";

contract SourceGatewayTest is Test {
    SourceGateway internal gateway;

    address internal sender = address(0xA11CE);
    address internal receiver = address(0xBEEF);

    uint256 internal constant DESTINATION_DOMAIN = 2001;

    event CrossChainMessage(
        bytes32 indexed messageId,
        uint8 version,
        uint256 sourceDomain,
        address sourceGateway,
        address indexed sourceSender,
        uint256 indexed destinationDomain,
        address destinationReceiver,
        uint256 nonce,
        bytes payload
    );

    function setUp() public {
        gateway = new SourceGateway();
    }

    function testInitialNonceIsOne() public view {
        assertEq(gateway.nextNonce(), 1);
    }

    function testSendMessageIncrementsNonce() public {
        bytes memory payload = bytes("hello chain b");

        vm.prank(sender);
        gateway.sendMessage(DESTINATION_DOMAIN, receiver, payload);

        assertEq(gateway.nextNonce(), 2);

        vm.prank(sender);
        gateway.sendMessage(DESTINATION_DOMAIN, receiver, payload);

        assertEq(gateway.nextNonce(), 3);
    }

    function testSamePayloadProducesDifferentMessageIds() public {
        bytes memory payload = bytes("hello chain b");

        vm.prank(sender);
        (bytes32 firstId,) = gateway.sendMessage(DESTINATION_DOMAIN, receiver, payload);

        vm.prank(sender);
        (bytes32 secondId,) = gateway.sendMessage(DESTINATION_DOMAIN, receiver, payload);

        assertNotEq(firstId, secondId);
    }

    function testMessageIdCanBeRecomputed() public {
        bytes memory payload = bytes("hello chain b");

        bytes32 expectedId = gateway.computeMessageId(sender, DESTINATION_DOMAIN, receiver, 1, keccak256(payload));

        vm.prank(sender);
        (bytes32 actualId, uint256 nonce) = gateway.sendMessage(DESTINATION_DOMAIN, receiver, payload);

        assertEq(nonce, 1);
        assertEq(actualId, expectedId);
    }

    function testEmitsCrossChainMessage() public {
        bytes memory payload = bytes("hello chain b");

        bytes32 expectedId = gateway.computeMessageId(sender, DESTINATION_DOMAIN, receiver, 1, keccak256(payload));

        vm.expectEmit(true, true, true, true, address(gateway));

        emit CrossChainMessage(
            expectedId,
            gateway.MESSAGE_VERSION(),
            block.chainid,
            address(gateway),
            sender,
            DESTINATION_DOMAIN,
            receiver,
            1,
            payload
        );

        vm.prank(sender);

        gateway.sendMessage(DESTINATION_DOMAIN, receiver, payload);
    }

    function testRejectsSameChainDestination() public {
        bytes memory payload = bytes("hello");

        vm.prank(sender);
        vm.expectRevert(SourceGateway.InvalidDestinationDomain.selector);

        gateway.sendMessage(block.chainid, receiver, payload);
    }

    function testRejectsZeroReceiver() public {
        bytes memory payload = bytes("hello");

        vm.prank(sender);
        vm.expectRevert(SourceGateway.InvalidDestinationReceiver.selector);

        gateway.sendMessage(DESTINATION_DOMAIN, address(0), payload);
    }
}
