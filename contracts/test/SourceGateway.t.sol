// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {CanonicalMessageVector} from "../generated/CanonicalMessageVector.sol";
import {MessageCodec} from "../src/MessageCodec.sol";
import {SourceGateway} from "../src/SourceGateway.sol";

contract SourceGatewayTest is Test {
    uint256 internal constant SOURCE_DOMAIN = 10_011;
    uint256 internal constant DESTINATION_DOMAIN = 2001;
    uint256 internal constant CURRENT_TIME = 2_000_000_000;
    uint256 internal constant DEADLINE = CURRENT_TIME + 1 hours;
    uint256 internal constant EVENT_TOPIC_COUNT = 4;
    address internal constant SOURCE_SENDER = address(0xA11CE);
    address internal constant DESTINATION_RECEIVER = address(0xBEEF);
    string internal constant PAYLOAD_TEXT = "hello chain b";

    SourceGateway internal gateway;

    function setUp() public {
        vm.chainId(SOURCE_DOMAIN);
        vm.warp(CURRENT_TIME);
        gateway = new SourceGateway();
    }

    function testInitialNonceIsOne() public view {
        assertEq(gateway.nextNonce(), 1);
    }

    function testPayloadHashMatchesCanonicalDefinition() public pure {
        assertEq(keccak256(_payload()), keccak256(bytes("hello chain b")));
    }

    function testGatewayUsesCanonicalMessageIdEncoding() public view {
        bytes32 expected = keccak256(
            abi.encode(
                gateway.MESSAGE_VERSION(),
                SOURCE_DOMAIN,
                address(gateway),
                SOURCE_SENDER,
                DESTINATION_DOMAIN,
                DESTINATION_RECEIVER,
                1,
                keccak256(_payload()),
                DEADLINE
            )
        );

        assertEq(_messageId(SOURCE_SENDER, 1, DEADLINE), expected);
    }

    function testEveryIdentityFieldChangesMessageId() public view {
        MessageCodec.CanonicalMessage memory message = _canonicalMessage();
        bytes32 baseline = MessageCodec.computeMessageId(message);

        message.version += 1;
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message = _canonicalMessage();
        message.sourceDomain += 1;
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message = _canonicalMessage();
        message.sourceGateway = address(0x1111);
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message = _canonicalMessage();
        message.sourceSender = address(0x2222);
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message = _canonicalMessage();
        message.destinationDomain += 1;
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message = _canonicalMessage();
        message.destinationReceiver = address(0x3333);
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message = _canonicalMessage();
        message.nonce += 1;
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message = _canonicalMessage();
        message.payloadHash = keccak256("different payload");
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
        message = _canonicalMessage();
        message.deadline += 1;
        assertNotEq(MessageCodec.computeMessageId(message), baseline);
    }

    function testIdenticalCanonicalInputsProduceIdenticalMessageId() public view {
        assertEq(_messageId(SOURCE_SENDER, 1, DEADLINE), _messageId(SOURCE_SENDER, 1, DEADLINE));
    }

    function testSharedGoldenVectorsMatchCanonicalEncoding() public pure {
        bytes32 actual = MessageCodec.computeMessageId(
            MessageCodec.CanonicalMessage({
                version: CanonicalMessageVector.version(),
                sourceDomain: CanonicalMessageVector.sourceDomain(),
                sourceGateway: CanonicalMessageVector.sourceGateway(),
                sourceSender: CanonicalMessageVector.sourceSender(),
                destinationDomain: CanonicalMessageVector.destinationDomain(),
                destinationReceiver: CanonicalMessageVector.destinationReceiver(),
                nonce: CanonicalMessageVector.nonce(),
                payloadHash: CanonicalMessageVector.payloadHash(),
                deadline: CanonicalMessageVector.deadline()
            })
        );

        assertEq(actual, CanonicalMessageVector.expectedMessageId());
    }

    function testMessageIdCanBeRecomputed() public {
        bytes32 expected = _messageId(SOURCE_SENDER, 1, DEADLINE);

        vm.prank(SOURCE_SENDER);
        (bytes32 messageId, uint256 nonce) =
            gateway.sendMessage(DESTINATION_DOMAIN, DESTINATION_RECEIVER, _payload(), DEADLINE);

        assertEq(messageId, expected);
        assertEq(nonce, 1);
    }

    function testSendMessageIncrementsNonce() public {
        _sendMessage(DEADLINE);
        assertEq(gateway.nextNonce(), 2);
    }

    function testSamePayloadProducesDifferentMessageIds() public {
        (bytes32 firstMessageId,) = _sendMessage(DEADLINE);
        (bytes32 secondMessageId,) = _sendMessage(DEADLINE);

        assertNotEq(firstMessageId, secondMessageId);
        assertEq(gateway.nextNonce(), 3);
    }

    function testDeadlineChangesMessageId() public view {
        assertNotEq(_messageId(SOURCE_SENDER, 1, DEADLINE), _messageId(SOURCE_SENDER, 1, DEADLINE + 1));
    }

    function testEmitsCrossChainMessage() public {
        bytes32 expectedMessageId = _messageId(SOURCE_SENDER, 1, DEADLINE);
        vm.recordLogs();

        vm.prank(SOURCE_SENDER);
        gateway.sendMessage(DESTINATION_DOMAIN, DESTINATION_RECEIVER, _payload(), DEADLINE);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(gateway));
        assertEq(logs[0].topics.length, EVENT_TOPIC_COUNT);
        assertEq(logs[0].topics[0], SourceGateway.CrossChainMessage.selector);
        assertEq(logs[0].topics[1], expectedMessageId);
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(SOURCE_SENDER))));
        assertEq(logs[0].topics[3], bytes32(DESTINATION_DOMAIN));

        (
            uint8 version,
            uint256 sourceDomain,
            address sourceGateway,
            address destinationReceiver,
            uint256 nonce,
            bytes memory payload,
            uint256 deadline
        ) = abi.decode(logs[0].data, (uint8, uint256, address, address, uint256, bytes, uint256));

        assertEq(version, gateway.MESSAGE_VERSION());
        assertEq(sourceDomain, SOURCE_DOMAIN);
        assertEq(sourceGateway, address(gateway));
        assertEq(destinationReceiver, DESTINATION_RECEIVER);
        assertEq(nonce, 1);
        assertEq(payload, _payload());
        assertEq(deadline, DEADLINE);
    }

    function testRejectsZeroDestinationDomainWithoutConsumingNonce() public {
        vm.expectRevert(SourceGateway.InvalidDestinationDomain.selector);
        gateway.sendMessage(0, DESTINATION_RECEIVER, _payload(), DEADLINE);

        assertEq(gateway.nextNonce(), 1);
    }

    function testRejectsSameChainDestinationWithoutConsumingNonce() public {
        vm.expectRevert(SourceGateway.InvalidDestinationDomain.selector);
        gateway.sendMessage(SOURCE_DOMAIN, DESTINATION_RECEIVER, _payload(), DEADLINE);

        assertEq(gateway.nextNonce(), 1);
    }

    function testRejectsZeroReceiverWithoutConsumingNonce() public {
        vm.expectRevert(SourceGateway.InvalidDestinationReceiver.selector);
        gateway.sendMessage(DESTINATION_DOMAIN, address(0), _payload(), DEADLINE);

        assertEq(gateway.nextNonce(), 1);
    }

    function testRejectsCurrentDeadlineWithoutConsumingNonce() public {
        vm.expectRevert(SourceGateway.InvalidDeadline.selector);
        gateway.sendMessage(DESTINATION_DOMAIN, DESTINATION_RECEIVER, _payload(), CURRENT_TIME);

        assertEq(gateway.nextNonce(), 1);
    }

    function testRejectsExpiredDeadlineWithoutConsumingNonce() public {
        vm.expectRevert(SourceGateway.InvalidDeadline.selector);
        gateway.sendMessage(DESTINATION_DOMAIN, DESTINATION_RECEIVER, _payload(), CURRENT_TIME - 1);

        assertEq(gateway.nextNonce(), 1);
    }

    function _sendMessage(uint256 deadline) internal returns (bytes32 messageId, uint256 nonce) {
        vm.prank(SOURCE_SENDER);
        return gateway.sendMessage(DESTINATION_DOMAIN, DESTINATION_RECEIVER, _payload(), deadline);
    }

    function _messageId(address sourceSender, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        return gateway.computeMessageId(
            sourceSender, DESTINATION_DOMAIN, DESTINATION_RECEIVER, nonce, keccak256(_payload()), deadline
        );
    }

    function _canonicalMessage() internal view returns (MessageCodec.CanonicalMessage memory) {
        return MessageCodec.CanonicalMessage({
            version: gateway.MESSAGE_VERSION(),
            sourceDomain: SOURCE_DOMAIN,
            sourceGateway: address(gateway),
            sourceSender: SOURCE_SENDER,
            destinationDomain: DESTINATION_DOMAIN,
            destinationReceiver: DESTINATION_RECEIVER,
            nonce: 1,
            payloadHash: keccak256(_payload()),
            deadline: DEADLINE
        });
    }

    function _payload() internal pure returns (bytes memory) {
        return bytes(PAYLOAD_TEXT);
    }
}
