// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MessageCodec} from "../src/MessageCodec.sol";
import {MessageMerkle, MESSAGE_MERKLE_LEAF_DOMAIN, MESSAGE_MERKLE_NODE_DOMAIN} from "../src/MessageMerkle.sol";

/// @dev All library calls run in Foundry's local EVM. No harness is deployed to either chain.
///      Local calls-loop annotations cover trusted VM/JSON fixture helpers and proof-array allocations.
///      These test-only operations deliberately exercise every path; production lint remains enabled.
contract MessageMerkleTest is Test {
    using stdJson for string;

    bytes32 internal constant BATCH_TYPEHASH =
        keccak256("MessageBatch(uint8 version,uint256 sourceDomain,address sourceGateway,uint256 epoch,bytes32[] messageIds)");
    uint256 internal constant GOLDEN_VECTOR_COUNT = 5;
    uint256 internal constant ALTERNATE_LEAF_COUNT = 4;
    string internal fixture;

    function setUp() public {
        // Read only the fixed, shared public fixture allowed by Foundry's existing fs_permissions.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        fixture = vm.readFile(string.concat(vm.projectRoot(), "/../test-vectors/merkle-golden-vectors.json"));
    }

    function testSharedMerkleDomainsMatchGoldenValues() public view {
        assertEq(fixture.readUint(".schemaVersion"), 1);
        assertEq(fixture.readString(".protocol"), "ordered-message-merkle-abi-keccak-v1");
        assertEq(MESSAGE_MERKLE_LEAF_DOMAIN, fixture.readBytes32(".leafDomain"));
        assertEq(MESSAGE_MERKLE_NODE_DOMAIN, fixture.readBytes32(".nodeDomain"));
        assertEq(keccak256(bytes(fixture.readString(".leafType"))), MESSAGE_MERKLE_LEAF_DOMAIN);
        assertEq(keccak256(bytes(fixture.readString(".nodeType"))), MESSAGE_MERKLE_NODE_DOMAIN);
    }

    function testSharedMerkleLeavesNodesRootsAndProofs() public view {
        assertEq(vm.parseJsonArrayLength(fixture, ".vectors"), GOLDEN_VECTOR_COUNT);
        for (uint256 vectorIndex = 0; vectorIndex < GOLDEN_VECTOR_COUNT; vectorIndex++) {
            _assertVector(vectorIndex);
        }
    }

    function _assertVector(uint256 vectorIndex) internal view {
        string memory base = _vectorPath(vectorIndex);
        uint256 count = fixture.readUint(string.concat(base, ".leafCount"));
        assertEq(count, vectorIndex + 1);
        bytes32 batchId = fixture.readBytes32(string.concat(base, ".batch.batchId"));
        bytes32 root = fixture.readBytes32(string.concat(base, ".messageRoot"));
        bytes32[] memory messageIds = fixture.readBytes32Array(string.concat(base, ".batch.messageIds"));
        bytes32[] memory leaves = fixture.readBytes32Array(string.concat(base, ".leaves"));
        assertEq(messageIds.length, count);
        assertEq(leaves.length, count);
        assertEq(_decimal(fixture, string.concat(base, ".batch.version")), 1);
        _assertBatchId(base, batchId, messageIds);
        for (uint256 index = 0; index < count; index++) {
            // forge-lint: disable-next-line(calls-loop)
            assertEq(_canonicalMessageId(string.concat(base, ".batch.messages[", vm.toString(index), "]")), messageIds[index]);
            assertEq(MessageMerkle.computeLeaf(batchId, index, messageIds[index]), leaves[index]);
            assertEq(
                abi.encode(MESSAGE_MERKLE_LEAF_DOMAIN, batchId, index, messageIds[index]),
                // forge-lint: disable-next-line(calls-loop)
                fixture.readBytes(string.concat(base, ".leafPreimages[", vm.toString(index), "]"))
            );
            // forge-lint: disable-next-line(calls-loop)
            MessageMerkle.Proof memory proof = _readProof(fixture, string.concat(base, ".proofs[", vm.toString(index), "]"));
            assertEq(proof.index, index);
            assertEq(proof.leafCount, count);
            // forge-lint: disable-next-line(calls-loop)
            assertTrue(fixture.readBool(string.concat(base, ".proofs[", vm.toString(index), "].expectedValid")));
            assertTrue(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
            _assertProofPath(base, proof);
        }
        _assertLevels(base, leaves, root);
    }

    function _assertBatchId(string memory base, bytes32 expected, bytes32[] memory messageIds) internal view {
        uint256 domain = _decimal(fixture, string.concat(base, ".batch.sourceDomain"));
        address gateway = fixture.readAddress(string.concat(base, ".batch.sourceGateway"));
        uint256 epoch = _decimal(fixture, string.concat(base, ".batch.epoch"));
        assertEq(keccak256(abi.encode(BATCH_TYPEHASH, uint8(1), domain, gateway, epoch, messageIds)), expected);
    }

    function _canonicalMessageId(string memory base) internal view returns (bytes32) {
        uint256 version = _decimal(fixture, string.concat(base, ".version"));
        assertLe(version, type(uint8).max);
        MessageCodec.CanonicalMessage memory message;
        // The checked fixture version fits the canonical uint8 message field.
        // forge-lint: disable-next-line(unsafe-typecast)
        message.version = uint8(version);
        message.sourceDomain = _decimal(fixture, string.concat(base, ".sourceDomain"));
        message.sourceGateway = fixture.readAddress(string.concat(base, ".sourceGateway"));
        message.sourceSender = fixture.readAddress(string.concat(base, ".sourceSender"));
        message.destinationDomain = _decimal(fixture, string.concat(base, ".destinationDomain"));
        message.destinationGateway = fixture.readAddress(string.concat(base, ".destinationGateway"));
        message.destinationReceiver = fixture.readAddress(string.concat(base, ".destinationReceiver"));
        message.nonce = _decimal(fixture, string.concat(base, ".nonce"));
        message.payloadHash = fixture.readBytes32(string.concat(base, ".payloadHash"));
        message.deadline = _decimal(fixture, string.concat(base, ".deadline"));
        assertEq(keccak256(fixture.readBytes(string.concat(base, ".payload"))), message.payloadHash);
        return MessageCodec.computeMessageId(message);
    }

    function _assertLevels(string memory base, bytes32[] memory leaves, bytes32 root) internal view {
        bytes32[] memory children = leaves;
        uint256 level = 0;
        bool descendingPair = false;
        assertEq(fixture.readBytes32Array(string.concat(base, ".levels[0]")), leaves);
        while (children.length > 1) {
            // forge-lint: disable-next-line(calls-loop)
            bytes32[] memory parents = fixture.readBytes32Array(string.concat(base, ".levels[", vm.toString(level + 1), "]"));
            assertEq(parents.length, children.length / 2 + children.length % 2);
            for (uint256 index = 0; index < children.length; index += 2) {
                bytes32 left = children[index];
                bytes32 right = index + 1 < children.length ? children[index + 1] : left;
                assertEq(MessageMerkle.hashNode(left, right), parents[index / 2]);
                if (left != right) assertNotEq(MessageMerkle.hashNode(right, left), parents[index / 2]);
                if (left > right) descendingPair = true;
            }
            children = parents;
            level++;
        }
        // forge-lint: disable-next-line(calls-loop)
        assertEq(vm.parseJsonArrayLength(fixture, string.concat(base, ".levels")), level + 1);
        assertEq(children[0], root);
        if (leaves.length == GOLDEN_VECTOR_COUNT) assertTrue(descendingPair, "five-leaf vector must expose sorted-pair drift");
    }

    function _assertProofPath(string memory base, MessageMerkle.Proof memory proof) internal view {
        uint256 position = proof.index;
        // forge-lint: disable-next-line(calls-loop)
        uint256 depth = vm.parseJsonArrayLength(fixture, string.concat(base, ".levels")) - 1;
        assertEq(proof.siblings.length, depth);
        for (uint256 level = 0; level < depth; level++) {
            // forge-lint: disable-next-line(calls-loop)
            bytes32[] memory nodes = fixture.readBytes32Array(string.concat(base, ".levels[", vm.toString(level), "]"));
            uint256 siblingIndex = position % 2 == 0 ? position + 1 : position - 1;
            assertEq(proof.siblings[level], nodes[siblingIndex < nodes.length ? siblingIndex : position]);
            position /= 2;
        }
    }

    function testSharedMerkleNegativeProofs() public view {
        for (uint256 vectorIndex = 0; vectorIndex < GOLDEN_VECTOR_COUNT; vectorIndex++) {
            string memory base = _vectorPath(vectorIndex);
            uint256 count = fixture.readUint(string.concat(base, ".leafCount"));
            bytes32 batchId = fixture.readBytes32(string.concat(base, ".batch.batchId"));
            bytes32 root = fixture.readBytes32(string.concat(base, ".messageRoot"));
            bytes32[] memory messageIds = fixture.readBytes32Array(string.concat(base, ".batch.messageIds"));
            for (uint256 index = 0; index < count; index++) {
                // forge-lint: disable-next-line(calls-loop)
                string memory proofPath = string.concat(base, ".proofs[", vm.toString(index), "]");
                // forge-lint: disable-next-line(calls-loop)
                MessageMerkle.Proof memory proof = _readProof(fixture, proofPath);
                proof.batchId = _flip(proof.batchId);
                assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
                proof = _readProof(fixture, proofPath);
                proof.messageId = _flip(proof.messageId);
                assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
                proof = _readProof(fixture, proofPath);
                proof.index = count == 1 ? 1 : (index + 1) % count;
                assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
                proof = _readProof(fixture, proofPath);
                proof.leafCount = count + 1;
                assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
                proof.leafCount = 0;
                assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
                proof = _readProof(fixture, proofPath);
                assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, _flip(root), proof));
                assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], 0, root, proof));
                {
                    // forge-lint: disable-next-line(calls-loop)
                    bytes32[] memory extended = new bytes32[](proof.siblings.length + 1);
                    for (uint256 level = 0; level < proof.siblings.length; level++) extended[level] = proof.siblings[level];
                    extended[proof.siblings.length] = _flip(root);
                    proof.siblings = extended;
                    assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
                }
                proof = _readProof(fixture, proofPath);
                if (proof.siblings.length > 0) {
                    proof.siblings[0] = _flip(proof.siblings[0]);
                    assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
                    proof = _readProof(fixture, proofPath);
                    // forge-lint: disable-next-line(calls-loop)
                    proof.siblings = new bytes32[](proof.siblings.length - 1);
                    assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
                }
                proof = _readProof(fixture, proofPath);
                if (proof.siblings.length > 1) {
                    // forge-lint: disable-next-line(calls-loop)
                    bytes32[] memory swapped = new bytes32[](proof.siblings.length);
                    for (uint256 level = 0; level < swapped.length; level++) swapped[level] = proof.siblings[swapped.length - level - 1];
                    proof.siblings = swapped;
                    assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
                }
                if (count > 1) {
                    // forge-lint: disable-next-line(calls-loop)
                    proof = _readProof(fixture, string.concat(base, ".proofs[", vm.toString((index + 1) % count), "]"));
                    assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
                }
                proof = _readProof(fixture, string.concat(_vectorPath((vectorIndex + 1) % GOLDEN_VECTOR_COUNT), ".proofs[0]"));
                assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
            }
        }
    }

    function testOddDuplicationRejectsMatchingForgedRoot() public view {
        for (uint256 vectorIndex = 2; vectorIndex < GOLDEN_VECTOR_COUNT; vectorIndex += 2) {
            string memory base = _vectorPath(vectorIndex);
            uint256 count = fixture.readUint(string.concat(base, ".leafCount"));
            // forge-lint: disable-next-line(calls-loop)
            MessageMerkle.Proof memory proof = _readProof(fixture, string.concat(base, ".proofs[", vm.toString(count - 1), "]"));
            bytes32 node = MessageMerkle.computeLeaf(proof.batchId, proof.index, proof.messageId);
            proof.siblings[0] = _flip(proof.siblings[0]);
            uint256 position = proof.index;
            for (uint256 level = 0; level < proof.siblings.length; level++) {
                node = position % 2 == 0 ? MessageMerkle.hashNode(node, proof.siblings[level]) : MessageMerkle.hashNode(proof.siblings[level], node);
                position /= 2;
            }
            assertFalse(MessageMerkle.verifyProof(proof.batchId, proof.messageId, count, node, proof));
        }
    }

    function testTrustedCountRejectsAmbiguousThreeToFourLeafPath() public view {
        MessageMerkle.Proof memory proof = _readProof(fixture, ".vectors[2].proofs[0]");
        bytes32 root = fixture.readBytes32(".vectors[2].messageRoot");
        proof.leafCount = ALTERNATE_LEAF_COUNT;
        assertFalse(MessageMerkle.verifyProof(proof.batchId, proof.messageId, 3, root, proof));
        // Demonstrates why expected count must be trusted separately from this path.
        assertTrue(MessageMerkle.verifyProof(proof.batchId, proof.messageId, ALTERNATE_LEAF_COUNT, root, proof));
    }

    function testGoldenEncodingProbeLocksUint256AndKeccak() public view {
        bytes32 batchId = fixture.readBytes32(".encodingProbe.batchId");
        bytes32 messageId = fixture.readBytes32(".encodingProbe.messageId");
        uint256 index = fixture.readUint(".encodingProbe.index");
        bytes32 expected = fixture.readBytes32(".encodingProbe.expectedLeaf");
        bytes memory preimage = fixture.readBytes(".encodingProbe.preimage");
        assertEq(index, 4_294_967_297);
        assertEq(abi.encode(MESSAGE_MERKLE_LEAF_DOMAIN, batchId, index, messageId), preimage);
        assertEq(abi.encodePacked(MESSAGE_MERKLE_LEAF_DOMAIN, batchId, index, messageId), preimage);
        assertEq(MessageMerkle.computeLeaf(batchId, index, messageId), expected);
        assertNotEq(expected, fixture.readBytes32(".encodingProbe.sha3LeafHash"));
        // Model a wrong-width implementation that truncates before encoding.
        uint256 reduced = index % (uint256(1) << 32);
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 narrowed = uint32(reduced);
        assertNotEq(keccak256(abi.encode(MESSAGE_MERKLE_LEAF_DOMAIN, batchId, narrowed, messageId)), expected);
        assertNotEq(keccak256(abi.encodePacked(MESSAGE_MERKLE_LEAF_DOMAIN, batchId, narrowed, messageId)), expected);
    }

    function testRealSealedSnapshot() public {
        string memory json = vm.envOr("MERKLE_SEALED_SNAPSHOT_JSON", string(""));
        if (bytes(json).length == 0) {
            // The real Indexer integration supplies this test's input in a separate invocation.
            vm.skip(true);
            return;
        }
        assertEq(json.readString(".status"), "SEALED");
        bytes32 batchId = json.readBytes32(".batchId");
        bytes32 root = json.readBytes32(".messageRoot");
        uint256 count = json.readUint(".leafCount");
        bytes32[] memory leaves = json.readBytes32Array(".leaves");
        bytes32[] memory messageIds = json.readBytes32Array(".messageIds");
        assertGt(count, 0);
        assertEq(leaves.length, count);
        assertEq(messageIds.length, count);
        assertEq(vm.parseJsonArrayLength(json, ".proofs"), count);
        for (uint256 index = 0; index < count; index++) {
            // forge-lint: disable-next-line(calls-loop)
            MessageMerkle.Proof memory proof = _readProof(json, string.concat(".proofs[", vm.toString(index), "]"));
            assertEq(proof.index, index);
            assertEq(proof.messageId, messageIds[index]);
            assertEq(MessageMerkle.computeLeaf(batchId, index, messageIds[index]), leaves[index]);
            assertTrue(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
            assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, _flip(root), proof));
            proof.leafCount = count + 1;
            assertFalse(MessageMerkle.verifyProof(batchId, messageIds[index], count, root, proof));
        }
    }

    function _readProof(string memory json, string memory base) internal pure returns (MessageMerkle.Proof memory) {
        return MessageMerkle.Proof({
            batchId: json.readBytes32(string.concat(base, ".batchId")),
            messageId: json.readBytes32(string.concat(base, ".messageId")),
            index: json.readUint(string.concat(base, ".index")),
            leafCount: json.readUint(string.concat(base, ".leafCount")),
            siblings: json.readBytes32Array(string.concat(base, ".siblings"))
        });
    }

    function _vectorPath(uint256 index) internal pure returns (string memory) {
        // forge-lint: disable-next-line(calls-loop)
        return string.concat(".vectors[", vm.toString(index), "]");
    }

    function _decimal(string memory json, string memory key) internal pure returns (uint256) {
        // forge-lint: disable-next-line(calls-loop)
        return vm.parseUint(json.readString(key));
    }

    function _flip(bytes32 value) internal pure returns (bytes32) {
        return value ^ bytes32(uint256(1));
    }
}
