// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageReplayProtection} from "../src/MessageReplayProtection.sol";
import {MessageCodec, CROSS_CHAIN_MESSAGE_VERSION} from "../src/MessageCodec.sol";
import {RemoteGatewayRegistry} from "../src/RemoteGatewayRegistry.sol";
import {ValidatorSetRegistry} from "../src/ValidatorSetRegistry.sol";
import {MessageReplayProtectionHarness} from "./mocks/MessageReplayProtectionHarness.sol";
import {ReplayQueryHarness} from "./mocks/ReplayQueryHarness.sol";
import {AuthenticatedMessageReplayHarness} from "./mocks/AuthenticatedMessageReplayHarness.sol";
import {ReplayTestReceiver} from "./mocks/ReplayTestReceiver.sol";

contract MessageReplayProtectionTest is Test {
    uint256 private constant SOURCE_DOMAIN = 10_011;
    uint256 private constant DESTINATION_DOMAIN = 2001;
    uint256 private constant DEADLINE = 2_000_003_600;
    uint256 private constant FIRST_VALIDATOR_EPOCH = 7;
    uint256 private constant KEY_COUNT = 5;
    uint256 private constant COMMITTEE_SIZE = 4;
    uint256 private constant UNSUPPORTED_API_COUNT = 4;
    address private constant FOURTH_VALIDATOR = address(4);
    address private constant SOURCE_GATEWAY = address(0xA11CE);
    address private constant DESTINATION_GATEWAY = address(0xD00D);
    address private constant RECEIVER = address(0xBEEF);
    address private constant CALLER_A = address(0xA);
    address private constant CALLER_B = address(0xB);
    bytes32 private constant PAYLOAD_HASH = keccak256("same replay payload");

    MessageReplayProtectionHarness private replay;
    ReplayTestReceiver private receiver;

    function setUp() public {
        replay = new MessageReplayProtectionHarness();
        receiver = new ReplayTestReceiver();
    }

    function testAuthenticatedHarnessRejectsZeroExpectedGateway() public {
        vm.expectRevert(AuthenticatedMessageReplayHarness.InvalidExpectedDestinationGateway.selector);
        new AuthenticatedMessageReplayHarness(address(replay), address(replay), address(replay), address(0));
    }

    function testFirstConsumptionAndDuplicateErrorHaveExactState() public {
        bytes32 id = _id(SOURCE_DOMAIN, 1);
        bytes32 other = _id(SOURCE_DOMAIN, 2);
        assertFalse(replay.isMessageExecuted(id));
        vm.recordLogs();
        replay.consume(id);
        assertTrue(replay.isMessageExecuted(id));
        assertFalse(replay.isMessageExecuted(other));
        assertEq(vm.getRecordedLogs().length, 0);
        vm.expectRevert(_duplicate(id));
        replay.consume(id);
        assertTrue(replay.isMessageExecuted(id));
        assertFalse(replay.isMessageExecuted(other));
    }

    function testDifferentSubmittersCannotReplay() public {
        bytes32 id = _id(SOURCE_DOMAIN, 1);
        vm.prank(CALLER_A);
        replay.consume(id);
        vm.expectRevert(_duplicate(id));
        vm.prank(CALLER_B);
        replay.consume(id);
        assertTrue(replay.isMessageExecuted(id));
    }

    function testSamePayloadDistinctNoncesAndDomainsRemainIndependentOutOfOrder() public {
        bytes32 first = _id(SOURCE_DOMAIN, 1);
        bytes32 later = _id(SOURCE_DOMAIN, 2);
        bytes32 otherDomain = _id(SOURCE_DOMAIN + 1, 1);
        assertNotEq(first, later);
        assertNotEq(first, otherDomain);
        replay.consume(later);
        assertFalse(replay.isMessageExecuted(first));
        assertFalse(replay.isMessageExecuted(otherDomain));
        replay.consume(otherDomain);
        replay.consume(first);
        assertTrue(replay.isMessageExecuted(first));
        assertTrue(replay.isMessageExecuted(later));
        assertTrue(replay.isMessageExecuted(otherDomain));
    }

    // A bounded set exercises exact keys, including zero, without inventing a new zero-ID protocol rule.
    // forge-lint: disable-next-item(calls-loop)
    function testFullBytes32WidthHasNoTruncationOrLeadingZeroCollision() public {
        bytes32[KEY_COUNT] memory ids = [bytes32(0), bytes32(uint256(1)), bytes32(uint256(1) << 8),
            bytes32((uint256(1) << 200) + 1), bytes32(type(uint256).max)];
        for (uint256 index = 0; index < ids.length; index++) {
            assertFalse(replay.isMessageExecuted(ids[index]));
            replay.consume(ids[index]);
            assertTrue(replay.isMessageExecuted(ids[index]));
        }
        for (uint256 index = 0; index < ids.length; index++) {
            vm.expectRevert(_duplicate(ids[index]));
            replay.consume(ids[index]);
        }
    }

    function testFuzzExactlyOnceForFullWidthKey(bytes32 id) public {
        assertFalse(replay.isMessageExecuted(id));
        replay.consume(id);
        assertTrue(replay.isMessageExecuted(id));
        vm.expectRevert(_duplicate(id));
        replay.consume(id);
    }

    function testIntentionalOuterRevertRestoresStateAndAllowsRetry() public {
        bytes32 id = _id(SOURCE_DOMAIN, 1);
        vm.expectRevert(abi.encodeWithSelector(MessageReplayProtectionHarness.IntentionalRollback.selector, id));
        replay.consumeThenRevert(id);
        assertFalse(replay.isMessageExecuted(id));
        replay.consume(id);
        assertTrue(replay.isMessageExecuted(id));
    }

    function testDownstreamFailureRollsBackAndRetrySucceeds() public {
        bytes32 id = _id(SOURCE_DOMAIN, 1);
        receiver.configure(true, bytes(""), false);
        vm.expectRevert(abi.encodeWithSelector(ReplayTestReceiver.MockExecutionFailed.selector, id));
        replay.consumeThenCall(id, address(receiver));
        assertFalse(replay.isMessageExecuted(id));
        assertEq(receiver.calls(), 0);
        receiver.configure(false, bytes(""), false);
        replay.consumeThenCall(id, address(receiver));
        assertTrue(replay.isMessageExecuted(id));
        assertTrue(receiver.observedConsumed());
        assertEq(receiver.calls(), 1);
        vm.expectRevert(_duplicate(id));
        replay.consumeThenCall(id, address(receiver));
        assertEq(receiver.calls(), 1);
    }

    function testSameMessageReentrySeesConsumedAndCannotRunTwice() public {
        bytes32 id = _id(SOURCE_DOMAIN, 1);
        receiver.configure(false, abi.encodeCall(replay.consume, (id)), false);
        replay.consumeThenCall(id, address(receiver));
        assertTrue(replay.isMessageExecuted(id));
        assertTrue(receiver.observedConsumed());
        assertFalse(receiver.reentrySucceeded());
        assertEq(receiver.reentryResult(), _duplicate(id));
        assertEq(receiver.calls(), 1);
    }

    function testOuterRevertAfterReentryRestoresStateAndRetrySucceeds() public {
        bytes32 id = _id(SOURCE_DOMAIN, 1);
        bytes memory nested = abi.encodeCall(replay.consume, (id));
        receiver.configure(false, nested, true);
        vm.expectRevert(abi.encodeWithSelector(ReplayTestReceiver.MockExecutionFailed.selector, id));
        replay.consumeThenCall(id, address(receiver));
        assertFalse(replay.isMessageExecuted(id));
        assertFalse(receiver.observedConsumed());
        assertEq(receiver.calls(), 0);
        receiver.configure(false, nested, false);
        replay.consumeThenCall(id, address(receiver));
        assertTrue(replay.isMessageExecuted(id));
        assertFalse(receiver.reentrySucceeded());
        assertEq(receiver.reentryResult(), _duplicate(id));
    }

    function testDistinctMessageReentryHasNoGlobalLock() public {
        bytes32 first = _id(SOURCE_DOMAIN, 1);
        bytes32 second = _id(SOURCE_DOMAIN, 2);
        receiver.configure(false, abi.encodeCall(replay.consume, (second)), false);
        replay.consumeThenCall(first, address(receiver));
        assertTrue(receiver.observedConsumed());
        assertTrue(receiver.reentrySucceeded());
        assertTrue(replay.isMessageExecuted(first));
        assertTrue(replay.isMessageExecuted(second));
    }

    function testOuterRevertAlsoRestoresDistinctNestedConsumption() public {
        bytes32 first = _id(SOURCE_DOMAIN, 1);
        bytes32 second = _id(SOURCE_DOMAIN, 2);
        receiver.configure(false, abi.encodeCall(replay.consume, (second)), true);
        vm.expectRevert(abi.encodeWithSelector(ReplayTestReceiver.MockExecutionFailed.selector, first));
        replay.consumeThenCall(first, address(receiver));
        assertFalse(replay.isMessageExecuted(first));
        assertFalse(replay.isMessageExecuted(second));
    }

    function testTimeAndRegistryChangesNeverClearConsumption() public {
        bytes32 id = _id(SOURCE_DOMAIN, 1);
        RemoteGatewayRegistry remote = new RemoteGatewayRegistry(address(this));
        remote.setRemoteGateway(SOURCE_DOMAIN, SOURCE_GATEWAY);
        ValidatorSetRegistry validators = new ValidatorSetRegistry(address(this));
        address[COMMITTEE_SIZE] memory committee = [address(1), address(2), address(3), FOURTH_VALIDATOR];
        validators.registerValidatorSet(FIRST_VALIDATOR_EPOCH, committee);
        replay.consume(id);
        vm.warp(DEADLINE + 1);
        remote.setRemoteGateway(SOURCE_DOMAIN, RECEIVER);
        validators.registerValidatorSet(FIRST_VALIDATOR_EPOCH + 1, committee);
        assertTrue(replay.isMessageExecuted(id));
        remote.removeRemoteGateway(SOURCE_DOMAIN);
        assertTrue(replay.isMessageExecuted(id));
        vm.expectRevert(_duplicate(id));
        replay.consume(id);
    }

    // Exact empty-fallback failures demonstrate that the inherited surface exposes no mutation/reset API.
    // forge-lint: disable-next-item(calls-loop)
    function testInheritedSurfaceHasQueryOnlyAndNoPublicConsumeOrReset() public {
        ReplayQueryHarness queryOnly = new ReplayQueryHarness();
        bytes32 id = _id(SOURCE_DOMAIN, 1);
        string[UNSUPPORTED_API_COUNT] memory signatures = ["consume(bytes32)", "resetMessage(bytes32)",
            "clearReplay(bytes32)", "adminReplayOverride(bytes32)"];
        for (uint256 index = 0; index < signatures.length; index++) {
            // Intentionally probe selectors absent from the ABI and inspect their exact empty failure data.
            // forge-lint: disable-next-line(low-level-calls)
            (bool success, bytes memory result) = address(queryOnly).call(abi.encodeWithSignature(signatures[index], id));
            assertFalse(success);
            assertEq(result, bytes(""));
            assertFalse(queryOnly.isMessageExecuted(id));
        }
    }

    function _id(uint256 domain, uint256 nonce) private pure returns (bytes32) {
        return MessageCodec.computeMessageId(MessageCodec.CanonicalMessage({
            version: CROSS_CHAIN_MESSAGE_VERSION, sourceDomain: domain, sourceGateway: SOURCE_GATEWAY,
            sourceSender: CALLER_A, destinationDomain: DESTINATION_DOMAIN, destinationGateway: DESTINATION_GATEWAY,
            destinationReceiver: RECEIVER, nonce: nonce, payloadHash: PAYLOAD_HASH, deadline: DEADLINE
        }));
    }

    function _duplicate(bytes32 id) private pure returns (bytes memory) {
        return abi.encodeWithSelector(MessageReplayProtection.MessageAlreadyExecuted.selector, id);
    }
}
