// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title FinalEscrow
/// @notice Non-upgradeable Arc USDC escrow. No owner. No admin withdraw.
///         The deployer key cannot move funds after deployment.
/// @dev Not deployed. Do not point production at a placeholder address.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract FinalEscrow {
    address public immutable usdc;

    enum Status {
        None,
        Open,
        Funded,
        Released,
        Refunded,
        Cancelled
    }

    struct Terms {
        address payer;
        address recipient;
        address creator;
        uint256 amount;
        uint256 expiresAt;
        Status status;
    }

    mapping(bytes32 => Terms) public escrows;

    event EscrowOpened(
        bytes32 indexed escrowId,
        address payer,
        address recipient,
        address indexed creator,
        uint256 amount,
        uint256 expiresAt
    );
    event EscrowCancelled(bytes32 indexed escrowId);
    event EscrowFunded(bytes32 indexed escrowId, address indexed payer, uint256 amount);
    event EscrowReleased(bytes32 indexed escrowId, address indexed recipient, uint256 amount);
    event EscrowRefunded(bytes32 indexed escrowId, address indexed payer, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error BadExpiry();
    error BadState();
    error NotCreator();
    error NotPayer();
    error NotRecipient();
    error Expired();
    error TooEarly();
    error TransferFailed();

    constructor(address usdc_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
    }

    /// @dev Canonical id. Same payer, recipient, amount, and creator with a different expiry is a different escrow.
    function escrowIdFor(
        address payer,
        address recipient,
        address creator,
        uint256 amount,
        uint256 expiresAt
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("FINAL_ESCROW_V1"),
                block.chainid,
                usdc,
                payer,
                recipient,
                creator,
                amount,
                expiresAt
            )
        );
    }

    function open(address payer, address recipient, uint256 amount, uint256 expiresAt) external returns (bytes32 escrowId) {
        if (payer == address(0) || recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (expiresAt <= block.timestamp) revert BadExpiry();
        escrowId = escrowIdFor(payer, recipient, msg.sender, amount, expiresAt);
        Terms storage row = escrows[escrowId];
        if (row.status != Status.None) revert BadState();
        row.payer = payer;
        row.recipient = recipient;
        row.creator = msg.sender;
        row.amount = amount;
        row.expiresAt = expiresAt;
        row.status = Status.Open;
        emit EscrowOpened(escrowId, payer, recipient, msg.sender, amount, expiresAt);
    }

    /// @notice Blocks a not-yet-opened id. No tokens move.
    function voidEscrow(address payer, address recipient, uint256 amount, uint256 expiresAt) external {
        if (payer == address(0) || recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        bytes32 escrowId = escrowIdFor(payer, recipient, msg.sender, amount, expiresAt);
        Terms storage row = escrows[escrowId];
        if (row.status != Status.None) revert BadState();
        row.payer = payer;
        row.recipient = recipient;
        row.creator = msg.sender;
        row.amount = amount;
        row.expiresAt = expiresAt;
        row.status = Status.Cancelled;
        emit EscrowCancelled(escrowId);
    }

    /// @notice Cancel an opened escrow before funding. Creator only. No tokens move.
    function cancel(bytes32 escrowId) external {
        Terms storage row = escrows[escrowId];
        if (row.status != Status.Open) revert BadState();
        if (msg.sender != row.creator) revert NotCreator();
        row.status = Status.Cancelled;
        emit EscrowCancelled(escrowId);
    }

    function fund(bytes32 escrowId) external {
        Terms storage row = escrows[escrowId];
        if (row.status != Status.Open) revert BadState();
        if (msg.sender != row.payer) revert NotPayer();
        row.status = Status.Funded;
        if (!IERC20(usdc).transferFrom(msg.sender, address(this), row.amount)) revert TransferFailed();
        emit EscrowFunded(escrowId, msg.sender, row.amount);
    }

    /// @notice Recipient only, and only strictly before expiresAt. Pays the stored recipient.
    function release(bytes32 escrowId) external {
        Terms storage row = escrows[escrowId];
        if (row.status != Status.Funded) revert BadState();
        if (msg.sender != row.recipient) revert NotRecipient();
        if (block.timestamp >= row.expiresAt) revert Expired();
        row.status = Status.Released;
        if (!IERC20(usdc).transfer(row.recipient, row.amount)) revert TransferFailed();
        emit EscrowReleased(escrowId, row.recipient, row.amount);
    }

    /// @notice Payer only, at or after expiresAt. Pays the stored payer. No other address.
    function refund(bytes32 escrowId) external {
        Terms storage row = escrows[escrowId];
        if (row.status != Status.Funded) revert BadState();
        if (msg.sender != row.payer) revert NotPayer();
        if (block.timestamp < row.expiresAt) revert TooEarly();
        row.status = Status.Refunded;
        if (!IERC20(usdc).transfer(row.payer, row.amount)) revert TransferFailed();
        emit EscrowRefunded(escrowId, row.payer, row.amount);
    }
}
