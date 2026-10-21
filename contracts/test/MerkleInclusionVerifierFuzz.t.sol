// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolTestFixtures} from "./helpers/ProtocolTestFixtures.sol";
import {MessageMerkle} from "../src/MessageMerkle.sol";
import {MerkleInclusionVerifier} from "../src/MerkleInclusionVerifier.sol";

contract MerkleInclusionVerifierFuzzTest is ProtocolTestFixtures {
    uint256 private constant MAX_FUZZ_MEMBERS = 16;

    struct Evidence {
        MerkleInclusionVerifier.BatchContext context;
        bytes32 root;
        bytes32[] ids;
        MessageMerkle.Proof proof;
    }

    MerkleInclusionVerifier private verifier;

    function setUp() public {
        verifier = new MerkleInclusionVerifier();
    }

    function testFuzzGeneratedMembershipAtEverySampledPosition(bytes32 entropy, uint256 sizeSeed, uint256 indexSeed)
        public view
    {
        uint256 count = bound(sizeSeed, 1, MAX_FUZZ_MEMBERS);
        Evidence memory e = _generated(entropy, count, bound(indexSeed, 0, count - 1));
        assertTrue(_verify(e));
    }

    function testFuzzNonzeroSiblingMutation(bytes32 entropy, uint256 sizeSeed, uint256 indexSeed, uint256 levelSeed, bytes32 mask)
        public view
    {
        uint256 count = bound(sizeSeed, 2, MAX_FUZZ_MEMBERS);
        Evidence memory e = _generated(entropy, count, bound(indexSeed, 0, count - 1));
        assertTrue(_verify(e));
        uint256 level = bound(levelSeed, 0, e.proof.siblings.length - 1);
        e.proof.siblings[level] ^= mask == bytes32(0) ? bytes32(uint256(1)) : mask;
        bytes memory reason = _rejection(e, e.proof.index);
        bytes4 selector = _revertSelector(reason);
        assertTrue(selector == MessageMerkle.MerkleRootMismatch.selector
            || selector == MessageMerkle.InvalidOddSibling.selector, "sibling mutation rejected at unrelated boundary");
    }

    function testFuzzPositionCannotReuseOriginalPath(bytes32 entropy, uint256 sizeSeed, uint256 indexSeed, uint256 changedSeed)
        public view
    {
        uint256 count = bound(sizeSeed, 2, MAX_FUZZ_MEMBERS);
        uint256 index = bound(indexSeed, 0, count - 1);
        Evidence memory e = _generated(entropy, count, index);
        assertTrue(_verify(e));
        e.proof.index = (index + bound(changedSeed, 1, count - 1)) % count;
        assertEq(_rejection(e, index), abi.encodeWithSelector(
            MerkleInclusionVerifier.ProofIndexMismatch.selector, index, e.proof.index));
    }

    function testFuzzPathTruncationAndExtension(bytes32 entropy, uint256 sizeSeed, uint256 indexSeed, uint256 lengthSeed)
        public view
    {
        uint256 count = bound(sizeSeed, 2, MAX_FUZZ_MEMBERS);
        Evidence memory e = _generated(entropy, count, bound(indexSeed, 0, count - 1));
        assertTrue(_verify(e));
        bytes32[] memory original = e.proof.siblings;
        uint256 shorter = bound(lengthSeed, 0, original.length - 1);
        e.proof.siblings = _resizePath(original, shorter, entropy);
        assertEq(_rejection(e, e.proof.index), abi.encodeWithSelector(
            MessageMerkle.InvalidProofLength.selector, original.length, shorter));
        uint256 longer = original.length + bound(lengthSeed, 1, 2);
        e.proof.siblings = _resizePath(original, longer, entropy);
        assertEq(_rejection(e, e.proof.index), abi.encodeWithSelector(
            MessageMerkle.InvalidProofLength.selector, original.length, longer));
    }

    function testFuzzOddLastLeafRequiresExactDuplicatedSibling(bytes32 entropy, uint256 sizeSeed, bytes32 mask)
        public view
    {
        uint256 count = bound(sizeSeed, 1, 7) * 2 + 1;
        Evidence memory e = _generated(entropy, count, count - 1);
        assertTrue(_verify(e));
        bytes32 expected = e.proof.siblings[0];
        e.proof.siblings[0] ^= mask == bytes32(0) ? bytes32(uint256(1)) : mask;
        assertEq(_rejection(e, e.proof.index), abi.encodeWithSelector(
            MessageMerkle.InvalidOddSibling.selector, uint256(0), expected, e.proof.siblings[0]));
    }

    // IDs are constructively unique; no sorting, fixture repair or rejected fuzz inputs hide mutations.
    // forge-lint: disable-next-item(calls-loop)
    function _generated(bytes32 entropy, uint256 count, uint256 index) private view returns (Evidence memory e) {
        e.ids = new bytes32[](count);
        for (uint256 position = 0; position < count; position++) e.ids[position] = entropy ^ bytes32(position);
        e.context.version = 1;
        e.context.sourceDomain = 10011;
        e.context.sourceGateway = address(0x1001);
        e.context.epoch = uint256(entropy);
        e.context.batchId = verifier.computeBatchId(1, e.context.sourceDomain, e.context.sourceGateway, e.context.epoch, e.ids);
        bytes32[] memory siblings;
        (e.root, siblings) = _merklePath(e.context.batchId, e.ids, index);
        e.proof = MessageMerkle.Proof({batchId: e.context.batchId, messageId: e.ids[index],
            index: index, leafCount: count, siblings: siblings});
    }

    function _verify(Evidence memory e) private view returns (bool) {
        return verifier.verifyInclusion(e.context, e.root, e.proof.messageId, e.proof.index, e.ids, e.proof);
    }

    function _rejection(Evidence memory e, uint256 expectedIndex) private view returns (bytes memory reason) {
        // Only the actual verifier call is caught; harness arithmetic/array failures cannot pass this assertion.
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory returned) = address(verifier).staticcall(abi.encodeCall(verifier.verifyInclusion,
            (e.context, e.root, e.proof.messageId, expectedIndex, e.ids, e.proof)));
        assertFalse(success, "mutated Merkle evidence accepted");
        return returned;
    }

    function _resizePath(bytes32[] memory original, uint256 length, bytes32 extra)
        private pure returns (bytes32[] memory path)
    {
        path = new bytes32[](length);
        for (uint256 index = 0; index < length; index++) path[index] = index < original.length ? original[index] : extra;
    }
}
