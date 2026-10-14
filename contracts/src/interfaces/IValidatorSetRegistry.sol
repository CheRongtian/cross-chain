// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Exact historical authority for canonical four-validator committees.
interface IValidatorSetRegistry {
    /// @notice Returns whether at least one historical committee has been registered.
    function hasValidatorHistory() external view returns (bool);

    /// @notice Returns the immutable initial epoch; reverts before history is initialized.
    function initialValidatorEpoch() external view returns (uint256);

    /// @notice Returns the last appended epoch; reverts before history is initialized.
    function latestValidatorEpoch() external view returns (uint256);

    function hasValidatorSet(uint256 validatorEpoch) external view returns (bool);

    /// @notice Returns the exact historical committee, quorum and digest; unknown epochs revert.
    function getValidatorSet(uint256 validatorEpoch)
        external
        view
        returns (address[4] memory validators, uint8 quorum, bytes32 committeeDigest);

    /// @notice Tests membership in the exact historical epoch; unknown epochs revert.
    function isValidator(uint256 validatorEpoch, address validator) external view returns (bool);
}
