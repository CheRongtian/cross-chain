// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolTestFixtures} from "./ProtocolTestFixtures.sol";
import {DestinationGateway} from "../../src/DestinationGateway.sol";
import {RemoteGatewayRegistry} from "../../src/RemoteGatewayRegistry.sol";
import {ValidatorSetRegistry} from "../../src/ValidatorSetRegistry.sol";
import {PBFTCertificateVerifier} from "../../src/PBFTCertificateVerifier.sol";
import {MerkleInclusionVerifier} from "../../src/MerkleInclusionVerifier.sol";
import {MessageDomainVerifier} from "../../src/MessageDomainVerifier.sol";
import {DeliveryPackageCodec as Codec} from "../../src/libraries/DeliveryPackageCodec.sol";
import {GatewayReceiverFixture} from "../mocks/GatewayReceiverFixture.sol";

/// @dev TEST-ONLY local EVM setup. Every authorization boundary uses the actual production contract.
abstract contract GatewaySecurityFixture is ProtocolTestFixtures {
    uint256 internal constant SOURCE = 10011;
    uint256 internal constant DESTINATION = 2001;
    uint256 internal constant START_TIME = 2_000_000_000;
    uint256 internal constant LONG_DEADLINE = START_TIME + 30 days;
    address internal constant SOURCE_GATEWAY = address(0x1001);

    DestinationGateway internal gateway;
    GatewayReceiverFixture internal receiver;
    RemoteGatewayRegistry internal remote;
    ValidatorSetRegistry internal validators;
    PBFTCertificateVerifier internal certificateVerifier;
    MerkleInclusionVerifier internal merkleVerifier;
    MessageDomainVerifier internal domainVerifier;

    function setUp() public virtual {
        vm.warp(START_TIME);
        remote = new RemoteGatewayRegistry(address(this));
        remote.setRemoteGateway(SOURCE, SOURCE_GATEWAY);
        validators = new ValidatorSetRegistry(address(this));
        validators.registerValidatorSet(FIXTURE_FIRST_AUTHORITY, _committee(FIXTURE_FIRST_AUTHORITY));
        validators.registerValidatorSet(FIXTURE_SECOND_AUTHORITY, _committee(FIXTURE_SECOND_AUTHORITY));
        certificateVerifier = new PBFTCertificateVerifier(address(validators));
        merkleVerifier = new MerkleInclusionVerifier();
        domainVerifier = new MessageDomainVerifier(address(remote), DESTINATION);
        gateway = new DestinationGateway(address(certificateVerifier), address(merkleVerifier), address(domainVerifier));
        receiver = new GatewayReceiverFixture();
        receiver.configure(gateway, false, "");
    }

    // The six-message pool constructs independent, fixed two-member arrays in its setup loop.
    // No external service or untrusted allocation size is used, including through authentication helpers.
    // forge-lint: disable-next-item(calls-loop)
    function _freshPackage(uint256 nonce, bytes memory payload, uint256 deadline, uint256 authority)
        internal view returns (Codec.Package memory pack)
    {
        pack.message.version = 2;
        pack.message.sourceDomain = SOURCE;
        pack.message.sourceGateway = SOURCE_GATEWAY;
        pack.message.sourceSender = address(0x1002);
        pack.message.destinationDomain = DESTINATION;
        pack.message.destinationGateway = address(gateway);
        pack.message.destinationReceiver = address(receiver);
        pack.message.nonce = nonce;
        pack.message.payload = payload;
        pack.message.deadline = deadline;
        pack.batch.version = 1;
        pack.batch.epoch = (uint256(1) << 200) | nonce;
        pack.batch.messageIds = new bytes32[](2);
        // Keep the second member unique even for arbitrary full-width message identities.
        pack.envelope.domain = "CrossChainDeliveryPackage";
        pack.envelope.version = 1;
        pack.envelope.deliveryJobId = "security-fixture";
        pack.envelope.leafCount = 2;
        _authenticate(pack, authority);
    }

    function _authenticate(Codec.Package memory pack, uint256 authority) internal view {
        _authenticatePackage(pack, validators, merkleVerifier, authority);
    }

    // Each bounded pool iteration executes the real local Gateway and restores only its own EVM snapshot.
    // Keep the VM, Gateway and receiver calls observable here rather than bypassing positive controls.
    // forge-lint: disable-next-item(calls-loop)
    function _positiveThenRestore(Codec.Package memory pack) internal {
        uint256 snapshot = vm.snapshotState();
        gateway.execute(_encode(pack));
        assertTrue(gateway.isMessageExecuted(pack.message.messageId));
        assertEq(receiver.callsByMessage(pack.message.messageId), 1);
        assertTrue(vm.revertToStateAndDelete(snapshot));
        assertFalse(gateway.isMessageExecuted(pack.message.messageId));
        assertEq(receiver.callsByMessage(pack.message.messageId), 0);
    }

    function _payload(bytes32 entropy, uint256 length) internal pure returns (bytes memory payload) {
        assertLe(length, 256, "fixture payload bound");
        payload = new bytes(length);
        for (uint256 index = 0; index < length; index++) payload[index] = entropy[index % FIXTURE_WORD];
    }
}
