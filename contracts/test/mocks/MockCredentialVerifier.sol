// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICredentialVerifier} from "../../src/interfaces/ICredentialVerifier.sol";

contract MockCredentialVerifier is ICredentialVerifier {
    bool internal verificationResult;

    function setVerificationResult(bool result) external {
        verificationResult = result;
    }

    function verifyCredentialProof(
        uint256[2] calldata,
        uint256[2][2] calldata,
        uint256[2] calldata,
        uint256,
        uint256,
        uint256,
        uint256
    ) external view returns (bool) {
        return verificationResult;
    }
}
