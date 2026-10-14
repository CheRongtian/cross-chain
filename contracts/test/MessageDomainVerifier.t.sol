// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CanonicalMessageVector} from "../generated/CanonicalMessageVector.sol";
import {MessageCodec, CROSS_CHAIN_MESSAGE_VERSION} from "../src/MessageCodec.sol";
import {MessageDomainVerifier} from "../src/MessageDomainVerifier.sol";
import {RemoteGatewayRegistry} from "../src/RemoteGatewayRegistry.sol";
import {SourceGateway} from "../src/SourceGateway.sol";

contract MessageDomainVerifierTest is Test {
    uint256 private constant SOURCE_DOMAIN = 10_011;
    uint256 private constant DESTINATION_DOMAIN = 2001;
    uint256 private constant OTHER_DESTINATION_DOMAIN = 3001;
    uint256 private constant CURRENT_TIME = 2_000_000_000;
    uint256 private constant DEADLINE = CURRENT_TIME + 1 hours;
    uint256 private constant UNSUPPORTED_VERSION_COUNT = 4;
    uint8 private constant ZERO_VERSION = 0;
    uint8 private constant LEGACY_VERSION = 1;
    uint8 private constant FUTURE_VERSION = 3;
    address private constant DESTINATION_GATEWAY = address(0xD00D);
    address private constant OTHER_GATEWAY = address(0xD00E);
    address private constant RECEIVER = address(0xBEEF);
    address private constant OTHER_RECEIVER = address(0xCAFE);
    address private constant REMOTE_NO_CODE_GATEWAY = address(0xA11CE);
    string private constant PAYLOAD_TEXT = "hello chain b";

    RemoteGatewayRegistry private registry;
    SourceGateway private source;
    MessageDomainVerifier private verifier;

    function setUp() public {
        vm.chainId(SOURCE_DOMAIN);
        vm.warp(CURRENT_TIME);
        source = new SourceGateway(address(this));
        source.setSourceApplicationAuthorization(address(this), true);
        registry = new RemoteGatewayRegistry(address(this));
        registry.setRemoteGateway(SOURCE_DOMAIN, address(source));
        verifier = new MessageDomainVerifier(address(registry), DESTINATION_DOMAIN);
    }

    function testConstructorChecksDependencyAndExplicitLocalDomain() public {
        assertEq(address(verifier.remoteGatewayRegistry()), address(registry));
        assertEq(verifier.destinationDomain(), DESTINATION_DOMAIN);
        assertEq(verifier.MESSAGE_VERSION(), source.MESSAGE_VERSION());
        assertEq(verifier.MESSAGE_VERSION(), CROSS_CHAIN_MESSAGE_VERSION);
        vm.expectRevert(MessageDomainVerifier.InvalidRemoteGatewayRegistry.selector);
        new MessageDomainVerifier(address(0), DESTINATION_DOMAIN);
        vm.expectRevert(MessageDomainVerifier.InvalidRemoteGatewayRegistry.selector);
        new MessageDomainVerifier(REMOTE_NO_CODE_GATEWAY, DESTINATION_DOMAIN);
        // SourceGateway has bytecode but cannot serve the remote-registry interface.
        vm.expectRevert(MessageDomainVerifier.InvalidRemoteGatewayRegistry.selector);
        new MessageDomainVerifier(address(source), DESTINATION_DOMAIN);
        vm.expectRevert(abi.encodeWithSelector(MessageDomainVerifier.InvalidLocalDestinationDomain.selector, uint256(0)));
        new MessageDomainVerifier(address(registry), 0);
        // A registered zero source-domain key is allowed by the existing registry interface.
        registry.setRemoteGateway(0, REMOTE_NO_CODE_GATEWAY);
        MessageDomainVerifier withZeroKey = new MessageDomainVerifier(address(registry), DESTINATION_DOMAIN);
        assertEq(address(withZeroKey.remoteGatewayRegistry()), address(registry));
    }

    function testActualSourceGatewayAndDestinationIdParity() public {
        MessageCodec.CanonicalMessage memory m = _message();
        (bytes32 emittedId, uint256 nonce) = source.sendMessage(
            m.destinationDomain, m.destinationGateway, m.destinationReceiver, bytes(PAYLOAD_TEXT), m.deadline
        );
        m.nonce = nonce;
        assertEq(emittedId, MessageCodec.computeMessageId(m));
        assertEq(emittedId, verifier.computeMessageId(m, bytes(PAYLOAD_TEXT)));
        assertTrue(_verify(m, bytes(PAYLOAD_TEXT), emittedId));
    }

    // Each bounded frozen case calls the local registry/verifier using its explicit expected context.
    // forge-lint: disable-next-item(calls-loop)
    function testExistingCanonicalGoldenVectorsRemainUnchanged() public {
        assertEq(source.MESSAGE_TYPEHASH(), CanonicalMessageVector.messageTypeHash());
        for (uint256 index = 0; index < CanonicalMessageVector.length(); index++) {
            CanonicalMessageVector.Vector memory v = CanonicalMessageVector.vectorAt(index);
            MessageCodec.CanonicalMessage memory m = MessageCodec.CanonicalMessage({
                version: v.version,
                sourceDomain: v.sourceDomain,
                sourceGateway: v.sourceGateway,
                sourceSender: v.sourceSender,
                destinationDomain: v.destinationDomain,
                destinationGateway: v.destinationGateway,
                destinationReceiver: v.destinationReceiver,
                nonce: v.nonce,
                payloadHash: v.payloadHash,
                deadline: v.deadline
            });
            if (registry.trustedRemoteGateway(m.sourceDomain) != m.sourceGateway) {
                registry.setRemoteGateway(m.sourceDomain, m.sourceGateway);
            }
            MessageDomainVerifier selected = new MessageDomainVerifier(address(registry), m.destinationDomain);
            assertEq(selected.computeMessageId(m, bytes(PAYLOAD_TEXT)), v.expectedMessageId);
            assertTrue(selected.verifyMessage(m, bytes(PAYLOAD_TEXT), v.expectedMessageId, m.destinationGateway));
        }
    }

    // All versions are exact uint8 values; stale and self-consistent IDs hit the same version policy.
    // forge-lint: disable-next-item(calls-loop)
    function testUnsupportedVersionsRejectEvenWithSelfConsistentIds() public {
        uint8[UNSUPPORTED_VERSION_COUNT] memory versions =
            [ZERO_VERSION, LEGACY_VERSION, FUTURE_VERSION, type(uint8).max];
        bytes32 originalId = MessageCodec.computeMessageId(_message());
        for (uint256 index = 0; index < versions.length; index++) {
            MessageCodec.CanonicalMessage memory m = _message();
            m.version = versions[index];
            bytes memory expectedError = abi.encodeWithSelector(MessageDomainVerifier.UnsupportedMessageVersion.selector, m.version);
            _reject(m, bytes(PAYLOAD_TEXT), originalId, expectedError);
            _reject(m, bytes(PAYLOAD_TEXT), MessageCodec.computeMessageId(m), expectedError);
        }
    }

    function testWrongIdSenderNonceDeadlineAndPayloadBinding() public {
        MessageCodec.CanonicalMessage memory m = _message();
        bytes32 original = MessageCodec.computeMessageId(m);
        _reject(m, bytes(PAYLOAD_TEXT), _flip(original), abi.encodeWithSelector(MessageDomainVerifier.MessageIdMismatch.selector, _flip(original), original));
        m.sourceSender = OTHER_RECEIVER;
        _rejectIdentity(m, bytes(PAYLOAD_TEXT), original);
        m = _message();
        m.nonce++;
        _rejectIdentity(m, bytes(PAYLOAD_TEXT), original);
        m = _message();
        m.deadline++;
        _rejectIdentity(m, bytes(PAYLOAD_TEXT), original);
        m = _message();
        bytes memory changedPayload = bytes("hello chain c");
        _reject(m, changedPayload, original, abi.encodeWithSelector(
            MessageDomainVerifier.PayloadHashMismatch.selector, m.payloadHash, keccak256(changedPayload)
        ));
        m.payloadHash = keccak256(changedPayload);
        _rejectIdentity(m, changedPayload, original);
        m = _message();
        bytes32 originalPayloadHash = m.payloadHash;
        m.payloadHash = _flip(m.payloadHash);
        _reject(m, bytes(PAYLOAD_TEXT), original, abi.encodeWithSelector(
            MessageDomainVerifier.PayloadHashMismatch.selector, m.payloadHash, originalPayloadHash
        ));
    }

    function testExactSourceTrustAndRegistryReplacementRemoval() public {
        MessageCodec.CanonicalMessage memory m = _message();
        bytes32 originalId = MessageCodec.computeMessageId(m);
        m.sourceDomain++;
        _reject(m, bytes(PAYLOAD_TEXT), MessageCodec.computeMessageId(m), abi.encodeWithSelector(RemoteGatewayRegistry.UnknownSourceDomain.selector, m.sourceDomain));
        m.sourceDomain = type(uint256).max;
        _reject(m, bytes(PAYLOAD_TEXT), MessageCodec.computeMessageId(m), abi.encodeWithSelector(RemoteGatewayRegistry.UnknownSourceDomain.selector, m.sourceDomain));
        m = _message();
        m.sourceGateway = REMOTE_NO_CODE_GATEWAY;
        _reject(m, bytes(PAYLOAD_TEXT), MessageCodec.computeMessageId(m), abi.encodeWithSelector(
            RemoteGatewayRegistry.UntrustedRemoteGateway.selector, SOURCE_DOMAIN, m.sourceGateway, address(source)
        ));
        m = _message();
        registry.setRemoteGateway(SOURCE_DOMAIN, REMOTE_NO_CODE_GATEWAY);
        _reject(m, bytes(PAYLOAD_TEXT), originalId, abi.encodeWithSelector(
            RemoteGatewayRegistry.UntrustedRemoteGateway.selector, SOURCE_DOMAIN, address(source), REMOTE_NO_CODE_GATEWAY
        ));
        m.sourceGateway = REMOTE_NO_CODE_GATEWAY;
        assertEq(m.sourceGateway.code.length, 0);
        assertTrue(_verify(m, bytes(PAYLOAD_TEXT), MessageCodec.computeMessageId(m)));
        registry.removeRemoteGateway(SOURCE_DOMAIN);
        _reject(m, bytes(PAYLOAD_TEXT), MessageCodec.computeMessageId(m), abi.encodeWithSelector(RemoteGatewayRegistry.UnknownSourceDomain.selector, SOURCE_DOMAIN));
    }

    function testSameGatewayAcrossSourceDomainsRetainsDistinctIdentities() public {
        MessageCodec.CanonicalMessage memory m = _message();
        bytes32 original = MessageCodec.computeMessageId(m);
        m.sourceDomain++;
        registry.setRemoteGateway(m.sourceDomain, m.sourceGateway);
        bytes32 changed = MessageCodec.computeMessageId(m);
        assertNotEq(changed, original);
        assertTrue(_verify(m, bytes(PAYLOAD_TEXT), changed));
        _rejectIdentity(m, bytes(PAYLOAD_TEXT), original);
    }

    function testExplicitDestinationDomainAndCrossDomainReplay() public {
        MessageCodec.CanonicalMessage memory m = _message();
        bytes32 original = MessageCodec.computeMessageId(m);
        m.destinationDomain = OTHER_DESTINATION_DOMAIN;
        bytes32 changed = MessageCodec.computeMessageId(m);
        assertNotEq(changed, original);
        _reject(m, bytes(PAYLOAD_TEXT), changed, abi.encodeWithSelector(
            MessageDomainVerifier.InvalidDestinationDomain.selector, DESTINATION_DOMAIN, OTHER_DESTINATION_DOMAIN
        ));
        MessageDomainVerifier other = new MessageDomainVerifier(address(registry), OTHER_DESTINATION_DOMAIN);
        assertTrue(other.verifyMessage(m, bytes(PAYLOAD_TEXT), changed, DESTINATION_GATEWAY));
        m = _message();
        vm.expectRevert(abi.encodeWithSelector(
            MessageDomainVerifier.InvalidDestinationDomain.selector, OTHER_DESTINATION_DOMAIN, DESTINATION_DOMAIN
        ));
        // The VM asserts this exact revert, with no return value to consume.
        // forge-lint: disable-next-line(unused-return)
        other.verifyMessage(m, bytes(PAYLOAD_TEXT), original, DESTINATION_GATEWAY);
        m.sourceDomain = DESTINATION_DOMAIN;
        registry.setRemoteGateway(m.sourceDomain, m.sourceGateway);
        _reject(m, bytes(PAYLOAD_TEXT), MessageCodec.computeMessageId(m), abi.encodeWithSelector(
            MessageDomainVerifier.InvalidSourceDestinationPair.selector, DESTINATION_DOMAIN, DESTINATION_DOMAIN
        ));
        m = _message();
        (m.sourceDomain, m.destinationDomain) = (m.destinationDomain, m.sourceDomain);
        _reject(m, bytes(PAYLOAD_TEXT), MessageCodec.computeMessageId(m), abi.encodeWithSelector(
            MessageDomainVerifier.InvalidDestinationDomain.selector, DESTINATION_DOMAIN, SOURCE_DOMAIN
        ));
    }

    function testGatewayContextReceiverAndNonzeroTargetRules() public {
        MessageCodec.CanonicalMessage memory m = _message();
        bytes32 original = MessageCodec.computeMessageId(m);
        assertNotEq(m.destinationGateway, address(verifier));
        assertEq(m.destinationGateway.code.length, 0);
        assertEq(m.destinationReceiver.code.length, 0);
        m.destinationGateway = OTHER_GATEWAY;
        _reject(m, bytes(PAYLOAD_TEXT), MessageCodec.computeMessageId(m), abi.encodeWithSelector(
            MessageDomainVerifier.DestinationGatewayMismatch.selector, DESTINATION_GATEWAY, OTHER_GATEWAY
        ));
        m.destinationGateway = address(0);
        _reject(m, bytes(PAYLOAD_TEXT), MessageCodec.computeMessageId(m), abi.encodeWithSelector(MessageDomainVerifier.InvalidDestinationGateway.selector));
        m = _message();
        vm.expectRevert(MessageDomainVerifier.InvalidDestinationGateway.selector);
        // forge-lint: disable-next-line(unused-return)
        verifier.verifyMessage(m, bytes(PAYLOAD_TEXT), original, address(0));
        m.destinationReceiver = OTHER_RECEIVER;
        _rejectIdentity(m, bytes(PAYLOAD_TEXT), original);
        assertTrue(_verify(m, bytes(PAYLOAD_TEXT), MessageCodec.computeMessageId(m)));
        m.destinationReceiver = address(0);
        _reject(m, bytes(PAYLOAD_TEXT), MessageCodec.computeMessageId(m), abi.encodeWithSelector(MessageDomainVerifier.InvalidDestinationReceiver.selector));
    }

    function testStrictDestinationDeadlineBoundary() public {
        MessageCodec.CanonicalMessage memory m = _message();
        bytes32 id = MessageCodec.computeMessageId(m);
        vm.warp(DEADLINE - 1);
        assertTrue(_verify(m, bytes(PAYLOAD_TEXT), id));
        vm.warp(DEADLINE);
        _reject(m, bytes(PAYLOAD_TEXT), id, abi.encodeWithSelector(MessageDomainVerifier.MessageExpired.selector, DEADLINE, DEADLINE));
        vm.warp(DEADLINE + 1);
        _reject(m, bytes(PAYLOAD_TEXT), id, abi.encodeWithSelector(MessageDomainVerifier.MessageExpired.selector, DEADLINE, DEADLINE + 1));
    }

    function testEmptyPayloadAndRepeatedVerificationAreStateless() public {
        MessageCodec.CanonicalMessage memory m = _message();
        m.payloadHash = keccak256(bytes(""));
        (bytes32 sourceId, uint256 nonce) = source.sendMessage(
            m.destinationDomain, m.destinationGateway, m.destinationReceiver, bytes(""), m.deadline
        );
        m.nonce = nonce;
        assertEq(sourceId, MessageCodec.computeMessageId(m));
        vm.recordLogs();
        assertTrue(_verify(m, bytes(""), sourceId));
        assertTrue(_verify(m, bytes(""), sourceId));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function testFullWidthDomainsNonceAndDeadlineRemainExact() public {
        MessageCodec.CanonicalMessage memory m = _message();
        m.destinationDomain = type(uint256).max;
        m.nonce = type(uint256).max;
        m.deadline = type(uint256).max;
        MessageDomainVerifier fullWidth = new MessageDomainVerifier(address(registry), m.destinationDomain);

        // Keep the actual SourceGateway on the normal test chain; vm.chainId accepts only values below 2^64.
        bytes32 sourceId = source.computeMessageId(m.sourceSender, m.destinationDomain, m.destinationGateway,
            m.destinationReceiver, m.nonce, m.payloadHash, m.deadline);
        assertEq(sourceId, MessageCodec.computeMessageId(m));
        assertEq(fullWidth.computeMessageId(m, bytes(PAYLOAD_TEXT)), sourceId);
        assertTrue(fullWidth.verifyMessage(m, bytes(PAYLOAD_TEXT), sourceId, DESTINATION_GATEWAY));

        // Protocol source domains retain their full uint256 width independently of that cheatcode limit.
        m.sourceDomain = (uint256(1) << 200) + SOURCE_DOMAIN;
        registry.setRemoteGateway(m.sourceDomain, m.sourceGateway);
        bytes32 expected = MessageCodec.computeMessageId(m);
        assertNotEq(expected, sourceId);
        assertEq(fullWidth.computeMessageId(m, bytes(PAYLOAD_TEXT)), expected);
        assertTrue(fullWidth.verifyMessage(m, bytes(PAYLOAD_TEXT), expected, DESTINATION_GATEWAY));
    }

    function _message() private view returns (MessageCodec.CanonicalMessage memory) {
        return MessageCodec.CanonicalMessage({ version: CROSS_CHAIN_MESSAGE_VERSION, sourceDomain: SOURCE_DOMAIN,
            sourceGateway: address(source), sourceSender: address(this), destinationDomain: DESTINATION_DOMAIN,
            destinationGateway: DESTINATION_GATEWAY, destinationReceiver: RECEIVER, nonce: 1,
            payloadHash: keccak256(bytes(PAYLOAD_TEXT)), deadline: DEADLINE });
    }

    // Fixture loops intentionally call the local view-only verifier and have no receiver execution.
    // forge-lint: disable-next-item(calls-loop)
    function _verify(MessageCodec.CanonicalMessage memory m, bytes memory payload, bytes32 id) private view returns (bool) {
        return verifier.verifyMessage(m, payload, id, DESTINATION_GATEWAY);
    }

    // Negative fixture loops require exact VM error bytes before calling the local verifier.
    // forge-lint: disable-next-item(calls-loop)
    function _reject(MessageCodec.CanonicalMessage memory m, bytes memory payload, bytes32 id, bytes memory expectedError) private {
        vm.expectRevert(expectedError);
        // forge-lint: disable-next-line(unused-return)
        _verify(m, payload, id);
    }

    function _rejectIdentity(MessageCodec.CanonicalMessage memory m, bytes memory payload, bytes32 original) private {
        _reject(m, payload, original, abi.encodeWithSelector(MessageDomainVerifier.MessageIdMismatch.selector, original, MessageCodec.computeMessageId(m)));
    }

    function _flip(bytes32 value) private pure returns (bytes32) {
        return value ^ bytes32(uint256(1));
    }
}
