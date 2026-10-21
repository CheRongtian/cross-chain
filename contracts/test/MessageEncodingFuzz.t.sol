// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolTestFixtures} from "./helpers/ProtocolTestFixtures.sol";
import {DeliveryCodecHarness} from "./helpers/DeliveryCodecHarness.sol";
import {MessageCodec, CROSS_CHAIN_MESSAGE_VERSION, CROSS_CHAIN_MESSAGE_TYPEHASH} from "../src/MessageCodec.sol";
import {MessageMerkle, MESSAGE_MERKLE_LEAF_DOMAIN, MESSAGE_MERKLE_NODE_DOMAIN} from "../src/MessageMerkle.sol";
import {MessageBatchCodec} from "../src/libraries/MessageBatchCodec.sol";
import {DeliveryPackageCodec as Codec} from "../src/libraries/DeliveryPackageCodec.sol";

contract MessageEncodingFuzzTest is ProtocolTestFixtures {
    uint256 private constant MESSAGE_MUTATIONS = 9;
    uint256 private constant EDGE_COUNT = 7;
    uint256 private constant MAX_FUZZ_PAYLOAD = 256;
    DeliveryCodecHarness private decoder;

    function setUp() public {
        decoder = new DeliveryCodecHarness();
    }

    // Payload construction is bounded before allocation; all static protocol fields retain their full width.
    // forge-lint: disable-next-item(asm-keccak256)
    function testFuzzCanonicalMessageAndTransportRoundTrip(
        MessageCodec.CanonicalMessage memory message, bytes32 entropy, uint256 lengthSeed
    ) public view {
        bytes memory payload = _boundedPayload(entropy, bound(lengthSeed, 0, MAX_FUZZ_PAYLOAD));
        message.version = CROSS_CHAIN_MESSAGE_VERSION;
        message.payloadHash = keccak256(payload);
        bytes memory encoded = _encode(_transport(message, payload));
        assertEq(decoder.roundTrip(encoded), encoded);
        MessageCodec.CanonicalMessage memory decoded = decoder.canonicalMessage(encoded);
        assertEq(abi.encode(decoded), abi.encode(message));
        bytes32 id = MessageCodec.computeMessageId(message);
        assertEq(MessageCodec.computeMessageId(decoded), id);
        assertEq(MessageCodec.computeMessageId(message), id);
    }

    function testFuzzOneSemanticFieldChangesCanonicalIdentity(
        MessageCodec.CanonicalMessage memory original, uint256 fieldSeed
    ) public pure {
        original.version = CROSS_CHAIN_MESSAGE_VERSION;
        MessageCodec.CanonicalMessage memory changed = _copyMessage(original);
        uint256 field = bound(fieldSeed, 0, MESSAGE_MUTATIONS - 1);
        if (field == 0) changed.sourceDomain ^= 1;
        else if (field == 1) changed.sourceGateway = address(uint160(changed.sourceGateway) ^ 1);
        else if (field == 2) changed.sourceSender = address(uint160(changed.sourceSender) ^ 1);
        else if (field == 3) changed.destinationDomain ^= 1;
        else if (field == 4) changed.destinationGateway = address(uint160(changed.destinationGateway) ^ 1);
        else if (field == 5) changed.destinationReceiver = address(uint160(changed.destinationReceiver) ^ 1);
        else if (field == 6) changed.nonce ^= 1;
        else if (field == 7) changed.payloadHash ^= bytes32(uint256(1));
        else changed.deadline ^= 1;
        assertNotEq(abi.encode(changed), abi.encode(original));
        assertNotEq(MessageCodec.computeMessageId(changed), MessageCodec.computeMessageId(original));
    }

    function testFuzzDistinctFullWidthNonceAndDomainSwap(MessageCodec.CanonicalMessage memory original) public pure {
        original.version = CROSS_CHAIN_MESSAGE_VERSION;
        MessageCodec.CanonicalMessage memory changed = _copyMessage(original);
        changed.nonce = original.nonce ^ 1;
        assertNotEq(abi.encode(changed), abi.encode(original));
        assertNotEq(MessageCodec.computeMessageId(changed), MessageCodec.computeMessageId(original));
        // Construct distinct full-width domains without rejecting sampled inputs or overflowing at max uint256.
        if (original.destinationDomain == original.sourceDomain) original.destinationDomain ^= 1;
        changed = _copyMessage(original);
        (changed.sourceDomain, changed.destinationDomain) = (original.destinationDomain, original.sourceDomain);
        assertNotEq(abi.encode(changed), abi.encode(original));
        assertNotEq(MessageCodec.computeMessageId(changed), MessageCodec.computeMessageId(original));
    }

    function testFuzzPayloadMutationChangesActualCommitment(bytes32 entropy, uint256 lengthSeed, uint256 positionSeed)
        public pure
    {
        bytes memory payload = _boundedPayload(entropy, bound(lengthSeed, 1, MAX_FUZZ_PAYLOAD));
        MessageCodec.CanonicalMessage memory original;
        original.version = CROSS_CHAIN_MESSAGE_VERSION;
        // forge-lint: disable-next-line(asm-keccak256)
        original.payloadHash = keccak256(payload);
        payload[bound(positionSeed, 0, payload.length - 1)] ^= bytes1(0x01);
        MessageCodec.CanonicalMessage memory changed = _copyMessage(original);
        // forge-lint: disable-next-line(asm-keccak256)
        changed.payloadHash = keccak256(payload);
        assertNotEq(original.payloadHash, changed.payloadHash);
        assertNotEq(MessageCodec.computeMessageId(original), MessageCodec.computeMessageId(changed));
    }

    // Each negative starts with a canonical object accepted by the actual decoder, then attacks one framing layer.
    function testFuzzCanonicalFramingRejectsTruncationTrailingPaddingOffsetsAndLengths(
        bytes32 entropy, uint256 seed, uint256 layerSeed, uint256 mutationSeed
    ) public view {
        MessageCodec.CanonicalMessage memory message;
        message.version = CROSS_CHAIN_MESSAGE_VERSION;
        Codec.Package memory pack = _transport(message, _boundedPayload(entropy, bound(seed, 0, MAX_FUZZ_PAYLOAD)));
        bytes memory original = _encode(pack);
        assertEq(decoder.roundTrip(original), original);
        uint256 layer = bound(layerSeed, 0, 2);
        bytes memory target = layer == 0 ? original : (layer == 1 ? pack.envelope.messageBytes : pack.envelope.batchBytes);
        uint256 mutation = bound(mutationSeed, 0, 4);
        if (mutation == 0) target = _truncate(target, bound(seed, 0, target.length - 1));
        else if (mutation == 1) target = bytes.concat(target, _boundedPayload(entropy, bound(seed, 1, FIXTURE_WORD)));
        else if (mutation == 2) {
            // Upper bits of a uint8 are always dirty, in the envelope/message/batch version word.
            _putWord(target, layer == 0 ? FIXTURE_WORD : 0, (uint256(1) << bound(seed, 8, 255)) | 1);
        } else {
            uint256 slot = layer == 0 ? 0 : (layer == 1 ? FIXTURE_WORD * 8 : FIXTURE_WORD * 3);
            if (mutation == 3) _putWord(target, slot, target.length + FIXTURE_WORD);
            else {
                uint256 dynamicStart = _getWord(target, slot);
                _putWord(target, dynamicStart, target.length + FIXTURE_WORD);
            }
        }
        bytes memory attacked;
        if (layer == 0) attacked = target;
        else {
            if (layer == 1) pack.envelope.messageBytes = target;
            else pack.envelope.batchBytes = target;
            // Preserve malicious inner bytes: do not call _encode here, which would repair them.
            attacked = _envelopeBytes(pack.envelope);
        }
        _rejectDecode(attacked);
    }

    function testFuzzDirtyDynamicPaddingAndUnsupportedTransport(uint256 seed, uint8 version) public view {
        MessageCodec.CanonicalMessage memory message;
        message.version = CROSS_CHAIN_MESSAGE_VERSION;
        Codec.Package memory pack = _transport(message, "");
        bytes memory encoded = _encode(pack);
        assertEq(decoder.roundTrip(encoded), encoded);
        uint256 domainStart = _getWord(encoded, 0);
        uint256 domainLength = bytes(pack.envelope.domain).length;
        uint256 padding = FIXTURE_WORD - domainLength;
        encoded[domainStart + FIXTURE_WORD + domainLength + bound(seed, 0, padding - 1)] = bytes1(0x01);
        _rejectDecode(encoded);
        pack.envelope.version = version == 1 ? 0 : version;
        bytes memory invalidVersion = _encode(pack);
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory reason) = address(decoder).staticcall(abi.encodeCall(decoder.roundTrip, (invalidVersion)));
        assertFalse(success);
        assertEq(reason, abi.encodeWithSelector(Codec.UnsupportedTransportVersion.selector, pack.envelope.version));
    }

    function testFuzzDirtyAddressWidthAndPayloadPadding(bytes32 entropy, uint256 seed, uint256 paddingSeed) public view {
        MessageCodec.CanonicalMessage memory message;
        message.version = CROSS_CHAIN_MESSAGE_VERSION;
        message.sourceGateway = address(0x1001);
        bytes memory payload = _boundedPayload(entropy, bound(seed, 1, FIXTURE_WORD - 1));
        Codec.Package memory pack = _transport(message, payload);
        bytes memory canonical = _encode(pack);
        assertEq(decoder.roundTrip(canonical), canonical);
        bytes memory originalMessage = pack.envelope.messageBytes;
        bytes memory dirtyAddress = bytes.concat(originalMessage);
        _putWord(dirtyAddress, FIXTURE_WORD * 2,
            uint256(uint160(message.sourceGateway)) | (uint256(1) << bound(seed, 160, 255)));
        pack.envelope.messageBytes = dirtyAddress;
        _rejectDecode(_envelopeBytes(pack.envelope));
        bytes memory dirtyPadding = bytes.concat(originalMessage);
        uint256 payloadStart = _getWord(dirtyPadding, FIXTURE_WORD * 8);
        uint256 padding = FIXTURE_WORD - payload.length;
        dirtyPadding[payloadStart + FIXTURE_WORD + payload.length + bound(paddingSeed, 0, padding - 1)] = bytes1(0x01);
        pack.envelope.messageBytes = dirtyPadding;
        _rejectDecode(_envelopeBytes(pack.envelope));
    }

    // Explicit exact-width corpus supplements the generated samples. No arithmetic increment can overflow here.
    // forge-lint: disable-next-item(calls-loop)
    function testFullWidthEncodingCorpusAndProductionDomains() public view {
        uint256[EDGE_COUNT] memory edges = [uint256(0), 1, (uint256(1) << 53) - 1,
            uint256(1) << 53, uint256(1) << 128, uint256(1) << 255, type(uint256).max];
        for (uint256 index = 0; index < edges.length; index++) {
            MessageCodec.CanonicalMessage memory message;
            message.version = CROSS_CHAIN_MESSAGE_VERSION;
            message.sourceDomain = edges[index];
            message.destinationDomain = edges[index] ^ 1;
            message.nonce = edges[index];
            message.deadline = edges[index];
            bytes memory encoded = _encode(_transport(message, ""));
            assertEq(decoder.roundTrip(encoded), encoded);
            assertEq(abi.encode(decoder.canonicalMessage(encoded)), abi.encode(message));
        }
        assertNotEq(CROSS_CHAIN_MESSAGE_TYPEHASH, MESSAGE_MERKLE_LEAF_DOMAIN);
        assertNotEq(CROSS_CHAIN_MESSAGE_TYPEHASH, MESSAGE_MERKLE_NODE_DOMAIN);
        assertNotEq(CROSS_CHAIN_MESSAGE_TYPEHASH, MessageBatchCodec.TYPEHASH);
        assertNotEq(MessageBatchCodec.TYPEHASH, MESSAGE_MERKLE_LEAF_DOMAIN);
        assertNotEq(MessageBatchCodec.TYPEHASH, MESSAGE_MERKLE_NODE_DOMAIN);
        assertNotEq(MESSAGE_MERKLE_LEAF_DOMAIN, MESSAGE_MERKLE_NODE_DOMAIN);
    }

    function testFuzzLeafCannotReplaceNode(bytes32 batchId, uint256 position, bytes32 messageId, bytes32 right)
        public pure
    {
        bytes32 leaf = MessageMerkle.computeLeaf(batchId, position, messageId);
        assertNotEq(leaf, MessageMerkle.hashNode(messageId, right));
        assertNotEq(MessageMerkle.hashNode(leaf, right), MessageMerkle.computeLeaf(leaf, position, right));
    }

    function _rejectDecode(bytes memory encoded) private view {
        // Only the production decoder's own call is classified. A fixture panic escapes and fails the test.
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory reason) = address(decoder).staticcall(abi.encodeCall(decoder.roundTrip, (encoded)));
        assertFalse(success, "malformed encoding accepted");
        if (reason.length != 0) {
            assertEq(_revertSelector(reason), Codec.InvalidPackageEncoding.selector,
                "unexpected decoder rejection (including panic)");
        }
    }

    // The exact-width corpus calls this constructor in a bounded loop. These fixed-size arrays only build
    // local ABI inputs; no decoding, authority check or attacker-selected allocation is replaced here.
    // forge-lint: disable-next-item(calls-loop)
    function _transport(MessageCodec.CanonicalMessage memory message, bytes memory payload)
        private pure returns (Codec.Package memory pack)
    {
        pack.message.version = message.version;
        pack.message.sourceDomain = message.sourceDomain;
        pack.message.sourceGateway = message.sourceGateway;
        pack.message.sourceSender = message.sourceSender;
        pack.message.destinationDomain = message.destinationDomain;
        pack.message.destinationGateway = message.destinationGateway;
        pack.message.destinationReceiver = message.destinationReceiver;
        pack.message.nonce = message.nonce;
        pack.message.payload = payload;
        pack.message.payloadHash = message.payloadHash;
        pack.message.deadline = message.deadline;
        pack.message.messageId = MessageCodec.computeMessageId(message);
        pack.batch.version = 1;
        pack.batch.messageIds = new bytes32[](1);
        pack.batch.messageIds[0] = pack.message.messageId;
        pack.envelope.domain = "CrossChainDeliveryPackage";
        pack.envelope.version = 1;
        pack.envelope.deliveryJobId = "fuzz";
        pack.envelope.leafCount = 1;
        pack.envelope.siblings = new bytes32[](0);
    }

    function _copyMessage(MessageCodec.CanonicalMessage memory m) private pure returns (MessageCodec.CanonicalMessage memory) {
        return MessageCodec.CanonicalMessage({version: m.version, sourceDomain: m.sourceDomain,
            sourceGateway: m.sourceGateway, sourceSender: m.sourceSender, destinationDomain: m.destinationDomain,
            destinationGateway: m.destinationGateway, destinationReceiver: m.destinationReceiver,
            nonce: m.nonce, payloadHash: m.payloadHash, deadline: m.deadline});
    }

    function _boundedPayload(bytes32 entropy, uint256 length) private pure returns (bytes memory payload) {
        payload = new bytes(length);
        for (uint256 index = 0; index < length; index++) payload[index] = entropy[index % FIXTURE_WORD];
    }

    function _truncate(bytes memory value, uint256 length) private pure returns (bytes memory truncated) {
        truncated = new bytes(length);
        for (uint256 index = 0; index < length; index++) truncated[index] = value[index];
    }
}
