// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {MerkleInclusionVerifier} from "../src/MerkleInclusionVerifier.sol";
import {MessageMerkle} from "../src/MessageMerkle.sol";
import {MessageBatchCodec} from "../src/libraries/MessageBatchCodec.sol";

contract MerkleInclusionVerifierTest is Test {
    using stdJson for string;

    struct Evidence {
        MerkleInclusionVerifier.BatchContext context;
        bytes32 root;
        bytes32 messageId;
        uint256 index;
        bytes32[] ids;
        MessageMerkle.Proof proof;
    }

    bytes32 private constant BATCH_TYPEHASH =
        keccak256("MessageBatch(uint8 version,uint256 sourceDomain,address sourceGateway,uint256 epoch,bytes32[] messageIds)");
    uint256 private constant GOLDEN_VECTOR_COUNT = 5;
    uint256 private constant THREE_LEAF_COUNT = 3;
    uint256 private constant FOUR_LEAF_COUNT = 4;
    uint256 private constant THREE_LEAF_VECTOR_INDEX = THREE_LEAF_COUNT - 1;
    uint256 private constant FIVE_LEAF_VECTOR_INDEX = GOLDEN_VECTOR_COUNT - 1;
    uint256 private constant THREE_LEAF_PROOF_DEPTH = 2;
    uint256 private constant BATCH_MUTATION_COUNT = 7;
    uint256 private constant BATCH_ID_MUTATION = 3;
    uint256 private constant MEMBERSHIP_ORDER_MUTATION = 4;
    uint256 private constant MEMBERSHIP_VALUE_MUTATION = 5;
    uint256 private constant POSITION_REJECTION_CASE_COUNT = 4;
    // Test-only stress input; this introduces no production batch-size limit.
    uint256 private constant LARGE_BATCH_COUNT = 257;
    MerkleInclusionVerifier private verifier;
    string private fixture;

    function setUp() public {
        verifier = new MerkleInclusionVerifier();
        // Only the existing fixed public fixture is read, within configured fs_permissions.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        fixture = vm.readFile(string.concat(vm.projectRoot(), "/../test-vectors/merkle-golden-vectors.json"));
    }

    // Calls target the local stateless verifier and frozen VM fixtures, for every bounded golden position.
    // forge-lint: disable-next-item(calls-loop)
    function testEveryGoldenPositionWithCanonicalMembership() public view {
        for (uint256 vectorIndex = 0; vectorIndex < GOLDEN_VECTOR_COUNT; vectorIndex++) {
            for (uint256 index = 0; index <= vectorIndex; index++) {
                Evidence memory e = _golden(vectorIndex, index);
                assertTrue(_verify(e));
                assertEq(_batchId(e), e.context.batchId);
            }
        }
    }

    function testEmptyDuplicateAndUnsupportedMembershipRejectExactly() public {
        Evidence memory e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        e.ids = new bytes32[](0);
        _reject(e, abi.encodeWithSelector(MessageBatchCodec.EmptyMessageBatch.selector));
        e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        e.ids[2] = e.ids[0];
        _reject(e, abi.encodeWithSelector(MessageBatchCodec.DuplicateMessageId.selector, e.ids[0]));
        e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        e.context.version = 2;
        _reject(e, abi.encodeWithSelector(MessageBatchCodec.UnsupportedBatchVersion.selector, uint8(2)));
    }

    // Each mutation is independently compared to the canonical ABI commitment, not a fabricated expected ID.
    // forge-lint: disable-next-item(calls-loop)
    function testEveryBatchFieldAndOrderedMembershipIsBound() public {
        for (uint256 field = 0; field < BATCH_MUTATION_COUNT; field++) {
            Evidence memory e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
            if (field == 0) e.context.sourceDomain++;
            else if (field == 1) e.context.sourceGateway = address(0xBEEF);
            else if (field == 2) e.context.epoch++;
            else if (field == BATCH_ID_MUTATION) e.context.batchId = _flip(e.context.batchId);
            else if (field == MEMBERSHIP_ORDER_MUTATION) (e.ids[1], e.ids[2]) = (e.ids[2], e.ids[1]);
            else if (field == MEMBERSHIP_VALUE_MUTATION) e.ids[2] = _flip(e.ids[2]);
            else {
                bytes32[] memory extended = new bytes32[](FOUR_LEAF_COUNT);
                for (uint256 index = 0; index < e.ids.length; index++) extended[index] = e.ids[index];
                extended[e.ids.length] = _flip(e.ids[2]);
                e.ids = extended;
            }
            _reject(
                e,
                abi.encodeWithSelector(MerkleInclusionVerifier.BatchIdMismatch.selector, e.context.batchId, _batchId(e))
            );
        }
    }

    // VM expectations and verifier calls intentionally cover exact full-width positional mismatches.
    // forge-lint: disable-next-item(calls-loop)
    function testUint256PositionRejectsBeforeArrayAccessOrNarrowing() public {
        uint256[POSITION_REJECTION_CASE_COUNT] memory positions =
            [THREE_LEAF_COUNT, uint256(1) << 32, (uint256(1) << 53) + 1, type(uint256).max];
        for (uint256 index = 0; index < positions.length; index++) {
            Evidence memory sample = _golden(THREE_LEAF_VECTOR_INDEX, 0);
            sample.index = positions[index];
            _reject(
                sample,
                abi.encodeWithSelector(
                    MerkleInclusionVerifier.MessageIndexOutOfBounds.selector, sample.index, THREE_LEAF_COUNT
                )
            );
        }
        Evidence memory e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        e.index = 1;
        _reject(
            e,
            abi.encodeWithSelector(
                MerkleInclusionVerifier.MemberMessageIdMismatch.selector, e.index, e.messageId, e.ids[1]
            )
        );
        e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        e.proof.index = type(uint256).max;
        _reject(e, abi.encodeWithSelector(MerkleInclusionVerifier.ProofIndexMismatch.selector, e.index, e.proof.index));
    }

    function testProofMetadataCannotReplaceTrustedMembership() public {
        Evidence memory e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        e.proof.batchId = _flip(e.proof.batchId);
        _reject(e, abi.encodeWithSelector(MessageMerkle.ProofBatchIdMismatch.selector, e.context.batchId, e.proof.batchId));
        e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        e.proof.messageId = _flip(e.proof.messageId);
        _reject(e, abi.encodeWithSelector(MessageMerkle.ProofMessageIdMismatch.selector, e.messageId, e.proof.messageId));
        e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        e.messageId = _flip(e.messageId);
        _reject(
            e,
            abi.encodeWithSelector(
                MerkleInclusionVerifier.MemberMessageIdMismatch.selector, e.index, e.messageId, e.ids[0]
            )
        );
        e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        // This exact path can fold under count 4; full membership still pins the count to 3.
        e.proof.leafCount = FOUR_LEAF_COUNT;
        assertTrue(MessageMerkle.verifyProof(e.context.batchId, e.messageId, FOUR_LEAF_COUNT, e.root, e.proof));
        _reject(e, abi.encodeWithSelector(MessageMerkle.ProofLeafCountMismatch.selector, THREE_LEAF_COUNT, FOUR_LEAF_COUNT));
        e.proof.leafCount = 0;
        _reject(e, abi.encodeWithSelector(MessageMerkle.ProofLeafCountMismatch.selector, THREE_LEAF_COUNT, uint256(0)));
    }

    function testWrongRootTamperedAndReorderedSiblingsRejectExactly() public {
        Evidence memory e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        bytes32 canonicalRoot = e.root;
        e.root = _flip(e.root);
        _reject(e, abi.encodeWithSelector(MessageMerkle.MerkleRootMismatch.selector, e.root, canonicalRoot));
        e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        e.proof.siblings[0] = _flip(e.proof.siblings[0]);
        _reject(e, abi.encodeWithSelector(MessageMerkle.MerkleRootMismatch.selector, e.root, _fold(e)));
        e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        (e.proof.siblings[0], e.proof.siblings[1]) = (e.proof.siblings[1], e.proof.siblings[0]);
        _reject(e, abi.encodeWithSelector(MessageMerkle.MerkleRootMismatch.selector, e.root, _fold(e)));
    }

    function testSingleLeafEmptyPathAndExactDepth() public {
        Evidence memory e = _golden(0, 0);
        assertTrue(_verify(e));
        assertEq(e.root, MessageMerkle.computeLeaf(e.context.batchId, 0, e.messageId));
        e.proof.siblings = new bytes32[](1);
        _reject(e, abi.encodeWithSelector(MessageMerkle.InvalidProofLength.selector, uint256(0), uint256(1)));
        e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        e.proof.siblings = new bytes32[](1);
        _reject(e, abi.encodeWithSelector(MessageMerkle.InvalidProofLength.selector, THREE_LEAF_PROOF_DEPTH, uint256(1)));
        e.proof.siblings = new bytes32[](THREE_LEAF_PROOF_DEPTH + 1);
        _reject(
            e,
            abi.encodeWithSelector(
                MessageMerkle.InvalidProofLength.selector, THREE_LEAF_PROOF_DEPTH, THREE_LEAF_PROOF_DEPTH + 1
            )
        );
    }

    // Each case targets an actual unpaired level and supplies its deliberately forged matching root.
    // forge-lint: disable-next-item(calls-loop)
    function testOddSiblingChecksEveryLevelEvenWithMatchingForgedRoot() public {
        for (
            uint256 vectorIndex = THREE_LEAF_VECTOR_INDEX;
            vectorIndex <= FIVE_LEAF_VECTOR_INDEX;
            vectorIndex += 2
        ) {
            uint256 oddLevels = vectorIndex == THREE_LEAF_VECTOR_INDEX ? 1 : 2;
            for (uint256 level = 0; level < oddLevels; level++) {
                Evidence memory e = _golden(vectorIndex, vectorIndex);
                bytes32 expectedSibling = e.proof.siblings[level];
                e.proof.siblings[level] = _flip(expectedSibling);
                e.root = _fold(e);
                _reject(
                    e,
                    abi.encodeWithSelector(
                        MessageMerkle.InvalidOddSibling.selector, level, expectedSibling, e.proof.siblings[level]
                    )
                );
            }
        }
    }

    function testValidInclusionDoesNotAuthenticateItsExpectedRoot() public view {
        Evidence memory e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        e.proof.siblings[0] = _flip(e.proof.siblings[0]);
        e.root = _fold(e);
        // A self-selected root can satisfy a path; QC authentication is the independent caller's responsibility.
        assertTrue(_verify(e));
    }

    function testMalformedAbiNodeFailsWithEmptyDecoderRevert() public view {
        Evidence memory e = _golden(THREE_LEAF_VECTOR_INDEX, 0);
        bytes memory encoded =
            abi.encodeCall(verifier.verifyInclusion, (e.context, e.root, e.messageId, e.index, e.ids, e.proof));
        bytes memory truncated = new bytes(encoded.length - 1);
        for (uint256 index = 0; index < truncated.length; index++) truncated[index] = encoded[index];
        // A typed ABI call cannot express this truncated node; assert the exact raw decoder failure instead.
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory returned) = address(verifier).staticcall(truncated);
        assertFalse(success);
        assertEq(returned, bytes(""));
    }

    // The scratch sort must neither alter the commitment order nor introduce an arbitrary batch cap.
    // forge-lint: disable-next-item(calls-loop)
    function testCanonicalBatchEncodingAndDuplicateScanBeyondSmallFixtures() public {
        Evidence memory e = _golden(0, 0);
        e.context.sourceDomain = type(uint256).max;
        e.context.sourceGateway = address(0);
        e.context.epoch = type(uint256).max;
        e.ids = new bytes32[](LARGE_BATCH_COUNT);
        for (uint256 index = 0; index < e.ids.length; index++) e.ids[index] = bytes32(e.ids.length - index);
        // Keep the independent canonical ABI comparison explicit in this test.
        // forge-lint: disable-next-line(asm-keccak256)
        bytes32 expected = keccak256(
            abi.encode(BATCH_TYPEHASH, uint8(1), e.context.sourceDomain, e.context.sourceGateway, e.context.epoch, e.ids)
        );
        assertEq(_batchId(e), expected);
        assertEq(e.ids[0], bytes32(LARGE_BATCH_COUNT));
        assertEq(e.ids[LARGE_BATCH_COUNT - 1], bytes32(uint256(1)));
        e.ids[LARGE_BATCH_COUNT - 1] = e.ids[0];
        vm.expectRevert(abi.encodeWithSelector(MessageBatchCodec.DuplicateMessageId.selector, e.ids[0]));
        // The VM consumes the precise failure; this invocation has no successful return value.
        // forge-lint: disable-next-line(unused-return)
        verifier.computeBatchId(1, e.context.sourceDomain, e.context.sourceGateway, e.context.epoch, e.ids);
    }

    // Golden loops deliberately use trusted VM helpers to read the fixed public fixture.
    // The exemption belongs here, where the external calls occur, including calls reached through helpers.
    // forge-lint: disable-next-item(calls-loop)
    function _golden(uint256 vectorIndex, uint256 index) private view returns (Evidence memory e) {
        string memory base = string.concat(".vectors[", vm.toString(vectorIndex), "]");
        e.context = MerkleInclusionVerifier.BatchContext({
            version: 1,
            sourceDomain: vm.parseUint(fixture.readString(string.concat(base, ".batch.sourceDomain"))),
            sourceGateway: fixture.readAddress(string.concat(base, ".batch.sourceGateway")),
            epoch: vm.parseUint(fixture.readString(string.concat(base, ".batch.epoch"))),
            batchId: fixture.readBytes32(string.concat(base, ".batch.batchId"))
        });
        e.root = fixture.readBytes32(string.concat(base, ".messageRoot"));
        e.ids = fixture.readBytes32Array(string.concat(base, ".batch.messageIds"));
        e.index = index;
        e.messageId = e.ids[index];
        string memory path = string.concat(base, ".proofs[", vm.toString(index), "]");
        e.proof = MessageMerkle.Proof({
            batchId: fixture.readBytes32(string.concat(path, ".batchId")),
            messageId: fixture.readBytes32(string.concat(path, ".messageId")),
            index: fixture.readUint(string.concat(path, ".index")),
            leafCount: fixture.readUint(string.concat(path, ".leafCount")),
            siblings: fixture.readBytes32Array(string.concat(path, ".siblings"))
        });
    }

    // Fixture loops call only the local stateless verifier deployed by setUp, with no application callbacks.
    // forge-lint: disable-next-item(calls-loop)
    function _verify(Evidence memory e) private view returns (bool) {
        return verifier.verifyInclusion(e.context, e.root, e.messageId, e.index, e.ids, e.proof);
    }

    // Each negative fixture iteration sets an exact VM revert expectation before its local verifier call.
    // forge-lint: disable-next-item(calls-loop)
    function _reject(Evidence memory e, bytes memory expectedError) private {
        vm.expectRevert(expectedError);
        // _verify delegates to the local verifier whose revert is asserted by the VM.
        // forge-lint: disable-next-line(unused-return)
        _verify(e);
    }

    // Repeated fixture cases compare canonical batch encoding through the same local pure verifier.
    // forge-lint: disable-next-item(calls-loop)
    function _batchId(Evidence memory e) private view returns (bytes32) {
        return verifier.computeBatchId(
            e.context.version, e.context.sourceDomain, e.context.sourceGateway, e.context.epoch, e.ids
        );
    }

    /// @dev Test-only forgery construction, deliberately omitting the production odd-sibling constraint.
    function _fold(Evidence memory e) private pure returns (bytes32 node) {
        node = MessageMerkle.computeLeaf(e.context.batchId, e.index, e.messageId);
        uint256 position = e.index;
        for (uint256 level = 0; level < e.proof.siblings.length; level++) {
            node = position % 2 == 0
                ? MessageMerkle.hashNode(node, e.proof.siblings[level])
                : MessageMerkle.hashNode(e.proof.siblings[level], node);
            position /= 2;
        }
    }

    function _flip(bytes32 value) private pure returns (bytes32) {
        return value ^ bytes32(uint256(1));
    }
}
