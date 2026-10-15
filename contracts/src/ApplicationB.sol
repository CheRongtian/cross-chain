// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ICrossChainReceiver} from "./interfaces/ICrossChainReceiver.sol";

/// @notice Records supplier grants from one exact destination Gateway, without duplicating protocol verification.
/// @dev Command ABI: (uint8 version, uint8 action, address supplier), exactly three canonical ABI words.
///      Supplier identity is explicit business intent, not a claim about the private credential subject.
contract ApplicationB is ICrossChainReceiver {
    uint8 public constant COMMAND_VERSION = 1;
    uint8 public constant ACTION_GRANT_VERIFIED_SUPPLIER = 1;
    uint256 private constant COMMAND_LENGTH = 96;

    // Preserve the conventional project-facing configuration getter.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable destinationGateway;

    mapping(address supplier => bool verified) private _verifiedSuppliers;

    error InvalidDestinationGateway();
    error UnauthorizedDestinationGateway(address caller, address expectedGateway);
    error InvalidBusinessPayload();
    error UnsupportedCommandVersion(uint256 version);
    error UnsupportedBusinessAction(uint256 action);
    error InvalidSupplier();
    error AlreadyVerifiedSupplier(address supplier);

    event VerifiedSupplierGranted(bytes32 indexed messageId, address indexed supplier);

    constructor(address destinationGateway_) {
        if (destinationGateway_ == address(0)) revert InvalidDestinationGateway();
        destinationGateway = destinationGateway_;
    }

    function isVerifiedSupplier(address supplier) external view returns (bool) {
        return _verifiedSuppliers[supplier];
    }

    /// @inheritdoc ICrossChainReceiver
    function handleCrossChainMessage(bytes32 messageId, bytes calldata payload) external override {
        if (msg.sender != destinationGateway) {
            revert UnauthorizedDestinationGateway(msg.sender, destinationGateway);
        }
        if (payload.length != COMMAND_LENGTH) revert InvalidBusinessPayload();

        // Read full words first so dirty uint8/address padding has a precise error, without rehashing/reencoding.
        (uint256 version, uint256 action, uint256 supplierWord) = abi.decode(payload, (uint256, uint256, uint256));
        if (version > type(uint8).max || action > type(uint8).max || supplierWord > type(uint160).max) {
            revert InvalidBusinessPayload();
        }
        if (version != COMMAND_VERSION) revert UnsupportedCommandVersion(version);
        if (action != ACTION_GRANT_VERIFIED_SUPPLIER) revert UnsupportedBusinessAction(action);
        // The explicit width check above rejects every noncanonical high address bit before narrowing.
        // forge-lint: disable-next-line(unsafe-typecast)
        address supplier = address(uint160(supplierWord));
        if (supplier == address(0)) revert InvalidSupplier();
        if (_verifiedSuppliers[supplier]) revert AlreadyVerifiedSupplier(supplier);

        _verifiedSuppliers[supplier] = true;
        emit VerifiedSupplierGranted(messageId, supplier);
    }
}
