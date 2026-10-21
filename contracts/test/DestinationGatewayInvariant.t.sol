// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GatewaySecurityFixture} from "./helpers/GatewaySecurityFixture.sol";
import {GatewayHandler} from "./helpers/GatewayHandler.sol";
import {DeliveryCodecHarness} from "./helpers/DeliveryCodecHarness.sol";
import {DeliveryPackageCodec as Codec} from "../src/libraries/DeliveryPackageCodec.sol";

contract DestinationGatewayInvariantTest is GatewaySecurityFixture {
    uint256 private constant POOL_SIZE = 6;
    GatewayHandler private handler;

    // Setup proves every fixture, restores it unused, and never consumes a model message before fuzzing.
    // forge-lint: disable-next-item(calls-loop)
    function setUp() public override {
        super.setUp();
        bytes[] memory pool = new bytes[](POOL_SIZE);
        for (uint256 index = 0; index < POOL_SIZE; index++) {
            uint256 nonce = (uint256(1) << (128 + index)) | index;
            Codec.Package memory pack = _freshPackage(nonce, abi.encode(index), LONG_DEADLINE,
                index % 2 == 0 ? FIXTURE_FIRST_AUTHORITY : FIXTURE_SECOND_AUTHORITY);
            _positiveThenRestore(pack);
            pool[index] = _encode(pack);
        }
        Codec.Package memory expiring = _freshPackage(type(uint256).max, "expiring", START_TIME + 1, FIXTURE_FIRST_AUTHORITY);
        _positiveThenRestore(expiring);
        DeliveryCodecHarness decoder = new DeliveryCodecHarness();
        handler = new GatewayHandler(gateway, receiver, decoder, pool, _encode(expiring));
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = GatewayHandler.executeValid.selector;
        selectors[1] = GatewayHandler.replay.selector;
        selectors[2] = GatewayHandler.invalidMerkle.selector;
        selectors[3] = GatewayHandler.invalidQC.selector;
        selectors[4] = GatewayHandler.wrongDestination.selector;
        selectors[5] = GatewayHandler.wrongSource.selector;
        selectors[6] = GatewayHandler.malformedPackage.selector;
        selectors[7] = GatewayHandler.expiredMessage.selector;
        selectors[8] = GatewayHandler.sameMessageReentrant.selector;
        selectors[9] = GatewayHandler.downstreamRevert.selector;
        selectors[10] = GatewayHandler.alternateCanonicalReplay.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // Group the related properties into one campaign to avoid multiplying the same expensive call sequences.
    function invariantAuthenticatedExactlyOnceAndAtomicIsolation() public view {
        handler.assertModel();
    }

    // A separate deterministic reachability check prevents a broken/no-op handler from looking like coverage.
    // The actual invariant campaign still gets its entire ordering and parameters from Foundry.
    function testHandlerActionsReachFreshProductionBoundaries() public {
        handler.invalidMerkle(0, bytes32(uint256(1)), address(0xA));
        handler.invalidQC(0, address(0xB));
        handler.wrongDestination(0, uint256(1) << 255, address(0xC));
        handler.wrongSource(0, address(0xD));
        handler.malformedPackage(0, address(0xE));
        handler.downstreamRevert(0, address(0xF));
        handler.sameMessageReentrant(0, address(0xA));
        handler.replay(0, address(0xB));
        handler.alternateCanonicalReplay(0, 123, address(0xC));
        handler.expiredMessage(1, address(0xD));
        handler.executeValid(1, address(0xE));
        handler.assertModel();
        assertEq(handler.reentrantRejections(), 1);
        assertEq(handler.downstreamRejections(), 1);
        assertEq(handler.validSuccesses(), 2);
        assertEq(receiver.callsByMessage(handler.messageId(0)), 1);
        assertEq(receiver.callsByMessage(handler.messageId(1)), 1);
        assertFalse(gateway.isMessageExecuted(handler.EXPIRED_ID()));
    }
}
