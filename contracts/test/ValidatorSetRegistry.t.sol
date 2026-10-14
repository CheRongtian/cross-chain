// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ValidatorSetRegistry} from "../src/ValidatorSetRegistry.sol";
import {IValidatorSetRegistry} from "../src/interfaces/IValidatorSetRegistry.sol";

/// @dev Bounded loops deliberately call the local registry/VM to cover historical input cases.
contract ValidatorSetRegistryTest is Test {
    uint256 internal constant COMMITTEE_SIZE = 4;
    uint256 internal constant INCOMPLETE_COMMITTEE_SIZE = COMMITTEE_SIZE - 1;
    uint256 internal constant LAST_VALIDATOR_INDEX = COMMITTEE_SIZE - 1;
    uint256 internal constant DIRECTORY_SIZE = 5;
    uint256 internal constant FIRST_EPOCH = 7;
    uint256 internal constant SECOND_EPOCH = FIRST_EPOCH + 1;
    uint256 internal constant PRECEDING_EPOCH = FIRST_EPOCH - 1;
    uint256 internal constant NEXT_EPOCH = SECOND_EPOCH + 1;
    uint8 internal constant EXPECTED_QUORUM = 3;
    uint256 internal constant UNKNOWN_EPOCH_COUNT = 4;
    uint256 internal constant MUTATION_SELECTOR_COUNT = 3;
    uint256 internal constant EVENT_TOPIC_COUNT = 3;
    uint256 internal constant BATCH_EPOCH = 23;
    uint256 internal constant PERMUTATION_COUNT = 24;
    address internal constant UNKNOWN_CALLER = address(0xBAD);
    uint256 internal constant LARGE_EPOCH = (1 << 200) + FIRST_EPOCH;

    ValidatorSetRegistry internal registry;
    string internal goldenJson;
    address[COMMITTEE_SIZE] internal original;
    address[COMMITTEE_SIZE] internal rotated;
    address[COMMITTEE_SIZE] internal canonicalOriginal;
    address[COMMITTEE_SIZE] internal canonicalRotated;
    bytes32 internal originalDigest;
    bytes32 internal rotatedDigest;

    function setUp() public {
        registry = new ValidatorSetRegistry(address(this));
        // Reads only the shared public fixture under the existing Foundry read permission.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        goldenJson = vm.readFile(string.concat(vm.projectRoot(), "/../test-vectors/validator-sets.json"));
        original = _addresses(".history[0].validators");
        rotated = _addresses(".history[1].validators");
        canonicalOriginal = _addresses(".history[0].canonicalValidators");
        canonicalRotated = _addresses(".history[1].canonicalValidators");
        originalDigest = vm.parseJsonBytes32(goldenJson, ".history[0].committeeDigest");
        rotatedDigest = vm.parseJsonBytes32(goldenJson, ".history[1].committeeDigest");
    }

    function testConstructorAndEmptyHistory() public {
        assertEq(registry.registryAdmin(), address(this));
        assertFalse(registry.hasValidatorHistory());
        assertFalse(registry.hasValidatorSet(0));
        vm.expectRevert(ValidatorSetRegistry.ValidatorHistoryNotInitialized.selector);
        // The assertion checks the expected revert, so there is no return value to consume.
        // forge-lint: disable-next-line(unused-return)
        registry.initialValidatorEpoch();
        vm.expectRevert(ValidatorSetRegistry.ValidatorHistoryNotInitialized.selector);
        // The assertion checks the expected revert, so there is no return value to consume.
        // forge-lint: disable-next-line(unused-return)
        registry.latestValidatorEpoch();

        vm.expectRevert(ValidatorSetRegistry.InvalidRegistryAdmin.selector);
        new ValidatorSetRegistry(address(0));
    }

    function testSharedGoldenCommitteesPreserveExactHistoricalAuthority() public {
        uint256 firstEpoch = vm.parseUint(vm.parseJsonString(goldenJson, ".history[0].validatorEpoch"));
        uint256 secondEpoch = vm.parseUint(vm.parseJsonString(goldenJson, ".history[1].validatorEpoch"));
        assertEq(firstEpoch, FIRST_EPOCH);
        assertEq(secondEpoch, SECOND_EPOCH);
        assertEq(vm.parseJsonUint(goldenJson, ".quorum"), EXPECTED_QUORUM);
        assertEq(registry.COMMITTEE_VERSION(), vm.parseJsonUint(goldenJson, ".committeeVersion"));

        registry.registerValidatorSet(firstEpoch, original);
        _assertSet(firstEpoch, canonicalOriginal, originalDigest);
        assertTrue(registry.hasValidatorHistory());
        assertEq(registry.initialValidatorEpoch(), firstEpoch);
        assertEq(registry.latestValidatorEpoch(), firstEpoch);

        registry.registerValidatorSet(secondEpoch, rotated);
        _assertSet(secondEpoch, canonicalRotated, rotatedDigest);
        _assertSet(firstEpoch, canonicalOriginal, originalDigest);
        assertEq(registry.initialValidatorEpoch(), firstEpoch);
        assertEq(registry.latestValidatorEpoch(), secondEpoch);
        assertNotEq(originalDigest, rotatedDigest);
    }

    function testFiveIdentityDirectoryHasOnlyFourMembersPerEpoch() public {
        address[] memory directory = vm.parseJsonAddressArray(goldenJson, ".directory");
        assertEq(directory.length, DIRECTORY_SIZE);
        registry.registerValidatorSet(FIRST_EPOCH, original);
        registry.registerValidatorSet(SECOND_EPOCH, rotated);
        for (uint256 index = 0; index < directory.length; ++index) {
            // forge-lint: disable-next-line(calls-loop)
            assertEq(registry.isValidator(FIRST_EPOCH, directory[index]), index != COMMITTEE_SIZE);
            // forge-lint: disable-next-line(calls-loop)
            assertEq(registry.isValidator(SECOND_EPOCH, directory[index]), index != 0);
        }
        assertFalse(registry.isValidator(FIRST_EPOCH, address(0)));
        assertFalse(registry.isValidator(SECOND_EPOCH, UNKNOWN_CALLER));
    }

    function testUnknownEpochHasNoInitialNearestOrLatestFallback() public {
        registry.registerValidatorSet(FIRST_EPOCH, original);
        registry.registerValidatorSet(SECOND_EPOCH, rotated);
        uint256[UNKNOWN_EPOCH_COUNT] memory unknown = [uint256(0), PRECEDING_EPOCH, NEXT_EPOCH, type(uint256).max];
        for (uint256 index = 0; index < unknown.length; ++index) {
            // forge-lint: disable-next-line(calls-loop)
            assertFalse(registry.hasValidatorSet(unknown[index]));
            bytes memory expected = abi.encodeWithSelector(
                ValidatorSetRegistry.UnknownValidatorEpoch.selector, unknown[index]
            );
            // forge-lint: disable-next-line(calls-loop)
            vm.expectRevert(expected);
            // The VM checks the exact revert; this local test intentionally discards the result.
            // forge-lint: disable-next-line(calls-loop, unused-return)
            registry.getValidatorSet(unknown[index]);
            // forge-lint: disable-next-line(calls-loop)
            vm.expectRevert(expected);
            // The VM checks the exact revert; this local test intentionally discards the result.
            // forge-lint: disable-next-line(calls-loop, unused-return)
            registry.isValidator(unknown[index], original[0]);
        }
    }

    function testEpochZeroIsValidAndRemainsTheInitialAnchor() public {
        registry.registerValidatorSet(0, original);
        registry.registerValidatorSet(1, rotated);
        assertEq(registry.initialValidatorEpoch(), 0);
        assertEq(registry.latestValidatorEpoch(), 1);
        _assertSet(0, canonicalOriginal, originalDigest);
        _assertSet(1, canonicalRotated, rotatedDigest);
    }

    function testRejectsDuplicateEpochAndHistoricalRewrite() public {
        registry.registerValidatorSet(FIRST_EPOCH, original);
        registry.registerValidatorSet(SECOND_EPOCH, rotated);
        for (uint256 epoch = FIRST_EPOCH; epoch <= SECOND_EPOCH; ++epoch) {
            bytes memory expected = abi.encodeWithSelector(
                ValidatorSetRegistry.ValidatorEpochAlreadyRegistered.selector, epoch
            );
            // forge-lint: disable-next-line(calls-loop)
            vm.expectRevert(expected);
            // forge-lint: disable-next-line(calls-loop)
            registry.registerValidatorSet(epoch, original);
            // forge-lint: disable-next-line(calls-loop)
            vm.expectRevert(expected);
            // forge-lint: disable-next-line(calls-loop)
            registry.registerValidatorSet(epoch, rotated);
        }
        _assertSet(FIRST_EPOCH, canonicalOriginal, originalDigest);
        _assertSet(SECOND_EPOCH, canonicalRotated, rotatedDigest);
        assertEq(registry.latestValidatorEpoch(), SECOND_EPOCH);
    }

    function testRejectsGapAndRetroactiveEpochWithoutChangingHistory() public {
        registry.registerValidatorSet(FIRST_EPOCH, original);
        vm.expectRevert(
            abi.encodeWithSelector(ValidatorSetRegistry.NoncontiguousValidatorEpoch.selector, SECOND_EPOCH, NEXT_EPOCH)
        );
        registry.registerValidatorSet(NEXT_EPOCH, rotated);
        registry.registerValidatorSet(SECOND_EPOCH, rotated);
        vm.expectRevert(
            abi.encodeWithSelector(ValidatorSetRegistry.NoncontiguousValidatorEpoch.selector, NEXT_EPOCH, PRECEDING_EPOCH)
        );
        registry.registerValidatorSet(PRECEDING_EPOCH, original);
        assertFalse(registry.hasValidatorSet(PRECEDING_EPOCH));
        assertFalse(registry.hasValidatorSet(NEXT_EPOCH));
        _assertSet(FIRST_EPOCH, canonicalOriginal, originalDigest);
        _assertSet(SECOND_EPOCH, canonicalRotated, rotatedDigest);
    }

    function testRejectsZeroInEveryValidatorSlot() public {
        for (uint256 index = 0; index < COMMITTEE_SIZE; ++index) {
            address[COMMITTEE_SIZE] memory invalid = original;
            invalid[index] = address(0);
            // forge-lint: disable-next-line(calls-loop)
            vm.expectRevert(ValidatorSetRegistry.ZeroValidator.selector);
            // forge-lint: disable-next-line(calls-loop)
            registry.registerValidatorSet(FIRST_EPOCH, invalid);
            // forge-lint: disable-next-line(calls-loop)
            assertFalse(registry.hasValidatorHistory());
        }
        registry.registerValidatorSet(FIRST_EPOCH, original);
        address[COMMITTEE_SIZE] memory missingMember = rotated;
        missingMember[LAST_VALIDATOR_INDEX] = address(0);
        vm.expectRevert(ValidatorSetRegistry.ZeroValidator.selector);
        registry.registerValidatorSet(SECOND_EPOCH, missingMember);
        assertEq(registry.latestValidatorEpoch(), FIRST_EPOCH);
        assertFalse(registry.hasValidatorSet(SECOND_EPOCH));
    }

    function testRejectsDuplicateIdentityInEveryPairOfSlots() public {
        for (uint256 first = 0; first < COMMITTEE_SIZE; ++first) {
            for (uint256 second = first + 1; second < COMMITTEE_SIZE; ++second) {
                address[COMMITTEE_SIZE] memory invalid = original;
                invalid[second] = invalid[first];
                bytes memory expected = abi.encodeWithSelector(
                    ValidatorSetRegistry.DuplicateValidator.selector, invalid[first]
                );
                // forge-lint: disable-next-line(calls-loop)
                vm.expectRevert(expected);
                // forge-lint: disable-next-line(calls-loop)
                registry.registerValidatorSet(FIRST_EPOCH, invalid);
            }
        }
        assertFalse(registry.hasValidatorHistory());
    }

    function testUnauthorizedCallerCannotInitializeOrAppendHistory() public {
        vm.prank(UNKNOWN_CALLER);
        vm.expectRevert(ValidatorSetRegistry.UnauthorizedRegistryAdmin.selector);
        registry.registerValidatorSet(FIRST_EPOCH, original);
        assertFalse(registry.hasValidatorHistory());
        registry.registerValidatorSet(FIRST_EPOCH, original);
        vm.prank(UNKNOWN_CALLER);
        vm.expectRevert(ValidatorSetRegistry.UnauthorizedRegistryAdmin.selector);
        registry.registerValidatorSet(SECOND_EPOCH, rotated);
        assertFalse(registry.hasValidatorSet(SECOND_EPOCH));
        _assertSet(FIRST_EPOCH, canonicalOriginal, originalDigest);
    }

    function testAll24PermutationsHaveOneStoredOrderingAndFrozenDigest() public {
        uint256 epoch = 0;
        for (uint256 a = 0; a < COMMITTEE_SIZE; ++a) {
            for (uint256 b = 0; b < COMMITTEE_SIZE; ++b) {
                if (b == a) continue;
                for (uint256 c = 0; c < COMMITTEE_SIZE; ++c) {
                    if (c == a || c == b) continue;
                    for (uint256 d = 0; d < COMMITTEE_SIZE; ++d) {
                        if (d == a || d == b || d == c) continue;
                        address[COMMITTEE_SIZE] memory permutation = [original[a], original[b], original[c], original[d]];
                        // forge-lint: disable-next-line(calls-loop)
                        registry.registerValidatorSet(epoch, permutation);
                        _assertSet(epoch, canonicalOriginal, originalDigest);
                        ++epoch;
                    }
                }
            }
        }
        assertEq(epoch, PERMUTATION_COUNT);
        assertEq(registry.latestValidatorEpoch(), PERMUTATION_COUNT - 1);
        _assertSet(0, canonicalOriginal, originalDigest);
    }

    function testSameCommitteeAtDifferentEpochsRetainsOriginalDigestFormat() public {
        registry.registerValidatorSet(FIRST_EPOCH, original);
        registry.registerValidatorSet(SECOND_EPOCH, original);
        _assertSet(FIRST_EPOCH, canonicalOriginal, originalDigest);
        _assertSet(SECOND_EPOCH, canonicalOriginal, originalDigest);
    }

    function testEveryMemberMutationChangesTheDigest() public {
        address replacement = rotated[LAST_VALIDATOR_INDEX];
        for (uint256 index = 0; index < COMMITTEE_SIZE; ++index) {
            address[COMMITTEE_SIZE] memory changed = original;
            changed[index] = replacement;
            // forge-lint: disable-next-line(calls-loop)
            registry.registerValidatorSet(index, changed);
            // forge-lint: disable-next-line(calls-loop)
            (address[COMMITTEE_SIZE] memory validators, uint8 quorum, bytes32 digest) = registry.getValidatorSet(index);
            _assertCanonicalMembers(validators, changed);
            assertEq(quorum, EXPECTED_QUORUM);
            assertNotEq(digest, originalDigest);
        }
    }

    function testExactLargeEpochAndIndependentBatchEpoch() public {
        registry.registerValidatorSet(LARGE_EPOCH, original);
        registry.registerValidatorSet(LARGE_EPOCH + 1, rotated);
        assertEq(registry.initialValidatorEpoch(), LARGE_EPOCH);
        assertEq(registry.latestValidatorEpoch(), LARGE_EPOCH + 1);
        _assertSet(LARGE_EPOCH, canonicalOriginal, originalDigest);
        _assertSet(LARGE_EPOCH + 1, canonicalRotated, rotatedDigest);
        // A batch sequence value alone cannot select a historical validator epoch.
        vm.expectRevert(abi.encodeWithSelector(ValidatorSetRegistry.UnknownValidatorEpoch.selector, BATCH_EPOCH));
        // Unknown batch/validator-epoch lookup is asserted to revert.
        // forge-lint: disable-next-line(unused-return)
        registry.getValidatorSet(BATCH_EPOCH);
    }

    function testMaximumEpochCannotWrapAround() public {
        registry.registerValidatorSet(type(uint256).max, original);
        _assertSet(type(uint256).max, canonicalOriginal, originalDigest);
        vm.expectRevert(ValidatorSetRegistry.ValidatorEpochOverflow.selector);
        registry.registerValidatorSet(0, rotated);
        assertFalse(registry.hasValidatorSet(0));
        assertEq(registry.latestValidatorEpoch(), type(uint256).max);
    }

    function testFuzzAnyFirstEpochPreservesExactAuthority(uint256 epoch) public {
        registry.registerValidatorSet(epoch, original);
        _assertSet(epoch, canonicalOriginal, originalDigest);
        assertEq(registry.initialValidatorEpoch(), epoch);
        assertEq(registry.latestValidatorEpoch(), epoch);
    }

    function testEventsContainCanonicalPublicHistory() public {
        vm.recordLogs();
        registry.registerValidatorSet(FIRST_EPOCH, original);
        registry.registerValidatorSet(SECOND_EPOCH, rotated);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        _assertEvent(logs[0], FIRST_EPOCH, canonicalOriginal, originalDigest);
        _assertEvent(logs[1], SECOND_EPOCH, canonicalRotated, rotatedDigest);
    }

    function testHistoricalMutationSelectorsHaveNoProductionPath() public {
        registry.registerValidatorSet(FIRST_EPOCH, original);
        bytes[MUTATION_SELECTOR_COUNT] memory calls = [
            abi.encodeWithSignature("updateValidatorSet(uint256,address[4])", FIRST_EPOCH, rotated),
            abi.encodeWithSignature("removeValidatorSet(uint256)", FIRST_EPOCH),
            abi.encodeWithSignature("replaceValidator(uint256,address,address)", FIRST_EPOCH, original[0], rotated[LAST_VALIDATOR_INDEX])
        ];
        for (uint256 index = 0; index < calls.length; ++index) {
            // Raw calls are needed to prove that these removed selectors have no ABI entry.
            // forge-lint: disable-next-line(calls-loop, low-level-calls)
            (bool success, bytes memory result) = address(registry).call(calls[index]);
            assertFalse(success);
            assertEq(result.length, 0);
        }
        _assertSet(FIRST_EPOCH, canonicalOriginal, originalDigest);
    }

    function testThreeMemberCalldataCannotInitializeHistory() public {
        address[INCOMPLETE_COMMITTEE_SIZE] memory incomplete = [original[0], original[1], original[2]];
        bytes memory malformed = abi.encodeWithSignature(
            "registerValidatorSet(uint256,address[4])", FIRST_EPOCH, incomplete
        );
        // Raw calldata omits one member; the fixed-array decoder rejects it before registration.
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory result) = address(registry).call(malformed);
        assertFalse(success);
        assertEq(result.length, 0);
        assertFalse(registry.hasValidatorHistory());
        assertFalse(registry.hasValidatorSet(FIRST_EPOCH));
    }

    function _addresses(string memory path) private view returns (address[COMMITTEE_SIZE] memory fixedAddresses) {
        address[] memory addresses = vm.parseJsonAddressArray(goldenJson, path);
        assertEq(addresses.length, COMMITTEE_SIZE);
        for (uint256 index = 0; index < COMMITTEE_SIZE; ++index) fixedAddresses[index] = addresses[index];
    }

    function _assertSet(uint256 epoch, address[COMMITTEE_SIZE] memory expectedValidators, bytes32 expectedDigest) private view {
        IValidatorSetRegistry reader = IValidatorSetRegistry(address(registry));
        // This helper is intentionally reused by bounded local-EVM permutation tests.
        // forge-lint: disable-next-line(calls-loop)
        assertTrue(reader.hasValidatorSet(epoch));
        // forge-lint: disable-next-line(calls-loop)
        (address[COMMITTEE_SIZE] memory validators, uint8 quorum, bytes32 digest) = reader.getValidatorSet(epoch);
        for (uint256 index = 0; index < COMMITTEE_SIZE; ++index) assertEq(validators[index], expectedValidators[index]);
        assertEq(quorum, EXPECTED_QUORUM);
        assertEq(digest, expectedDigest);
    }

    function _assertCanonicalMembers(
        address[COMMITTEE_SIZE] memory validators,
        address[COMMITTEE_SIZE] memory supplied
    ) private pure {
        for (uint256 index = 0; index < COMMITTEE_SIZE; ++index) {
            assertTrue(validators[index] != address(0));
            if (index > 0) assertLt(uint160(validators[index - 1]), uint160(validators[index]));
            bool found = false;
            for (uint256 candidate = 0; candidate < COMMITTEE_SIZE; ++candidate) {
                if (validators[index] == supplied[candidate]) found = true;
            }
            assertTrue(found);
        }
    }

    function _assertEvent(Vm.Log memory entry, uint256 epoch, address[COMMITTEE_SIZE] memory validators, bytes32 digest)
        private
        view
    {
        assertEq(entry.emitter, address(registry));
        assertEq(entry.topics.length, EVENT_TOPIC_COUNT);
        assertEq(
            entry.topics[0],
            keccak256("ValidatorSetRegistered(uint256,bytes32,uint8,address,address,address,address)")
        );
        assertEq(entry.topics[1], bytes32(epoch));
        assertEq(entry.topics[2], digest);
        assertEq(entry.data, abi.encode(EXPECTED_QUORUM, validators[0], validators[1], validators[2], validators[LAST_VALIDATOR_INDEX]));
    }
}
