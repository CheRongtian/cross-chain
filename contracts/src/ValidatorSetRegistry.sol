// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IValidatorSetRegistry} from "./interfaces/IValidatorSetRegistry.sol";

/// @notice Append-only historical validator authority with a fixed three-of-four quorum.
contract ValidatorSetRegistry is IValidatorSetRegistry {
    bytes32 public constant COMMITTEE_TYPEHASH =
        keccak256("PBFTStaticCommittee(uint8 protocolVersion,address[4] validators)");
    uint256 private constant COMMITTEE_SIZE = 4;
    uint8 public constant COMMITTEE_VERSION = 1;
    uint8 public constant QUORUM = 3;

    // Lower camel case preserves the existing registry administrator getter convention.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable registryAdmin;

    struct ValidatorSet {
        address[COMMITTEE_SIZE] validators;
        uint8 quorum;
        bytes32 committeeDigest;
        bool exists;
    }

    mapping(uint256 validatorEpoch => ValidatorSet validatorSet) private validatorSets;
    bool public override hasValidatorHistory;
    uint256 private initialEpoch;
    uint256 private latestEpoch;

    error InvalidRegistryAdmin();
    error UnauthorizedRegistryAdmin();
    error ZeroValidator();
    error DuplicateValidator(address validator);
    error ValidatorHistoryNotInitialized();
    error UnknownValidatorEpoch(uint256 validatorEpoch);
    error ValidatorEpochAlreadyRegistered(uint256 validatorEpoch);
    error NoncontiguousValidatorEpoch(uint256 expectedEpoch, uint256 suppliedEpoch);
    error ValidatorEpochOverflow();

    event ValidatorSetRegistered(
        uint256 indexed validatorEpoch,
        bytes32 indexed committeeDigest,
        uint8 quorum,
        address validator0,
        address validator1,
        address validator2,
        address validator3
    );

    constructor(address registryAdmin_) {
        if (registryAdmin_ == address(0)) revert InvalidRegistryAdmin();
        registryAdmin = registryAdmin_;
    }

    /// @notice Appends a canonical committee. The first epoch may be any uint256, including zero.
    /// @dev Later epochs must be consecutive. Registered records have no mutation or removal path.
    function registerValidatorSet(uint256 validatorEpoch, address[COMMITTEE_SIZE] calldata validators) external {
        if (msg.sender != registryAdmin) revert UnauthorizedRegistryAdmin();
        if (validatorSets[validatorEpoch].exists) {
            revert ValidatorEpochAlreadyRegistered(validatorEpoch);
        }
        if (hasValidatorHistory) {
            if (latestEpoch == type(uint256).max) revert ValidatorEpochOverflow();
            uint256 expectedEpoch = latestEpoch + 1;
            if (validatorEpoch != expectedEpoch) {
                revert NoncontiguousValidatorEpoch(expectedEpoch, validatorEpoch);
            }
        }

        address[COMMITTEE_SIZE] memory canonical = _canonicalCommittee(validators);
        bytes memory encoded = abi.encode(COMMITTEE_TYPEHASH, COMMITTEE_VERSION, canonical);
        bytes32 digest = bytes32(0);
        // Hash the exact existing PBFT ABI encoding, including its original committee version.
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") {
            digest := keccak256(add(encoded, 0x20), mload(encoded))
        }

        ValidatorSet memory historicalSet = ValidatorSet({
            validators: canonical,
            quorum: QUORUM,
            committeeDigest: digest,
            exists: true
        });
        // Each authority change is recorded by ValidatorSetRegistered below.
        // forge-lint: disable-next-line(missing-events-access-control)
        validatorSets[validatorEpoch] = historicalSet;
        if (!hasValidatorHistory) {
            initialEpoch = validatorEpoch;
            hasValidatorHistory = true;
        }
        latestEpoch = validatorEpoch;

        // Registration has no external interactions; canonicalization and encoding are pure.
        // forge-lint: disable-next-line(reentrancy-events)
        emit ValidatorSetRegistered(validatorEpoch, digest, QUORUM, canonical[0], canonical[1], canonical[2], canonical[3]);
    }

    /// @inheritdoc IValidatorSetRegistry
    function initialValidatorEpoch() external view override returns (uint256) {
        if (!hasValidatorHistory) revert ValidatorHistoryNotInitialized();
        return initialEpoch;
    }

    /// @inheritdoc IValidatorSetRegistry
    function latestValidatorEpoch() external view override returns (uint256) {
        if (!hasValidatorHistory) revert ValidatorHistoryNotInitialized();
        return latestEpoch;
    }

    /// @inheritdoc IValidatorSetRegistry
    function hasValidatorSet(uint256 validatorEpoch) external view override returns (bool) {
        return validatorSets[validatorEpoch].exists;
    }

    /// @inheritdoc IValidatorSetRegistry
    function getValidatorSet(uint256 validatorEpoch)
        external
        view
        override
        returns (address[COMMITTEE_SIZE] memory validators, uint8 quorum, bytes32 committeeDigest)
    {
        ValidatorSet storage validatorSet = _getValidatorSet(validatorEpoch);
        return (validatorSet.validators, validatorSet.quorum, validatorSet.committeeDigest);
    }

    /// @inheritdoc IValidatorSetRegistry
    function isValidator(uint256 validatorEpoch, address validator) external view override returns (bool) {
        ValidatorSet storage validatorSet = _getValidatorSet(validatorEpoch);
        for (uint256 index = 0; index < COMMITTEE_SIZE; ++index) {
            if (validatorSet.validators[index] == validator) return true;
        }
        return false;
    }

    function _getValidatorSet(uint256 validatorEpoch) private view returns (ValidatorSet storage validatorSet) {
        validatorSet = validatorSets[validatorEpoch];
        if (!validatorSet.exists) revert UnknownValidatorEpoch(validatorEpoch);
    }

    function _canonicalCommittee(address[COMMITTEE_SIZE] memory validators)
        private
        pure
        returns (address[COMMITTEE_SIZE] memory)
    {
        if (
            validators[0] == address(0) || validators[1] == address(0)
                || validators[2] == address(0) || validators[3] == address(0)
        ) revert ZeroValidator();

        // Unsigned address ordering matches equal-width lowercase hex ordering in committee.mjs.
        for (uint256 index = 1; index < COMMITTEE_SIZE; ++index) {
            for (uint256 previous = index; previous > 0; --previous) {
                if (uint160(validators[previous - 1]) <= uint160(validators[previous])) break;
                (validators[previous - 1], validators[previous]) = (validators[previous], validators[previous - 1]);
            }
        }
        // With a fixed four-member committee, all duplicate checks fit outside the sorting loop.
        if (validators[0] == validators[1]) revert DuplicateValidator(validators[1]);
        if (validators[1] == validators[2]) revert DuplicateValidator(validators[2]);
        if (validators[2] == validators[3]) revert DuplicateValidator(validators[3]);
        return validators;
    }
}
