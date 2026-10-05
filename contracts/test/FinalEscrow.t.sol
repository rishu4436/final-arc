// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FinalEscrow} from "../FinalEscrow.sol";

interface Vm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
}

contract MockUsdc {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract FinalEscrowTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal payer = address(0xA11CE);
    address internal recipient = address(0xB0B);
    address internal creator = address(0xC0FFEE);

    function _deploy() internal returns (MockUsdc token, FinalEscrow escrow) {
        token = new MockUsdc();
        escrow = new FinalEscrow(address(token));
    }

    function testOpenThenFundThenRelease() public {
        (MockUsdc token, FinalEscrow escrow) = _deploy();
        uint256 expiry = block.timestamp + 100;
        vm.prank(creator);
        bytes32 id = escrow.open(payer, recipient, 1_000_000, expiry);
        (,,,,, FinalEscrow.Status status) = escrow.escrows(id);
        assert(status == FinalEscrow.Status.Open);

        token.mint(payer, 1_000_000);
        vm.prank(payer);
        token.approve(address(escrow), 1_000_000);
        vm.prank(payer);
        escrow.fund(id);
        (,,,,, status) = escrow.escrows(id);
        assert(status == FinalEscrow.Status.Funded);
        assert(token.balanceOf(address(escrow)) == 1_000_000);

        vm.prank(recipient);
        escrow.release(id);
        (,,,,, status) = escrow.escrows(id);
        assert(status == FinalEscrow.Status.Released);
        assert(token.balanceOf(recipient) == 1_000_000);
        assert(token.balanceOf(address(escrow)) == 0);

        vm.expectRevert(FinalEscrow.BadState.selector);
        vm.prank(payer);
        escrow.refund(id);
    }

    function testFundBeforeOpenReverts() public {
        (, FinalEscrow escrow) = _deploy();
        vm.expectRevert(FinalEscrow.BadState.selector);
        vm.prank(payer);
        escrow.fund(bytes32("missing"));
    }

    function testRefundAtExpiryAndReleaseBlocked() public {
        (MockUsdc token, FinalEscrow escrow) = _deploy();
        uint256 expiry = block.timestamp + 50;
        vm.prank(creator);
        bytes32 id = escrow.open(payer, recipient, 5, expiry);
        token.mint(payer, 5);
        vm.prank(payer);
        token.approve(address(escrow), 5);
        vm.prank(payer);
        escrow.fund(id);

        vm.warp(expiry);
        vm.expectRevert(FinalEscrow.Expired.selector);
        vm.prank(recipient);
        escrow.release(id);

        vm.prank(payer);
        escrow.refund(id);
        (,,,,, FinalEscrow.Status status) = escrow.escrows(id);
        assert(status == FinalEscrow.Status.Refunded);
        assert(token.balanceOf(payer) == 5);

        vm.expectRevert(FinalEscrow.BadState.selector);
        vm.prank(recipient);
        escrow.release(id);
    }

    function testRefundBeforeExpiryReverts() public {
        (MockUsdc token, FinalEscrow escrow) = _deploy();
        uint256 expiry = block.timestamp + 50;
        vm.prank(creator);
        bytes32 id = escrow.open(payer, recipient, 5, expiry);
        token.mint(payer, 5);
        vm.prank(payer);
        token.approve(address(escrow), 5);
        vm.prank(payer);
        escrow.fund(id);
        vm.expectRevert(FinalEscrow.TooEarly.selector);
        vm.prank(payer);
        escrow.refund(id);
    }

    function testVoidBlocksLaterOpenAndCancelIsCreatorOnly() public {
        (, FinalEscrow escrow) = _deploy();
        uint256 expiry = block.timestamp + 10;
        vm.prank(creator);
        escrow.voidEscrow(payer, recipient, 7, expiry);
        vm.expectRevert(FinalEscrow.BadState.selector);
        vm.prank(creator);
        escrow.open(payer, recipient, 7, expiry);

        vm.prank(creator);
        bytes32 id = escrow.open(payer, recipient, 8, expiry);
        vm.expectRevert(FinalEscrow.NotCreator.selector);
        vm.prank(payer);
        escrow.cancel(id);
        vm.prank(creator);
        escrow.cancel(id);
        vm.expectRevert(FinalEscrow.BadState.selector);
        vm.prank(payer);
        escrow.fund(id);
    }

    function testUnlimitedApprovalIsNotRequiredAndWrongPayerCannotFund() public {
        (MockUsdc token, FinalEscrow escrow) = _deploy();
        uint256 expiry = block.timestamp + 10;
        vm.prank(creator);
        bytes32 id = escrow.open(payer, recipient, 9, expiry);
        token.mint(payer, 9);
        vm.expectRevert();
        vm.prank(payer);
        escrow.fund(id);
        (,,,,, FinalEscrow.Status status) = escrow.escrows(id);
        assert(status == FinalEscrow.Status.Open);
        vm.expectRevert(FinalEscrow.NotPayer.selector);
        vm.prank(recipient);
        escrow.fund(id);
    }
}
