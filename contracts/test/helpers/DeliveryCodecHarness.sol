// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolTestFixtures} from "./ProtocolTestFixtures.sol";
import {MessageCodec} from "../../src/MessageCodec.sol";
import {DeliveryPackageCodec as Codec} from "../../src/libraries/DeliveryPackageCodec.sol";

/// @dev TEST-ONLY surface for the existing internal decoder. No alternative decoder or acceptance policy.
contract DeliveryCodecHarness is ProtocolTestFixtures {
    function roundTrip(bytes calldata encoded) external pure returns (bytes memory) {
        return _encode(Codec.decode(encoded));
    }

    function canonicalMessage(bytes calldata encoded) external pure returns (MessageCodec.CanonicalMessage memory) {
        Codec.Package memory pack = Codec.decode(encoded);
        return Codec.canonicalMessage(pack.message);
    }

    function decodePackage(bytes calldata encoded) external pure returns (Codec.Package memory) {
        return Codec.decode(encoded);
    }
}
