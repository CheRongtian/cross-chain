// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {RemoteGatewayRegistry} from "../src/RemoteGatewayRegistry.sol";

contract RemoteGatewayRegistryTest is Test {
    uint256 internal constant SOURCE_DOMAIN = 10_011;
    uint256 internal constant SECOND_SOURCE_DOMAIN = 10_012;
    uint256 internal constant UNKNOWN_SOURCE_DOMAIN = 20_022;
    uint256 internal constant DESTINATION_DOMAIN = 2001;
    uint256 internal constant LARGE_SOURCE_DOMAIN = (1 << 200) + 10_011;
    address internal constant FIRST_GATEWAY = address(0xA11CE);
    address internal constant SECOND_GATEWAY = address(0xB0B);
    address internal constant THIRD_GATEWAY = address(0xCAFE);
    address internal constant UNKNOWN_CALLER = address(0xBAD);

    RemoteGatewayRegistry internal registry;

    function setUp() public {
        registry = new RemoteGatewayRegistry(address(this));
    }

    function testRegistryAdminConfiguredCorrectly() public view {
        assertEq(registry.registryAdmin(), address(this));
    }

    function testRejectsZeroRegistryAdmin() public {
        vm.expectRevert(RemoteGatewayRegistry.InvalidRegistryAdmin.selector);
        new RemoteGatewayRegistry(address(0));
    }

    function testAdminRegistersExactDomainGatewayPair() public {
        registry.setRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);

        assertEq(registry.trustedRemoteGateway(SOURCE_DOMAIN), FIRST_GATEWAY);
        assertTrue(registry.isTrustedRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY));
        registry.requireTrustedRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);
    }

    function testUnknownDomainFailsClosed() public {
        assertEq(registry.trustedRemoteGateway(UNKNOWN_SOURCE_DOMAIN), address(0));
        assertFalse(registry.isTrustedRemoteGateway(UNKNOWN_SOURCE_DOMAIN, FIRST_GATEWAY));

        vm.expectRevert(
            abi.encodeWithSelector(
                RemoteGatewayRegistry.UnknownSourceDomain.selector,
                UNKNOWN_SOURCE_DOMAIN
            )
        );
        registry.requireTrustedRemoteGateway(UNKNOWN_SOURCE_DOMAIN, FIRST_GATEWAY);
    }

    function testKnownDomainRejectsWrongGateway() public {
        registry.setRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);

        assertFalse(registry.isTrustedRemoteGateway(SOURCE_DOMAIN, SECOND_GATEWAY));
        vm.expectRevert(
            abi.encodeWithSelector(
                RemoteGatewayRegistry.UntrustedRemoteGateway.selector,
                SOURCE_DOMAIN,
                SECOND_GATEWAY,
                FIRST_GATEWAY
            )
        );
        registry.requireTrustedRemoteGateway(SOURCE_DOMAIN, SECOND_GATEWAY);
    }

    function testSameGatewayIsNotTrustedForAnotherDomain() public {
        registry.setRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);

        assertFalse(registry.isTrustedRemoteGateway(SECOND_SOURCE_DOMAIN, FIRST_GATEWAY));
        vm.expectRevert(
            abi.encodeWithSelector(
                RemoteGatewayRegistry.UnknownSourceDomain.selector,
                SECOND_SOURCE_DOMAIN
            )
        );
        registry.requireTrustedRemoteGateway(SECOND_SOURCE_DOMAIN, FIRST_GATEWAY);
    }

    function testMultipleDomainsRemainIndependent() public {
        registry.setRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);
        registry.setRemoteGateway(SECOND_SOURCE_DOMAIN, SECOND_GATEWAY);
        registry.setRemoteGateway(SOURCE_DOMAIN, THIRD_GATEWAY);

        assertEq(registry.trustedRemoteGateway(SOURCE_DOMAIN), THIRD_GATEWAY);
        assertEq(registry.trustedRemoteGateway(SECOND_SOURCE_DOMAIN), SECOND_GATEWAY);
    }

    function testAdminReplacesGatewayAndOldGatewayStopsBeingTrusted() public {
        registry.setRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);
        registry.setRemoteGateway(SOURCE_DOMAIN, SECOND_GATEWAY);

        assertEq(registry.trustedRemoteGateway(SOURCE_DOMAIN), SECOND_GATEWAY);
        assertFalse(registry.isTrustedRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY));
        assertTrue(registry.isTrustedRemoteGateway(SOURCE_DOMAIN, SECOND_GATEWAY));
    }

    function testAdminRemovesGatewayAndDomainReturnsToUnknown() public {
        registry.setRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);
        registry.removeRemoteGateway(SOURCE_DOMAIN);

        assertEq(registry.trustedRemoteGateway(SOURCE_DOMAIN), address(0));
        assertFalse(registry.isTrustedRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY));
        vm.expectRevert(
            abi.encodeWithSelector(RemoteGatewayRegistry.UnknownSourceDomain.selector, SOURCE_DOMAIN)
        );
        registry.requireTrustedRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);
    }

    function testRejectsZeroGateway() public {
        vm.expectRevert(RemoteGatewayRegistry.InvalidRemoteGateway.selector);
        registry.setRemoteGateway(SOURCE_DOMAIN, address(0));
    }

    function testRejectsUnauthorizedAddReplaceAndRemove() public {
        vm.prank(UNKNOWN_CALLER);
        vm.expectRevert(RemoteGatewayRegistry.UnauthorizedRegistryAdmin.selector);
        registry.setRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);

        registry.setRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);

        vm.prank(UNKNOWN_CALLER);
        vm.expectRevert(RemoteGatewayRegistry.UnauthorizedRegistryAdmin.selector);
        registry.setRemoteGateway(SOURCE_DOMAIN, SECOND_GATEWAY);

        vm.prank(UNKNOWN_CALLER);
        vm.expectRevert(RemoteGatewayRegistry.UnauthorizedRegistryAdmin.selector);
        registry.removeRemoteGateway(SOURCE_DOMAIN);

        assertEq(registry.trustedRemoteGateway(SOURCE_DOMAIN), FIRST_GATEWAY);
    }

    function testRejectsConfigurationNoOps() public {
        registry.setRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);

        vm.expectRevert(
            abi.encodeWithSelector(
                RemoteGatewayRegistry.RemoteGatewayUnchanged.selector,
                SOURCE_DOMAIN,
                FIRST_GATEWAY
            )
        );
        registry.setRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);

        vm.expectRevert(
            abi.encodeWithSelector(
                RemoteGatewayRegistry.UnknownSourceDomain.selector,
                UNKNOWN_SOURCE_DOMAIN
            )
        );
        registry.removeRemoteGateway(UNKNOWN_SOURCE_DOMAIN);
    }

    function testMutationsEmitExactHistoryEvents() public {
        vm.recordLogs();
        registry.setRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);
        registry.setRemoteGateway(SOURCE_DOMAIN, SECOND_GATEWAY);
        registry.removeRemoteGateway(SOURCE_DOMAIN);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
        _assertUpdateEvent(logs[0], address(0), FIRST_GATEWAY);
        _assertUpdateEvent(logs[1], FIRST_GATEWAY, SECOND_GATEWAY);
        _assertUpdateEvent(logs[2], SECOND_GATEWAY, address(0));
    }

    function testLargeAndMaximumSourceDomainsRemainExact() public {
        registry.setRemoteGateway(LARGE_SOURCE_DOMAIN, FIRST_GATEWAY);
        registry.setRemoteGateway(type(uint256).max, SECOND_GATEWAY);

        assertEq(registry.trustedRemoteGateway(LARGE_SOURCE_DOMAIN), FIRST_GATEWAY);
        assertEq(registry.trustedRemoteGateway(type(uint256).max), SECOND_GATEWAY);
        assertNotEq(LARGE_SOURCE_DOMAIN, type(uint256).max);
    }

    function testDomainZeroIsAnExactConfigurableKey() public {
        registry.setRemoteGateway(0, FIRST_GATEWAY);

        assertTrue(registry.isTrustedRemoteGateway(0, FIRST_GATEWAY));
    }

    function testDestinationDomainIsNotImplicitlyTrusted() public view {
        assertEq(registry.trustedRemoteGateway(DESTINATION_DOMAIN), address(0));
        assertFalse(registry.isTrustedRemoteGateway(DESTINATION_DOMAIN, address(registry)));
    }

    function testRemoteGatewayDoesNotNeedLocalCode() public {
        assertEq(FIRST_GATEWAY.code.length, 0);

        registry.setRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY);

        assertTrue(registry.isTrustedRemoteGateway(SOURCE_DOMAIN, FIRST_GATEWAY));
    }

    function testZeroAddressNeverPassesBooleanTrustCheck() public view {
        assertFalse(registry.isTrustedRemoteGateway(UNKNOWN_SOURCE_DOMAIN, address(0)));
    }

    function _assertUpdateEvent(Vm.Log memory entry, address previousGateway, address newGateway) private view {
        assertEq(entry.emitter, address(registry));
        assertEq(entry.topics.length, 4);
        assertEq(entry.topics[0], RemoteGatewayRegistry.RemoteGatewayUpdated.selector);
        assertEq(entry.topics[1], bytes32(SOURCE_DOMAIN));
        assertEq(entry.topics[2], bytes32(uint256(uint160(previousGateway))));
        assertEq(entry.topics[3], bytes32(uint256(uint160(newGateway))));
        assertEq(entry.data.length, 0);
    }
}
