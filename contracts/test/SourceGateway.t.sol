// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {CanonicalMessageVector} from "../generated/CanonicalMessageVector.sol";
import {CROSS_CHAIN_MESSAGE_TYPEHASH, MessageCodec} from "../src/MessageCodec.sol";
import {SourceGateway} from "../src/SourceGateway.sol";
import {MockSourceApplication} from "./mocks/MockSourceApplication.sol";

contract SourceGatewayTest is Test {
    uint256 internal constant SOURCE_DOMAIN = 10_011;
    uint256 internal constant DESTINATION_DOMAIN = 2001;
    uint256 internal constant ALTERNATE_DESTINATION_DOMAIN = 3001;
    uint256 internal constant CURRENT_TIME = 2_000_000_000;
    uint256 internal constant DEADLINE = CURRENT_TIME + 1 hours;
    uint256 internal constant EVENT_TOPIC_COUNT = 4;
    uint256 internal constant AUTHORIZATION_EVENT_TOPIC_COUNT = 2;
    address internal constant DESTINATION_GATEWAY = address(0xD00D);
    address internal constant ALTERNATE_DESTINATION_GATEWAY = address(0xD00E);
    address internal constant DESTINATION_RECEIVER = address(0xBEEF);
    address internal constant UNKNOWN_EOA = address(0xBAD);
    string internal constant PAYLOAD_TEXT = "hello chain b";

    SourceGateway internal gateway;
    MockSourceApplication internal sourceApplication;
    MockSourceApplication internal secondSourceApplication;
    MockSourceApplication internal unknownSourceApplication;

    function setUp() public {
        vm.chainId(SOURCE_DOMAIN);
        vm.warp(CURRENT_TIME);
        gateway = new SourceGateway(address(this));
        sourceApplication = new MockSourceApplication();
        secondSourceApplication = new MockSourceApplication();
        unknownSourceApplication = new MockSourceApplication();
        gateway.setSourceApplicationAuthorization(address(sourceApplication), true);
    }

    function testAuthorizationAdminConfiguredCorrectly() public view {
        assertEq(gateway.authorizationAdmin(), address(this));
    }

    function testRejectsZeroAuthorizationAdmin() public {
        vm.expectRevert(SourceGateway.InvalidAuthorizationAdmin.selector);
        new SourceGateway(address(0));
    }

    function testAdminCanAuthorizeAndRevokeSourceApplication() public {
        gateway.setSourceApplicationAuthorization(address(secondSourceApplication), true);
        assertTrue(gateway.authorizedSourceApplications(address(secondSourceApplication)));

        gateway.setSourceApplicationAuthorization(address(secondSourceApplication), false);
        assertFalse(gateway.authorizedSourceApplications(address(secondSourceApplication)));
    }

    function testAuthorizationUpdateEmitsEvent() public {
        vm.recordLogs();
        gateway.setSourceApplicationAuthorization(address(secondSourceApplication), true);
        gateway.setSourceApplicationAuthorization(address(secondSourceApplication), false);

        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 2);
        assertEq(logs[0].emitter, address(gateway));
        assertEq(logs[0].topics.length, AUTHORIZATION_EVENT_TOPIC_COUNT);
        assertEq(logs[0].topics[0], SourceGateway.SourceApplicationAuthorizationUpdated.selector);
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(address(secondSourceApplication)))));
        assertTrue(abi.decode(logs[0].data, (bool)));
        assertEq(logs[1].emitter, address(gateway));
        assertEq(logs[1].topics.length, AUTHORIZATION_EVENT_TOPIC_COUNT);
        assertEq(logs[1].topics[0], SourceGateway.SourceApplicationAuthorizationUpdated.selector);
        assertEq(logs[1].topics[1], bytes32(uint256(uint160(address(secondSourceApplication)))));
        assertFalse(abi.decode(logs[1].data, (bool)));
    }

    function testNonAdminCannotAuthorizeSourceApplication() public {
        vm.prank(UNKNOWN_EOA);
        vm.expectRevert(SourceGateway.UnauthorizedAuthorizationAdmin.selector);
        gateway.setSourceApplicationAuthorization(address(secondSourceApplication), true);

        assertFalse(gateway.authorizedSourceApplications(address(secondSourceApplication)));
    }

    function testNonAdminCannotRevokeSourceApplication() public {
        vm.prank(UNKNOWN_EOA);
        vm.expectRevert(SourceGateway.UnauthorizedAuthorizationAdmin.selector);
        gateway.setSourceApplicationAuthorization(address(sourceApplication), false);

        assertTrue(gateway.authorizedSourceApplications(address(sourceApplication)));
    }

    function testRejectsZeroSourceApplicationForAuthorizationUpdates() public {
        vm.expectRevert(SourceGateway.InvalidSourceApplication.selector);
        gateway.setSourceApplicationAuthorization(address(0), true);

        vm.expectRevert(SourceGateway.InvalidSourceApplication.selector);
        gateway.setSourceApplicationAuthorization(address(0), false);
    }

    function testRejectsAuthorizationForAddressWithoutCode() public {
        vm.expectRevert(SourceGateway.InvalidSourceApplication.selector);
        gateway.setSourceApplicationAuthorization(UNKNOWN_EOA, true);
    }

    function testRejectsAuthorizationStateNoOps() public {
        vm.expectRevert(SourceGateway.SourceApplicationAuthorizationUnchanged.selector);
        gateway.setSourceApplicationAuthorization(address(sourceApplication), true);

        vm.expectRevert(SourceGateway.SourceApplicationAuthorizationUnchanged.selector);
        gateway.setSourceApplicationAuthorization(address(unknownSourceApplication), false);
    }

    function testUnknownEOACannotSendAndDoesNotConsumeNonce() public {
        vm.recordLogs();
        vm.prank(UNKNOWN_EOA);
        vm.expectRevert(SourceGateway.UnauthorizedSourceApplication.selector);
        _callGatewayDirect();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(gateway.nextNonce(), 1);
        assertEq(logs.length, 0);
    }

    function testUnknownApplicationCannotSendAndDoesNotConsumeNonce() public {
        vm.recordLogs();
        vm.expectRevert(SourceGateway.UnauthorizedSourceApplication.selector);
        _callGatewayFrom(unknownSourceApplication, gateway, DEADLINE);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(gateway.nextNonce(), 1);
        assertEq(logs.length, 0);
    }

    function testRevokedApplicationCannotSendAndDoesNotConsumeNonce() public {
        _sendMessage(DEADLINE);
        gateway.setSourceApplicationAuthorization(address(sourceApplication), false);
        uint256 nonceBeforeRejectedSend = gateway.nextNonce();

        vm.expectRevert(SourceGateway.UnauthorizedSourceApplication.selector);
        _sendMessage(DEADLINE);

        assertEq(gateway.nextNonce(), nonceBeforeRejectedSend);
    }

    function testReauthorizedApplicationCanSendAgain() public {
        gateway.setSourceApplicationAuthorization(address(sourceApplication), false);
        gateway.setSourceApplicationAuthorization(address(sourceApplication), true);

        (, uint256 nonce) = _sendMessage(DEADLINE);

        assertEq(nonce, 1);
        assertEq(gateway.nextNonce(), 2);
    }

    function testMultipleAuthorizedApplicationsUseTheirOwnSourceSender() public {
        gateway.setSourceApplicationAuthorization(address(secondSourceApplication), true);

        (bytes32 firstMessageId, uint256 firstNonce) = _callGatewayFrom(sourceApplication, gateway, DEADLINE);
        (bytes32 secondMessageId, uint256 secondNonce) =
            _callGatewayFrom(secondSourceApplication, gateway, DEADLINE);

        assertEq(firstNonce, 1);
        assertEq(secondNonce, 2);
        assertEq(firstMessageId, _messageId(address(sourceApplication), 1, DEADLINE));
        assertEq(secondMessageId, _messageId(address(secondSourceApplication), 2, DEADLINE));
        assertNotEq(firstMessageId, secondMessageId);
    }

    function testRevocationDoesNotChangeHistoricalMessageIdentity() public {
        (bytes32 historicalMessageId,) = _sendMessage(DEADLINE);
        gateway.setSourceApplicationAuthorization(address(sourceApplication), false);

        assertEq(historicalMessageId, _messageId(address(sourceApplication), 1, DEADLINE));
        assertEq(gateway.nextNonce(), 2);
        assertFalse(gateway.authorizedSourceApplications(address(sourceApplication)));
    }

    function testInitialNonceIsOne() public view {
        assertEq(gateway.nextNonce(), 1);
    }

    function testPayloadHashMatchesCanonicalDefinition() public pure {
        assertEq(keccak256(_payload()), keccak256(bytes("hello chain b")));
    }

    function testMessageTypeHashMatchesCanonicalSchema() public view {
        assertEq(gateway.MESSAGE_TYPEHASH(), CROSS_CHAIN_MESSAGE_TYPEHASH);
        assertEq(
            CROSS_CHAIN_MESSAGE_TYPEHASH,
            keccak256(
                "CrossChainMessage(uint8 version,uint256 sourceDomain,address sourceGateway,address sourceSender,uint256 destinationDomain,address destinationGateway,address destinationReceiver,uint256 nonce,bytes32 payloadHash,uint256 deadline)"
            )
        );
    }

    function testGatewayUsesCanonicalMessageIdEncoding() public view {
        bytes32 expected = keccak256(
            abi.encode(
                gateway.MESSAGE_TYPEHASH(),
                gateway.MESSAGE_VERSION(),
                SOURCE_DOMAIN,
                address(gateway),
                address(sourceApplication),
                DESTINATION_DOMAIN,
                DESTINATION_GATEWAY,
                DESTINATION_RECEIVER,
                1,
                keccak256(_payload()),
                DEADLINE
            )
        );

        assertEq(_messageId(address(sourceApplication), 1, DEADLINE), expected);
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
        message.destinationGateway = ALTERNATE_DESTINATION_GATEWAY;
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
        assertEq(
            _messageId(address(sourceApplication), 1, DEADLINE),
            _messageId(address(sourceApplication), 1, DEADLINE)
        );
    }

    function testSharedGoldenVectorsMatchCanonicalEncoding() public pure {
        assertEq(CanonicalMessageVector.messageTypeHash(), CROSS_CHAIN_MESSAGE_TYPEHASH);

        for (uint256 index = 0; index < CanonicalMessageVector.length(); index++) {
            CanonicalMessageVector.Vector memory vector = CanonicalMessageVector.vectorAt(index);
            bytes32 actual = MessageCodec.computeMessageId(
                MessageCodec.CanonicalMessage({
                    version: vector.version,
                    sourceDomain: vector.sourceDomain,
                    sourceGateway: vector.sourceGateway,
                    sourceSender: vector.sourceSender,
                    destinationDomain: vector.destinationDomain,
                    destinationGateway: vector.destinationGateway,
                    destinationReceiver: vector.destinationReceiver,
                    nonce: vector.nonce,
                    payloadHash: vector.payloadHash,
                    deadline: vector.deadline
                })
            );

            assertEq(actual, vector.expectedMessageId);
        }
    }

    function testSourceDomainChangesMessageId() public view {
        MessageCodec.CanonicalMessage memory message = _canonicalMessage();
        bytes32 baseline = MessageCodec.computeMessageId(message);
        message.sourceDomain += 1;

        assertNotEq(MessageCodec.computeMessageId(message), baseline);
    }

    function testDestinationDomainChangesMessageId() public view {
        MessageCodec.CanonicalMessage memory message = _canonicalMessage();
        bytes32 baseline = MessageCodec.computeMessageId(message);
        message.destinationDomain = ALTERNATE_DESTINATION_DOMAIN;

        assertNotEq(MessageCodec.computeMessageId(message), baseline);
    }

    function testDestinationGatewayChangesMessageId() public view {
        MessageCodec.CanonicalMessage memory message = _canonicalMessage();
        bytes32 baseline = MessageCodec.computeMessageId(message);
        message.destinationGateway = ALTERNATE_DESTINATION_GATEWAY;

        assertNotEq(MessageCodec.computeMessageId(message), baseline);
    }

    function testSameNonceAcrossSourceGatewaysProducesDifferentMessageIds() public {
        SourceGateway secondGateway = new SourceGateway(address(this));
        secondGateway.setSourceApplicationAuthorization(address(sourceApplication), true);

        (bytes32 firstMessageId, uint256 firstNonce) = sourceApplication.sendCrossChainMessage(
            gateway,
            DESTINATION_DOMAIN,
            DESTINATION_GATEWAY,
            DESTINATION_RECEIVER,
            _payload(),
            DEADLINE
        );
        (bytes32 secondMessageId, uint256 secondNonce) = sourceApplication.sendCrossChainMessage(
            secondGateway,
            DESTINATION_DOMAIN,
            DESTINATION_GATEWAY,
            DESTINATION_RECEIVER,
            _payload(),
            DEADLINE
        );

        assertEq(firstNonce, 1);
        assertEq(secondNonce, 1);
        assertNotEq(firstMessageId, secondMessageId);
    }

    function testMessageIdCanBeRecomputed() public {
        bytes32 expected = _messageId(address(sourceApplication), 1, DEADLINE);

        (bytes32 messageId, uint256 nonce) = _sendMessage(DEADLINE);

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
        assertNotEq(
            _messageId(address(sourceApplication), 1, DEADLINE),
            _messageId(address(sourceApplication), 1, DEADLINE + 1)
        );
    }

    function testEmitsCrossChainMessage() public {
        bytes32 expectedMessageId = _messageId(address(sourceApplication), 1, DEADLINE);
        vm.recordLogs();

        (bytes32 returnedMessageId, uint256 returnedNonce) = _callGateway(
            DESTINATION_DOMAIN,
            DESTINATION_GATEWAY,
            DESTINATION_RECEIVER,
            DEADLINE
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(returnedMessageId, expectedMessageId);
        assertEq(returnedNonce, 1);
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(gateway));
        assertEq(logs[0].topics.length, EVENT_TOPIC_COUNT);
        assertEq(logs[0].topics[0], SourceGateway.CrossChainMessage.selector);
        assertEq(logs[0].topics[1], expectedMessageId);
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(address(sourceApplication)))));
        assertEq(logs[0].topics[3], bytes32(DESTINATION_DOMAIN));

        (
            uint8 version,
            uint256 sourceDomain,
            address sourceGateway,
            address destinationGateway,
            address destinationReceiver,
            uint256 nonce,
            bytes memory payload,
            uint256 deadline
        ) = abi.decode(logs[0].data, (uint8, uint256, address, address, address, uint256, bytes, uint256));

        assertEq(version, gateway.MESSAGE_VERSION());
        assertEq(sourceDomain, SOURCE_DOMAIN);
        assertEq(sourceGateway, address(gateway));
        assertEq(destinationGateway, DESTINATION_GATEWAY);
        assertEq(destinationReceiver, DESTINATION_RECEIVER);
        assertEq(nonce, 1);
        assertEq(payload, _payload());
        assertEq(deadline, DEADLINE);
    }

    function testRejectsZeroDestinationDomainWithoutConsumingNonce() public {
        vm.expectRevert(SourceGateway.InvalidDestinationDomain.selector);
        _callGateway(0, DESTINATION_GATEWAY, DESTINATION_RECEIVER, DEADLINE);

        assertEq(gateway.nextNonce(), 1);
    }

    function testRejectsSameChainDestinationWithoutConsumingNonce() public {
        vm.expectRevert(SourceGateway.InvalidDestinationDomain.selector);
        _callGateway(SOURCE_DOMAIN, DESTINATION_GATEWAY, DESTINATION_RECEIVER, DEADLINE);

        assertEq(gateway.nextNonce(), 1);
    }

    function testRejectsZeroDestinationGatewayWithoutConsumingNonce() public {
        vm.expectRevert(SourceGateway.InvalidDestinationGateway.selector);
        _callGateway(DESTINATION_DOMAIN, address(0), DESTINATION_RECEIVER, DEADLINE);

        assertEq(gateway.nextNonce(), 1);
    }

    function testRejectsZeroReceiverWithoutConsumingNonce() public {
        vm.expectRevert(SourceGateway.InvalidDestinationReceiver.selector);
        _callGateway(DESTINATION_DOMAIN, DESTINATION_GATEWAY, address(0), DEADLINE);

        assertEq(gateway.nextNonce(), 1);
    }

    function testRejectsCurrentDeadlineWithoutConsumingNonce() public {
        vm.expectRevert(SourceGateway.InvalidDeadline.selector);
        _callGateway(DESTINATION_DOMAIN, DESTINATION_GATEWAY, DESTINATION_RECEIVER, CURRENT_TIME);

        assertEq(gateway.nextNonce(), 1);
    }

    function testRejectsExpiredDeadlineWithoutConsumingNonce() public {
        vm.expectRevert(SourceGateway.InvalidDeadline.selector);
        _callGateway(DESTINATION_DOMAIN, DESTINATION_GATEWAY, DESTINATION_RECEIVER, CURRENT_TIME - 1);

        assertEq(gateway.nextNonce(), 1);
    }

    function _sendMessage(uint256 deadline) internal returns (bytes32 messageId, uint256 nonce) {
        return _callGateway(DESTINATION_DOMAIN, DESTINATION_GATEWAY, DESTINATION_RECEIVER, deadline);
    }

    function _callGateway(
        uint256 destinationDomain,
        address destinationGateway,
        address destinationReceiver,
        uint256 deadline
    ) internal returns (bytes32 messageId, uint256 nonce) {
        return sourceApplication.sendCrossChainMessage(
            gateway,
            destinationDomain,
            destinationGateway,
            destinationReceiver,
            _payload(),
            deadline
        );
    }

    function _callGatewayFrom(
        MockSourceApplication application,
        SourceGateway targetGateway,
        uint256 deadline
    ) internal returns (bytes32 messageId, uint256 nonce) {
        return application.sendCrossChainMessage(
            targetGateway,
            DESTINATION_DOMAIN,
            DESTINATION_GATEWAY,
            DESTINATION_RECEIVER,
            _payload(),
            deadline
        );
    }

    function _callGatewayDirect() internal returns (bytes32 messageId, uint256 nonce) {
        return gateway.sendMessage(
            DESTINATION_DOMAIN,
            DESTINATION_GATEWAY,
            DESTINATION_RECEIVER,
            _payload(),
            DEADLINE
        );
    }

    function _messageId(address sourceSender, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        return gateway.computeMessageId(
            sourceSender,
            DESTINATION_DOMAIN,
            DESTINATION_GATEWAY,
            DESTINATION_RECEIVER,
            nonce,
            keccak256(_payload()),
            deadline
        );
    }

    function _canonicalMessage() internal view returns (MessageCodec.CanonicalMessage memory) {
        return MessageCodec.CanonicalMessage({
            version: gateway.MESSAGE_VERSION(),
            sourceDomain: SOURCE_DOMAIN,
            sourceGateway: address(gateway),
            sourceSender: address(sourceApplication),
            destinationDomain: DESTINATION_DOMAIN,
            destinationGateway: DESTINATION_GATEWAY,
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
