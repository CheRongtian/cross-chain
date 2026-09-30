// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageCodec} from "../src/MessageCodec.sol";
import {SourceGateway} from "../src/SourceGateway.sol";

contract SourceGatewayTest is Test {
    struct GoldenVector {
        MessageCodec.Message message;
        bytes32 payloadHash;
        bytes32 messageId;
    }

    SourceGateway internal gateway;

    uint8 internal constant MESSAGE_VERSION = 1;
    uint256 internal constant SOURCE_DOMAIN = 10011;
    address internal constant SOURCE_GATEWAY_FIXTURE = address(0x1111);
    address internal constant SENDER = address(0xA11CE);
    address internal constant RECEIVER = address(0xBEEF);

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

        vm.prank(SENDER);
        (bytes32 firstMessageId, uint256 firstNonce) =
            gateway.sendMessage(DESTINATION_DOMAIN, RECEIVER, payload);

        assertEq(firstNonce, 1);
        assertEq(gateway.nextNonce(), 2);

        vm.prank(SENDER);
        (bytes32 secondMessageId, uint256 secondNonce) =
            gateway.sendMessage(DESTINATION_DOMAIN, RECEIVER, payload);

        assertEq(secondNonce, 2);
        assertNotEq(firstMessageId, secondMessageId);
        assertEq(gateway.nextNonce(), 3);
    }

    function testSamePayloadProducesDifferentMessageIds() public {
        bytes memory payload = bytes("hello chain b");

        vm.prank(SENDER);
        (bytes32 firstId, uint256 firstNonce) = gateway.sendMessage(DESTINATION_DOMAIN, RECEIVER, payload);

        vm.prank(SENDER);
        (bytes32 secondId, uint256 secondNonce) = gateway.sendMessage(DESTINATION_DOMAIN, RECEIVER, payload);

        assertEq(firstNonce, 1);
        assertEq(secondNonce, 2);
        assertNotEq(firstId, secondId);
    }

    function testMessageIdCanBeRecomputed() public {
        bytes memory payload = bytes("hello chain b");

        bytes32 expectedId = gateway.computeMessageId(SENDER, DESTINATION_DOMAIN, RECEIVER, 1, keccak256(payload));

        vm.prank(SENDER);
        (bytes32 actualId, uint256 nonce) = gateway.sendMessage(DESTINATION_DOMAIN, RECEIVER, payload);

        assertEq(nonce, 1);
        assertEq(actualId, expectedId);
    }

    function testGatewayUsesCanonicalMessageIdEncoding() public view {
        bytes memory payload = bytes("hello chain b");
        bytes32 expectedId = MessageCodec.computeMessageId(
            gateway.MESSAGE_VERSION(),
            block.chainid,
            address(gateway),
            SENDER,
            DESTINATION_DOMAIN,
            RECEIVER,
            1,
            MessageCodec.hashPayload(payload)
        );

        bytes32 actualId = gateway.computeMessageId(
            SENDER, DESTINATION_DOMAIN, RECEIVER, 1, MessageCodec.hashPayload(payload)
        );

        assertEq(actualId, expectedId);
    }

    function testPayloadHashMatchesCanonicalDefinition() public pure {
        assertEq(
            MessageCodec.hashPayload(bytes("hello chain b")),
            0x758a9838e83061770f5b75d8544bc7a27cc795a8741c6b50bdf738ee276d23a6
        );
    }

    function testEveryIdentityFieldChangesMessageId() public pure {
        MessageCodec.Message memory message = _baseMessage();
        bytes32 baseline = MessageCodec.computeMessageId(message);

        message.version = 2;
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message.version = 1;

        message.sourceDomain = 10012;
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message.sourceDomain = SOURCE_DOMAIN;

        message.sourceGateway = address(0x2222);
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message.sourceGateway = SOURCE_GATEWAY_FIXTURE;

        message.sourceSender = address(0xA11CF);
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message.sourceSender = SENDER;

        message.destinationDomain = 2002;
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message.destinationDomain = DESTINATION_DOMAIN;

        message.destinationReceiver = address(0xBEF0);
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message.destinationReceiver = RECEIVER;

        message.nonce = 2;
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message.nonce = 1;

        message.payload = bytes("hello chain c");
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
    }

    function testIdenticalCanonicalInputsProduceIdenticalMessageId() public pure {
        MessageCodec.Message memory first = _baseMessage();
        MessageCodec.Message memory second = _baseMessage();

        assertEq(MessageCodec.computeMessageId(first), MessageCodec.computeMessageId(second));
    }

    function testSharedGoldenVectorsMatchCanonicalEncoding() public view {
        GoldenVector memory first = _loadGoldenVector(0);
        GoldenVector memory second = _loadGoldenVector(1);

        assertEq(MessageCodec.hashPayload(first.message.payload), first.payloadHash);
        assertEq(MessageCodec.computeMessageId(first.message), first.messageId);

        assertEq(MessageCodec.hashPayload(second.message.payload), second.payloadHash);
        assertEq(MessageCodec.computeMessageId(second.message), second.messageId);

        assertNotEq(first.messageId, second.messageId);
    }

    function testEmitsCrossChainMessage() public {
        bytes memory payload = bytes("hello chain b");

        bytes32 expectedId = MessageCodec.computeMessageId(
            MESSAGE_VERSION,
            block.chainid,
            address(gateway),
            SENDER,
            DESTINATION_DOMAIN,
            RECEIVER,
            1,
            MessageCodec.hashPayload(payload)
        );

        vm.expectEmit(true, true, true, true, address(gateway));

        emit CrossChainMessage(
            expectedId,
            MESSAGE_VERSION,
            block.chainid,
            address(gateway),
            SENDER,
            DESTINATION_DOMAIN,
            RECEIVER,
            1,
            payload
        );

        vm.prank(SENDER);

        (bytes32 actualId, uint256 actualNonce) =
            gateway.sendMessage(DESTINATION_DOMAIN, RECEIVER, payload);

        assertEq(actualId, expectedId);
        assertEq(actualNonce, 1);
    }

    function testRejectsSameChainDestination() public {
        bytes memory payload = bytes("hello");

        vm.prank(SENDER);
        vm.expectRevert(SourceGateway.InvalidDestinationDomain.selector);

        // A reverting call cannot produce usable return values.
        // forge-lint: disable-next-line(unused-return)
        gateway.sendMessage(block.chainid, RECEIVER, payload);
    }

    function testRejectsZeroReceiver() public {
        bytes memory payload = bytes("hello");

        vm.prank(SENDER);
        vm.expectRevert(SourceGateway.InvalidDestinationReceiver.selector);

        // A reverting call cannot produce usable return values.
        // forge-lint: disable-next-line(unused-return)
        gateway.sendMessage(DESTINATION_DOMAIN, address(0), payload);
    }

    function _baseMessage() internal pure returns (MessageCodec.Message memory message) {
        message = MessageCodec.Message({
            version: MESSAGE_VERSION,
            sourceDomain: SOURCE_DOMAIN,
            sourceGateway: SOURCE_GATEWAY_FIXTURE,
            sourceSender: SENDER,
            destinationDomain: DESTINATION_DOMAIN,
            destinationReceiver: RECEIVER,
            nonce: 1,
            payload: bytes("hello chain b")
        });
    }

    function _loadGoldenVector(uint256 index) internal view returns (GoldenVector memory vector) {
        // The configured permission is read-only and limited to repository-owned vectors.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(
            string.concat(vm.projectRoot(), "/../test-vectors/canonical-messages.json")
        );
        string memory key = string.concat(".vectors[", vm.toString(index), "]");
        uint256 version = vm.parseJsonUint(json, string.concat(key, ".version"));

        require(version <= type(uint8).max, "golden vector version exceeds uint8");

        vector.message = MessageCodec.Message({
            // The range check above makes this conversion lossless.
            // forge-lint: disable-next-line(unsafe-typecast)
            version: uint8(version),
            sourceDomain: vm.parseJsonUint(json, string.concat(key, ".sourceDomain")),
            sourceGateway: vm.parseJsonAddress(json, string.concat(key, ".sourceGateway")),
            sourceSender: vm.parseJsonAddress(json, string.concat(key, ".sourceSender")),
            destinationDomain: vm.parseJsonUint(json, string.concat(key, ".destinationDomain")),
            destinationReceiver: vm.parseJsonAddress(json, string.concat(key, ".destinationReceiver")),
            nonce: vm.parseJsonUint(json, string.concat(key, ".nonce")),
            payload: vm.parseJsonBytes(json, string.concat(key, ".payload"))
        });
        vector.payloadHash = vm.parseJsonBytes32(json, string.concat(key, ".payloadHash"));
        vector.messageId = vm.parseJsonBytes32(json, string.concat(key, ".messageId"));
    }
}
