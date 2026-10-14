// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {ForwardAuthorizationCodec, FORWARD_AUTHORIZATION_TYPEHASH} from "../src/ForwardAuthorizationCodec.sol";
import {CROSS_CHAIN_MESSAGE_TYPEHASH} from "../src/MessageCodec.sol";
import {ForwardAuthorizationVector} from "../generated/ForwardAuthorizationVector.sol";

contract ForwardAuthorizationCodecTest is Test {
    enum IntentField {
        PROTOCOL_VERSION,
        ACTION,
        SOURCE_DOMAIN,
        APPLICATION,
        SOURCE_GATEWAY,
        DESTINATION_DOMAIN,
        DESTINATION_GATEWAY,
        DESTINATION_RECEIVER,
        PAYLOAD_HASH,
        DEADLINE,
        AUTHORIZED_EXECUTOR
    }

    uint256 internal constant INTENT_FIELD_COUNT = uint256(IntentField.AUTHORIZED_EXECUTOR) + 1;
    address internal constant CHANGED_ADDRESS = address(0x123);
    bytes32 internal constant CHANGED_PAYLOAD_HASH = bytes32(uint256(123));

    function testSharedForwardIntentEncodingAndDigest() public pure {
        ForwardAuthorizationCodec.Intent memory intent = ForwardAuthorizationVector.intent();
        assertEq(ForwardAuthorizationCodec.encode(intent), ForwardAuthorizationVector.expectedEncoding());
        assertEq(ForwardAuthorizationCodec.digest(intent), ForwardAuthorizationVector.expectedDigest());
        assertTrue(FORWARD_AUTHORIZATION_TYPEHASH != CROSS_CHAIN_MESSAGE_TYPEHASH);
        (uint256 hi, uint256 lo) = ForwardAuthorizationCodec.split(ForwardAuthorizationCodec.digest(intent));
        assertEq(hi, ForwardAuthorizationVector.expectedHi());
        assertEq(lo, ForwardAuthorizationVector.expectedLo());
    }
    function testDigestLimbsPreserveLeadingZerosAndFullWidth() public pure {
        (uint256 hi, uint256 lo) = ForwardAuthorizationCodec.split(bytes32((uint256(1) << 128) | 2));
        assertEq(hi, 1); assertEq(lo, 2);
        (hi, lo) = ForwardAuthorizationCodec.split(bytes32(uint256(1) << 255));
        assertEq(hi, uint256(1) << 127); assertEq(lo, 0);
        (hi, lo) = ForwardAuthorizationCodec.split(bytes32(type(uint256).max));
        assertEq(hi, type(uint128).max); assertEq(lo, type(uint128).max);
        assertEq((hi << 128) | lo, type(uint256).max);
    }
    function testEveryForwardIntentFieldChangesDigest() public pure {
        bytes32 original = ForwardAuthorizationVector.expectedDigest();
        for (uint256 field = 0; field < INTENT_FIELD_COUNT; ++field) {
            // The loop bounds the conversion to the declared enum members.
            // forge-lint: disable-next-line(unsafe-typecast)
            ForwardAuthorizationCodec.Intent memory intent = _mutatedIntent(IntentField(field));
            assertTrue(ForwardAuthorizationCodec.digest(intent) != original);
        }
    }

    function _mutatedIntent(IntentField field)
        private
        pure
        returns (ForwardAuthorizationCodec.Intent memory intent)
    {
        intent = ForwardAuthorizationVector.intent();
        _mutateSourceFields(intent, field);
        _mutateDestinationFields(intent, field);
    }

    function _mutateSourceFields(ForwardAuthorizationCodec.Intent memory intent, IntentField field) private pure {
        if (field == IntentField.PROTOCOL_VERSION) intent.protocolVersion += 1;
        if (field == IntentField.ACTION) intent.action += 1;
        if (field == IntentField.SOURCE_DOMAIN) intent.sourceDomain += 1;
        if (field == IntentField.APPLICATION) intent.application = CHANGED_ADDRESS;
        if (field == IntentField.SOURCE_GATEWAY) intent.sourceGateway = CHANGED_ADDRESS;
        if (field == IntentField.AUTHORIZED_EXECUTOR) intent.authorizedExecutor = CHANGED_ADDRESS;
    }

    function _mutateDestinationFields(ForwardAuthorizationCodec.Intent memory intent, IntentField field) private pure {
        if (field == IntentField.DESTINATION_DOMAIN) intent.destinationDomain += 1;
        if (field == IntentField.DESTINATION_GATEWAY) intent.destinationGateway = CHANGED_ADDRESS;
        if (field == IntentField.DESTINATION_RECEIVER) intent.destinationReceiver = CHANGED_ADDRESS;
        if (field == IntentField.PAYLOAD_HASH) intent.payloadHash = CHANGED_PAYLOAD_HASH;
        if (field == IntentField.DEADLINE) intent.deadline += 1;
    }
}
