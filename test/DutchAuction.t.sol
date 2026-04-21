// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import {DutchAuction} from "../src/DutchAuction.sol";

/*//////////////////////////////////////////////////////////////
                            MOCKS
//////////////////////////////////////////////////////////////*/

contract MockERC20 {
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
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allow");
        balanceOf[from] -= amount;
        allowance[from][msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev USDT-style: doesn't return a bool from transfer/transferFrom.
contract MockERC20NoReturn {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allow");
        balanceOf[from] -= amount;
        allowance[from][msg.sender] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Returns false from transfer — should cause _safeTransfer to revert.
contract MockERC20ReturnsFalse {
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

contract MockERC721 {
    mapping(uint256 => address) public ownerOf;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(uint256 => address) public getApproved;

    function mint(address to, uint256 id) external {
        ownerOf[id] = to;
    }

    function approve(address to, uint256 id) external {
        getApproved[id] = to;
    }

    function setApprovalForAll(address op, bool ok) external {
        isApprovedForAll[msg.sender][op] = ok;
    }

    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "owner");
        require(msg.sender == from || isApprovedForAll[from][msg.sender] || getApproved[id] == msg.sender, "approved");
        ownerOf[id] = to;
        delete getApproved[id];
    }
}

/// @dev Rejects ETH — simulates a seller contract whose receive reverts.
contract RejectETH {}

/// @dev Seller contract that tries to reenter fill() when it receives ETH.
contract ReentrantSeller {
    DutchAuction public auction;
    uint256 public targetId;

    constructor(DutchAuction _auction) {
        auction = _auction;
    }

    function setTarget(uint256 id) external {
        targetId = id;
    }

    receive() external payable {
        // Try to reenter fill on same auction — should revert via guard.
        auction.fill{value: 0}(targetId, 0);
    }
}

/*//////////////////////////////////////////////////////////////
                             TEST
//////////////////////////////////////////////////////////////*/

contract DutchAuctionTest is Test {
    DutchAuction auction;
    MockERC20 tok;
    MockERC721 nft;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCAFE);

    function setUp() public {
        auction = new DutchAuction();
        tok = new MockERC20();
        nft = new MockERC721();

        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(carol, 1000 ether);
    }

    /*──────────────── listNFT ────────────────*/

    function _listOneNFT(uint256 id, uint128 startP, uint128 endP, uint40 dur) internal returns (uint256) {
        nft.mint(alice, id);
        vm.startPrank(alice);
        nft.setApprovalForAll(address(auction), true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        uint256 aId = auction.listNFT(address(nft), ids, startP, endP, 0, dur);
        vm.stopPrank();
        return aId;
    }

    function testListNFTSingle() public {
        uint256 aId = _listOneNFT(42, 10 ether, 0, 1 hours);
        assertEq(nft.ownerOf(42), address(auction));
        (address seller, address token,,,,,,) = auction.auctions(aId);
        assertEq(seller, alice);
        assertEq(token, address(nft));
    }

    function testListNFTBundle() public {
        for (uint256 i; i < 3; ++i) {
            nft.mint(alice, i + 1);
        }
        vm.startPrank(alice);
        nft.setApprovalForAll(address(auction), true);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1;
        ids[1] = 2;
        ids[2] = 3;
        uint256 aId = auction.listNFT(address(nft), ids, 5 ether, 1, 0, 1 hours);
        vm.stopPrank();

        uint256[] memory got = auction.idsOf(aId);
        assertEq(got.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertEq(nft.ownerOf(i + 1), address(auction));
        }
    }

    function testListNFTRevertsEmpty() public {
        uint256[] memory ids = new uint256[](0);
        vm.prank(alice);
        vm.expectRevert(DutchAuction.Bad.selector);
        auction.listNFT(address(nft), ids, 1 ether, 0, 0, 1 hours);
    }

    function testListNFTRevertsZeroDuration() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.prank(alice);
        vm.expectRevert(DutchAuction.Bad.selector);
        auction.listNFT(address(nft), ids, 1 ether, 0, 0, 0);
    }

    function testListNFTRevertsEOAToken() public {
        // EOA token: Solidity's implicit extcodesize check on the typed IERC721 call reverts.
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.prank(alice);
        vm.expectRevert();
        auction.listNFT(address(0xbeef), ids, 1 ether, 0, 0, 1 hours);
    }

    function testListNFTRevertsStartBelowEnd() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.prank(alice);
        vm.expectRevert(DutchAuction.Bad.selector);
        auction.listNFT(address(nft), ids, 1 ether, 2 ether, 0, 1 hours);
    }

    /*──────────────── listERC20 ────────────────*/

    function _listERC20(uint128 amount, uint128 startP, uint128 endP, uint40 dur) internal returns (uint256) {
        tok.mint(alice, amount);
        vm.startPrank(alice);
        tok.approve(address(auction), amount);
        uint256 aId = auction.listERC20(address(tok), amount, startP, endP, 0, dur);
        vm.stopPrank();
        return aId;
    }

    function testListERC20() public {
        uint256 aId = _listERC20(1000e18, 10 ether, 1, 1 hours);
        assertEq(tok.balanceOf(address(auction)), 1000e18);
        (,,,,,, uint128 initial, uint128 remaining) = auction.auctions(aId);
        assertEq(initial, 1000e18);
        assertEq(remaining, 1000e18);
    }

    function testListERC20USDTStyle() public {
        MockERC20NoReturn usdt = new MockERC20NoReturn();
        usdt.mint(alice, 1000e6);
        vm.startPrank(alice);
        usdt.approve(address(auction), 1000e6);
        uint256 aId = auction.listERC20(address(usdt), 1000e6, 5 ether, 0, 0, 1 hours);
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(auction)), 1000e6);
        (,,,,,, uint128 initial,) = auction.auctions(aId);
        assertEq(initial, 1000e6);
    }

    function testListERC20RevertsReturnsFalse() public {
        MockERC20ReturnsFalse bad = new MockERC20ReturnsFalse();
        vm.prank(alice);
        vm.expectRevert(DutchAuction.TransferFailed.selector);
        auction.listERC20(address(bad), 1, 1, 0, 0, 1 hours);
    }

    function testListERC20RevertsZero() public {
        vm.prank(alice);
        vm.expectRevert(DutchAuction.Bad.selector);
        auction.listERC20(address(tok), 0, 1 ether, 0, 0, 1 hours);
    }

    function testListERC20RevertsZeroDuration() public {
        vm.prank(alice);
        vm.expectRevert(DutchAuction.Bad.selector);
        auction.listERC20(address(tok), 1e18, 1 ether, 0, 0, 0);
    }

    function testListERC20RevertsStartBelowEnd() public {
        vm.prank(alice);
        vm.expectRevert(DutchAuction.Bad.selector);
        auction.listERC20(address(tok), 1e18, 1 ether, 2 ether, 0, 1 hours);
    }

    function testListERC20RevertsEOAToken() public {
        // 0xbeef has no code on the forked block — must revert without silently "succeeding".
        vm.prank(alice);
        vm.expectRevert(DutchAuction.TransferFailed.selector);
        auction.listERC20(address(0xbeef), 1e18, 1 ether, 0, 0, 1 hours);
    }

    /*──────────────── priceOf decay ────────────────*/

    function testPriceDecay() public {
        uint256 aId = _listOneNFT(1, 10 ether, 0, 1 hours);
        uint40 startT = uint40(block.timestamp);

        assertEq(auction.priceOf(aId), 10 ether);

        vm.warp(startT + 1); // just after start
        // elapsed=1, duration=3600, price = 10e18 - 10e18*1/3600
        assertApproxEqAbs(auction.priceOf(aId), uint256(10 ether) - uint256(10 ether) / 3600, 1);

        vm.warp(startT + 30 minutes);
        assertEq(auction.priceOf(aId), 5 ether);

        vm.warp(startT + 1 hours);
        assertEq(auction.priceOf(aId), 0);

        vm.warp(startT + 2 hours);
        assertEq(auction.priceOf(aId), 0);
    }

    function testPriceBeforeStart() public {
        uint40 future = uint40(block.timestamp + 1000);
        nft.mint(alice, 1);
        vm.startPrank(alice);
        nft.setApprovalForAll(address(auction), true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256 aId = auction.listNFT(address(nft), ids, 10 ether, 1, future, 1 hours);
        vm.stopPrank();

        assertEq(auction.priceOf(aId), 10 ether); // before start
        vm.warp(future);
        assertEq(auction.priceOf(aId), 10 ether);
        vm.warp(future + 1 hours);
        assertEq(auction.priceOf(aId), 1);
    }

    /*──────────────── fill NFT ────────────────*/

    function testFillNFTAtFullPrice() public {
        uint256 aId = _listOneNFT(7, 10 ether, 0, 1 hours);

        uint256 bobBefore = bob.balance;
        uint256 aliceBefore = alice.balance;

        vm.prank(bob);
        auction.fill{value: 10 ether}(aId, 0);

        assertEq(nft.ownerOf(7), bob);
        assertEq(alice.balance, aliceBefore + 10 ether);
        assertEq(bob.balance, bobBefore - 10 ether);

        // auction deleted
        (address seller,,,,,,,) = auction.auctions(aId);
        assertEq(seller, address(0));
    }

    function testFillNFTRefundsExcess() public {
        uint256 aId = _listOneNFT(7, 10 ether, 0, 1 hours);
        uint40 startT = uint40(block.timestamp);
        vm.warp(startT + 30 minutes); // price = 5 ETH

        uint256 bobBefore = bob.balance;
        uint256 aliceBefore = alice.balance;

        vm.prank(bob);
        auction.fill{value: 10 ether}(aId, 0);

        assertEq(nft.ownerOf(7), bob);
        assertEq(alice.balance, aliceBefore + 5 ether);
        assertEq(bob.balance, bobBefore - 5 ether); // 5 ETH refunded
    }

    function testFillNFTAtEndZero() public {
        uint256 aId = _listOneNFT(7, 10 ether, 0, 1 hours);
        vm.warp(block.timestamp + 2 hours);

        vm.prank(bob);
        auction.fill{value: 0}(aId, 0);

        assertEq(nft.ownerOf(7), bob);
    }

    function testFillNFTRevertsInsufficient() public {
        uint256 aId = _listOneNFT(7, 10 ether, 0, 1 hours);
        vm.prank(bob);
        vm.expectRevert(DutchAuction.Insufficient.selector);
        auction.fill{value: 1 ether}(aId, 0);
    }

    function testFillNFTBundle() public {
        for (uint256 i; i < 3; ++i) {
            nft.mint(alice, i + 1);
        }
        vm.startPrank(alice);
        nft.setApprovalForAll(address(auction), true);
        uint256[] memory ids = new uint256[](3);
        ids[0] = 1;
        ids[1] = 2;
        ids[2] = 3;
        uint256 aId = auction.listNFT(address(nft), ids, 30 ether, 1, 0, 1 hours);
        vm.stopPrank();

        vm.prank(bob);
        auction.fill{value: 30 ether}(aId, 0);

        for (uint256 i; i < 3; ++i) {
            assertEq(nft.ownerOf(i + 1), bob);
        }
    }

    function testFillNFTRevertsUnknownId() public {
        vm.prank(bob);
        vm.expectRevert(DutchAuction.Bad.selector);
        auction.fill{value: 1 ether}(999, 0);
    }

    function testFillNFTRejectingSellerReverts() public {
        RejectETH rej = new RejectETH();
        nft.mint(address(rej), 1);

        // RejectETH can't call approve — so mint to alice instead, transfer to rej via a direct approval trick
        // Simulating: list on behalf of rej by making alice the seller transferring out
        // Easier: deploy AcceptETH and use it as seller via prank? Prank changes msg.sender but external calls happen from it.
        // We'll just use a low-level: alice lists, then sets seller manually? Can't — no setter.
        // Instead: use vm.prank on rej's address to call listNFT. Approvals need the NFT owner to call approve.
        // vm.prank only changes msg.sender for the single next call. So we need rej to own NFT & approve.
        // Simpler path: mint to rej, use vm.prank(rej) to setApprovalForAll and listNFT.
        vm.startPrank(address(rej));
        nft.setApprovalForAll(address(auction), true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256 aId = auction.listNFT(address(nft), ids, 1 ether, 0, 0, 1 hours);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(DutchAuction.TransferFailed.selector);
        auction.fill{value: 1 ether}(aId, 0);
    }

    /*──────────────── fill ERC20 (partial) ────────────────*/

    function testFillERC20Full() public {
        uint256 aId = _listERC20(1000e18, 10 ether, 0, 1 hours);

        vm.prank(bob);
        auction.fill{value: 10 ether}(aId, 1000e18);

        assertEq(tok.balanceOf(bob), 1000e18);
        (address seller,,,,,,,) = auction.auctions(aId); // deleted
        assertEq(seller, address(0));
    }

    function testFillERC20Partial() public {
        uint256 aId = _listERC20(1000e18, 10 ether, 0, 1 hours);

        vm.prank(bob);
        auction.fill{value: 1 ether}(aId, 100e18);
        assertEq(tok.balanceOf(bob), 100e18);

        (,,,,,,, uint128 remaining) = auction.auctions(aId);
        assertEq(remaining, 900e18);

        vm.prank(carol);
        auction.fill{value: 1 ether}(aId, 100e18);
        assertEq(tok.balanceOf(carol), 100e18);

        (,,,,,,, remaining) = auction.auctions(aId);
        assertEq(remaining, 800e18);
    }

    function testFillERC20PartialPriceDecays() public {
        uint256 aId = _listERC20(1000e18, 10 ether, 0, 1 hours);
        uint40 startT = uint40(block.timestamp);

        vm.warp(startT + 30 minutes); // total price = 5 ETH

        uint256 aliceBefore = alice.balance;
        vm.prank(bob);
        auction.fill{value: 1 ether}(aId, 200e18); // cost = 5e18 * 200e18 / 1000e18 = 1 ETH

        assertEq(tok.balanceOf(bob), 200e18);
        assertEq(alice.balance, aliceBefore + 1 ether);
    }

    function testFillERC20RefundsExcess() public {
        uint256 aId = _listERC20(1000e18, 10 ether, 0, 1 hours);

        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        auction.fill{value: 5 ether}(aId, 100e18); // cost = 1 ETH

        assertEq(bob.balance, bobBefore - 1 ether);
    }

    function testFillERC20RevertsOverRemaining() public {
        uint256 aId = _listERC20(1000e18, 10 ether, 0, 1 hours);
        vm.prank(bob);
        vm.expectRevert(DutchAuction.Bad.selector);
        auction.fill{value: 100 ether}(aId, 1001e18);
    }

    function testFillERC20RevertsZeroTake() public {
        uint256 aId = _listERC20(1000e18, 10 ether, 0, 1 hours);
        vm.prank(bob);
        vm.expectRevert(DutchAuction.Bad.selector);
        auction.fill{value: 10 ether}(aId, 0);
    }

    function testFillERC20RevertsInsufficient() public {
        uint256 aId = _listERC20(1000e18, 10 ether, 0, 1 hours);
        vm.prank(bob);
        vm.expectRevert(DutchAuction.Insufficient.selector);
        auction.fill{value: 0.5 ether}(aId, 100e18); // cost = 1 ETH
    }

    /*──────────────── cancel ────────────────*/

    function testCancelNFT() public {
        uint256 aId = _listOneNFT(7, 10 ether, 0, 1 hours);
        vm.prank(alice);
        auction.cancel(aId);

        assertEq(nft.ownerOf(7), alice);
        (address seller,,,,,,,) = auction.auctions(aId);
        assertEq(seller, address(0));
    }

    function testCancelERC20Full() public {
        uint256 aId = _listERC20(1000e18, 10 ether, 0, 1 hours);
        vm.prank(alice);
        auction.cancel(aId);

        assertEq(tok.balanceOf(alice), 1000e18);
    }

    function testCancelERC20AfterPartialFill() public {
        uint256 aId = _listERC20(1000e18, 10 ether, 0, 1 hours);
        vm.prank(bob);
        auction.fill{value: 2 ether}(aId, 200e18);

        vm.prank(alice);
        auction.cancel(aId);

        assertEq(tok.balanceOf(alice), 800e18); // reclaim remaining
        assertEq(tok.balanceOf(bob), 200e18);
    }

    function testCancelRevertsNotSeller() public {
        uint256 aId = _listOneNFT(7, 10 ether, 0, 1 hours);
        vm.prank(bob);
        vm.expectRevert(DutchAuction.NotSeller.selector);
        auction.cancel(aId);
    }

    function testCancelRevertsTwice() public {
        uint256 aId = _listOneNFT(7, 10 ether, 0, 1 hours);
        vm.prank(alice);
        auction.cancel(aId);

        vm.prank(alice);
        vm.expectRevert(DutchAuction.NotSeller.selector);
        auction.cancel(aId);
    }

    function testFillAfterCancelReverts() public {
        uint256 aId = _listOneNFT(7, 10 ether, 0, 1 hours);
        vm.prank(alice);
        auction.cancel(aId);

        vm.prank(bob);
        vm.expectRevert(DutchAuction.Bad.selector);
        auction.fill{value: 10 ether}(aId, 0);
    }

    /*──────────────── events ────────────────*/

    event Created(uint256 indexed id, address indexed seller);
    event Filled(uint256 indexed id, address indexed buyer, uint256 amount, uint256 paid);
    event Cancelled(uint256 indexed id);

    function testEmitsCreatedOnListNFT() public {
        nft.mint(alice, 1);
        vm.startPrank(alice);
        nft.setApprovalForAll(address(auction), true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.expectEmit(true, true, false, false);
        emit Created(0, alice);
        auction.listNFT(address(nft), ids, 1 ether, 0, 0, 1 hours);
        vm.stopPrank();
    }

    function testEmitsFilledOnNFTFill() public {
        uint256 aId = _listOneNFT(7, 10 ether, 0, 1 hours);
        vm.expectEmit(true, true, false, true);
        emit Filled(aId, bob, 1, 10 ether);
        vm.prank(bob);
        auction.fill{value: 10 ether}(aId, 0);
    }

    function testEmitsFilledOnERC20Partial() public {
        uint256 aId = _listERC20(1000e18, 10 ether, 0, 1 hours);
        vm.expectEmit(true, true, false, true);
        emit Filled(aId, bob, 100e18, 1 ether);
        vm.prank(bob);
        auction.fill{value: 1 ether}(aId, 100e18);
    }

    function testEmitsCancelled() public {
        uint256 aId = _listOneNFT(7, 10 ether, 0, 1 hours);
        vm.expectEmit(true, false, false, false);
        emit Cancelled(aId);
        vm.prank(alice);
        auction.cancel(aId);
    }

    /*──────────────── reentrancy guard ────────────────*/

    function testReentrancyGuardBlocksFillRecurse() public {
        ReentrantSeller rs = new ReentrantSeller(auction);
        nft.mint(address(rs), 11);
        vm.startPrank(address(rs));
        nft.setApprovalForAll(address(auction), true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 11;
        uint256 aId = auction.listNFT(address(nft), ids, 1 ether, 0, 0, 1 hours);
        vm.stopPrank();
        rs.setTarget(aId);

        // Fill pushes ETH to ReentrantSeller → receive() calls fill() → guard reverts →
        // _pay propagates the failure as TransferFailed.
        vm.prank(bob);
        vm.expectRevert(DutchAuction.TransferFailed.selector);
        auction.fill{value: 1 ether}(aId, 0);
    }

    /*──────────────── fuzz ────────────────*/

    function testFuzzPriceMonotonicDecay(uint128 startP, uint128 endP, uint40 dur, uint32 dt) public {
        vm.assume(startP >= endP && dur > 0);
        uint40 startT = uint40(block.timestamp);

        nft.mint(alice, 999);
        vm.startPrank(alice);
        nft.setApprovalForAll(address(auction), true);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 999;
        uint256 aId = auction.listNFT(address(nft), ids, startP, endP, 0, dur);
        vm.stopPrank();

        uint256 p0 = auction.priceOf(aId);
        assertEq(p0, startP);

        vm.warp(startT + dt);
        uint256 p1 = auction.priceOf(aId);
        assertLe(p1, startP);
        assertGe(p1, endP);
    }

    /// @dev Regression: with floor division, buyer could take initial >> price and get 0 cost.
    ///      Ceiling division must charge at least 1 wei for any nonzero take.
    function testERC20PartialFillNoFreeTakes() public {
        uint128 initial = 1e24; // huge supply
        uint256 aId = _listERC20(initial, 1e18, 0, 1 hours); // price = 1 ETH = 1e18 wei
        // price/initial = 1e-6 ETH per unit; take=1 under floor division → cost=0
        vm.prank(bob);
        vm.expectRevert(DutchAuction.Insufficient.selector);
        auction.fill{value: 0}(aId, 1);
    }

    function testFuzzERC20PartialFillPayout(uint64 take) public {
        uint128 initial = 1000e18;
        vm.assume(take > 0 && take <= initial);

        uint256 aId = _listERC20(initial, 10 ether, 0, 1 hours);
        uint40 startT = uint40(block.timestamp);
        vm.warp(startT + 30 minutes); // price = 5 ETH

        uint256 expectedCost = (uint256(5 ether) * take + initial - 1) / initial;

        uint256 aliceBefore = alice.balance;
        vm.prank(bob);
        auction.fill{value: expectedCost}(aId, take);

        assertEq(tok.balanceOf(bob), take);
        assertEq(alice.balance, aliceBefore + expectedCost);
    }
}
