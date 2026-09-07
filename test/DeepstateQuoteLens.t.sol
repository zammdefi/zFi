// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import "forge-std/Test.sol";
import {DeepstateQuoteLens} from "../src/DeepstateQuoteLens.sol";

interface IDeepstate {
    struct FillParams {
        address token0;
        address token1;
        uint256 epoch;
        bytes32 order;
        bool isBid;
        bool noRest;
        bool fillOrKill;
    }
    function fill(FillParams calldata params) external payable returns (bytes32 restingOrder);
    function topOrder(bytes32 id, bool isBid) external view returns (uint32 nonce, uint160 soldAmount);
    function roots(address t0, address t1, uint256 epoch) external view returns (bytes32, bytes32);
    function poolId(address t0, address t1) external pure returns (bytes32);
    function poolEpoch(bytes32 pid) external view returns (uint256);
    function bookId(address t0, address t1, uint256 epoch) external view returns (bytes32);
    function tree(bytes32 id, bytes32 node) external view returns (bytes32, bytes32);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @notice The Deepstate lens, checked against Deepstate itself.
///
/// @dev A quote that is merely plausible is the failure mode here: it would sit
///      in the dropdown looking like a price and fill at something else. So this
///      does not assert the lens against a number I computed - it asserts it
///      against the exchange, twice over.
///
///      1. `topOrder` returns a bid's `soldAmount`, which Deepstate computes with
///         ITS OWN tick math. The lens reimplements that math from the published
///         identity rather than copying their UNLICENSED library, so reproducing
///         that number exactly is the test that the reimplementation is right.
///      2. Then the real `fill` is executed against a forked book and the tokens
///         actually received are compared with what the lens said. That is the
///         only assertion that covers the walk, the ordering and the fee at once.
contract DeepstateQuoteLensTest is Test {
    IDeepstate constant DS = IDeepstate(0x6cf19308C22FC82ea620Fa0B3E94948d20f27B96);
    address constant DEEP = 0x1DA24f6Bb623b9d1aFEae3F3146659A2662D6d27;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    /// @dev Deepstate's protocol fee, read once and asserted, not assumed.
    uint256 constant FEE_BPS = 10;

    DeepstateQuoteLens lens;
    address taker = makeAddr("taker");

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")));
        lens = new DeepstateQuoteLens();
        (bool ok, bytes memory ret) = address(DS).staticcall(abi.encodeWithSignature("feeConfig()"));
        require(ok, "feeConfig");
        (, uint256 bps) = abi.decode(ret, (address, uint256));
        assertEq(bps, FEE_BPS, "the fee moved; every expectation below assumes it");
    }

    function _book(address a, address b) internal view returns (address t0, address t1, uint256 epoch, bytes32 id) {
        (t0, t1) = uint160(a) < uint160(b) ? (a, b) : (b, a);
        epoch = DS.poolEpoch(DS.poolId(t0, t1));
        id = DS.bookId(t0, t1, epoch);
    }

    /// @dev The reimplemented tick math against Deepstate's own, on live books.
    ///      `soldAmount` for a bid IS their `_quoteValue(price, quantity)`.
    function testTickMathMatchesDeepstateOnLiveBooks() public view {
        address[2] memory bases = [DEEP, NVDA];
        uint256 checked;
        for (uint256 i; i < 2; ++i) {
            (address t0, address t1, uint256 epoch, bytes32 id) = _book(bases[i], USDG);
            (, bytes32 bidRoot) = DS.roots(t0, t1, epoch);
            if (bidRoot == bytes32(0)) continue;
            (, uint160 sold) = DS.topOrder(id, true);
            if (sold == 0) continue;
            // Walk to the best bid leaf and value it with the lens's own math.
            bytes32 node = bidRoot;
            for (uint256 s; s < 32; ++s) {
                (bytes32 l, bytes32 r) = DS.tree(id, node);
                if (l == bytes32(0)) break;
                node = r == bytes32(0) ? l : r;
            }
            (int32 tick, uint256 qty) = lensPriceAndQuantity(node);
            assertEq(lensQuoteValue(tick, qty, true), uint256(sold), "lens tick math differs from Deepstate's");
            ++checked;
        }
        assertGt(checked, 0, "no live bid book to check against");
    }

    /// @dev THE ONE THAT MATTERS: quote, then actually fill, then compare.
    function testQuoteMatchesARealFill() public {
        (address t0, address t1, uint256 epoch,) = _book(DEEP, USDG);
        assertEq(t0, DEEP, "DEEP should sort first");

        // Sell DEEP into the bids. A taker ask: isBid = false, quantity in token0.
        uint256 sell = 5_000e18;
        (uint256 quotedOut, uint256 quotedIn) = lens.quoteDeep(DEEP, USDG, sell);
        if (quotedOut == 0) {
            emit log("bid side empty on this fork - nothing to compare");
            return;
        }
        emit log_named_uint("lens says out (USDG)", quotedOut);
        emit log_named_uint("lens says in  (DEEP)", quotedIn);

        deal(DEEP, taker, sell);
        vm.startPrank(taker);
        IERC20(DEEP).approve(address(DS), type(uint256).max);
        uint256 before = IERC20(USDG).balanceOf(taker);
        // Aggressive limit: the most negative tick still accepts any bid price.
        bytes32 order = bytes32((uint256(uint32(type(int32).min)) << 224) | (quotedIn << 64));
        DS.fill(IDeepstate.FillParams({
            token0: t0, token1: t1, epoch: epoch, order: order,
            isBid: false, noRest: true, fillOrKill: false
        }));
        uint256 got = IERC20(USDG).balanceOf(taker) - before;
        vm.stopPrank();

        emit log_named_uint("real fill gave (USDG)", got);
        assertGt(got, 0, "the real fill returned nothing");
        // Exact is the goal; allow 1 wei for rounding direction on the last leaf.
        assertApproxEqAbs(quotedOut, got, 1, "lens quote and real fill disagree");
    }

    /// @dev The other direction: a taker BID lifting the asks. Buying is where the
    ///      partial-leaf inverse (`_baseForQuote`) runs, and that arithmetic has
    ///      no counterpart in the sell path - so a sell-only test would leave it
    ///      entirely unexercised.
    function testBuyDirectionMatchesARealFill() public {
        (address t0, address t1, uint256 epoch,) = _book(DEEP, USDG);
        uint256 spend = 500e6; // USDG
        (uint256 quotedOut, uint256 quotedIn) = lens.quoteDeep(USDG, DEEP, spend);
        if (quotedOut == 0) { emit log("ask side empty on this fork"); return; }
        emit log_named_uint("buy: lens out (DEEP)", quotedOut);
        emit log_named_uint("buy: lens in  (USDG)", quotedIn);

        deal(USDG, taker, spend);
        vm.startPrank(taker);
        IERC20(USDG).approve(address(DS), type(uint256).max);
        uint256 before = IERC20(DEEP).balanceOf(taker);
        // A taker bid names the base quantity to MATCH, and the protocol fee is
        // taken from that afterwards - so the order must ask for the pre-fee
        // amount. Passing the lens's (post-fee) answer here taxes it twice, which
        // is what the first version of this test did and why it read as the lens
        // over-promising by exactly 10 bps.
        uint256 matchQty = (quotedOut * 10_000) / (10_000 - FEE_BPS);
        bytes32 order = bytes32((uint256(uint32(type(int32).max)) << 224) | (matchQty << 64));
        DS.fill(IDeepstate.FillParams({
            token0: t0, token1: t1, epoch: epoch, order: order,
            isBid: true, noRest: true, fillOrKill: false
        }));
        uint256 got = IERC20(DEEP).balanceOf(taker) - before;
        vm.stopPrank();
        emit log_named_uint("buy: real fill gave (DEEP)", got);
        assertGt(got, 0, "the real buy returned nothing");
        // The fee is taken from taker output, so the lens must not over-promise.
        // Tight: this is arithmetic, not an estimate. Only last-leaf rounding
        // and the fee's integer division may differ.
        assertApproxEqRel(quotedOut, got, 0.000001e18, "buy quote differs from the fill");
    }

    /// @dev More than the book holds must be a partial, never a revert and never
    ///      an invented amount. `amountUsed` is what says so.
    function testOversizedSellIsAPartialFill() public view {
        (uint256 out, uint256 used) = lens.quoteDeep(DEEP, USDG, 1e30);
        if (out == 0) return;
        assertLt(used, 1e30, "the whole input cannot have been absorbed");
        assertGt(out, 0);
    }

    /// @dev A pair with no book is no route, not a revert.
    function testPairWithNoBookIsNoRoute() public view {
        (uint256 out, uint256 used) = lens.quoteDeep(address(0), USDG, 1 ether);
        assertEq(out, 0);
        assertEq(used, 0);
        (out, used) = lens.quoteDeep(DEEP, DEEP, 1e18);
        assertEq(out, 0);
        assertEq(used, 0);
    }

    /// @dev The strongest form of the differential: take the order word the lens
    ///      RETURNS and hand it to `fill` unaltered, exactly as the router would.
    ///      This is what proves quote and execution name the same trade - the two
    ///      tests above still reconstruct the order themselves, and a caller that
    ///      reconstructs it slightly differently is the failure this closes.
    function testReturnedOrderWordReproducesTheQuote() public {
        // Sell side.
        (address t0, address t1, uint256 epoch,) = _book(DEEP, USDG);
        (uint256 qOut, uint256 qUsed, uint256 qEpoch, bytes32 word, bool isBid) =
            lens.quoteDeepRoute(DEEP, USDG, 5_000e18);
        if (qOut != 0) {
            assertEq(qEpoch, epoch, "epoch");
            assertFalse(isBid, "selling token0 is a taker ask");
            deal(DEEP, taker, qUsed);
            vm.startPrank(taker);
            IERC20(DEEP).approve(address(DS), type(uint256).max);
            uint256 before = IERC20(USDG).balanceOf(taker);
            DS.fill(IDeepstate.FillParams({
                token0: t0, token1: t1, epoch: qEpoch, order: word,
                isBid: isBid, noRest: true, fillOrKill: false
            }));
            assertEq(IERC20(USDG).balanceOf(taker) - before, qOut, "sell: returned word did not reproduce the quote");
            vm.stopPrank();
        }

        // Buy side, through the same returned word.
        (qOut, qUsed, qEpoch, word, isBid) = lens.quoteDeepRoute(USDG, DEEP, 500e6);
        if (qOut == 0) return;
        assertTrue(isBid, "buying token0 is a taker bid");
        deal(USDG, taker, qUsed);
        vm.startPrank(taker);
        IERC20(USDG).approve(address(DS), type(uint256).max);
        uint256 b2 = IERC20(DEEP).balanceOf(taker);
        DS.fill(IDeepstate.FillParams({
            token0: t0, token1: t1, epoch: qEpoch, order: word,
            isBid: isBid, noRest: true, fillOrKill: false
        }));
        assertEq(IERC20(DEEP).balanceOf(taker) - b2, qOut, "buy: returned word did not reproduce the quote");
        vm.stopPrank();
    }

    /// @dev The hooked book. USDG/NVDA carries a hook, and the lens used to
    ///      decline it on the assumption that a hook can move the outcome - true
    ///      of Uniswap v4, false here. `IHook.execute` returns nothing, runs after
    ///      the book mutation, and is called under a gas cap in `try/catch`. If
    ///      that reading is right the quote must match the fill exactly, same as
    ///      an unhooked book; if it is wrong, this test is what says so.
    function testHookedBookMatchesARealFill() public {
        (address t0, address t1, uint256 epoch, bytes32 id) = _book(NVDA, USDG);
        (bool ok, bytes memory ret) = address(DS).staticcall(
            abi.encodeWithSignature("poolHook(bytes32)", DS.poolId(t0, t1)));
        require(ok, "poolHook");
        assertTrue(abi.decode(ret, (address)) != address(0), "this test is pointless unless the book is hooked");
        id; // silence

        // Sell NVDA into the bids. token0 is USDG, so selling NVDA is a taker bid
        // buying token0 - the direction that exercises the partial-leaf inverse.
        (uint256 qOut, uint256 qUsed, uint256 qEpoch, bytes32 word, bool isBid) =
            lens.quoteDeepRoute(NVDA, USDG, 1e17);
        if (qOut == 0) { emit log("no reachable side on this fork"); return; }
        assertEq(qEpoch, epoch, "epoch");
        emit log_named_uint("hooked book: lens out (USDG)", qOut);

        deal(NVDA, taker, qUsed);
        vm.startPrank(taker);
        IERC20(NVDA).approve(address(DS), type(uint256).max);
        uint256 before = IERC20(USDG).balanceOf(taker);
        DS.fill(IDeepstate.FillParams({
            token0: t0, token1: t1, epoch: qEpoch, order: word,
            isBid: isBid, noRest: true, fillOrKill: false
        }));
        uint256 got = IERC20(USDG).balanceOf(taker) - before;
        vm.stopPrank();
        emit log_named_uint("hooked book: real fill  (USDG)", got);
        assertEq(qOut, got, "a hook moved the fill - the lens must decline hooked books after all");
    }

    /// @dev A third book, found by scanning rather than assumed: STATE is
    ///      Deepstate's own governance token and is not listed on zSwap. Before
    ///      recommending it, the quote has to hold against a real fill like the
    ///      others - a market nobody has traded through our path yet is exactly
    ///      where a walk bug would hide.
    function testThirdBookMatchesARealFill() public {
        address STATE = 0xbfb7b3Ff3D498a559b946B836d26F0E168f273D5;
        (address t0, address t1, uint256 epoch,) = _book(STATE, USDG);
        (uint256 qOut, uint256 qUsed, uint256 qEpoch, bytes32 word, bool isBid) =
            lens.quoteDeepRoute(STATE, USDG, 10_000e18);
        if (qOut == 0) { emit log("STATE book empty on this fork"); return; }
        assertEq(qEpoch, epoch, "epoch");
        emit log_named_uint("STATE: lens out (USDG)", qOut);
        deal(STATE, taker, qUsed);
        vm.startPrank(taker);
        IERC20(STATE).approve(address(DS), type(uint256).max);
        uint256 before = IERC20(USDG).balanceOf(taker);
        DS.fill(IDeepstate.FillParams({
            token0: t0, token1: t1, epoch: qEpoch, order: word,
            isBid: isBid, noRest: true, fillOrKill: false
        }));
        uint256 got = IERC20(USDG).balanceOf(taker) - before;
        vm.stopPrank();
        emit log_named_uint("STATE: real fill  (USDG)", got);
        assertEq(qOut, got, "STATE quote and real fill disagree");
    }

    // --- mirrors of the lens internals, so the math can be asserted directly ---
    function lensPriceAndQuantity(bytes32 node) internal pure returns (int32 tick, uint256 qty) {
        assembly ("memory-safe") {
            tick := signextend(3, shr(224, node))
            qty := and(shr(64, node), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }
    function lensQuoteValue(int32 tick, uint256 q, bool up) internal view returns (uint256) {
        return DeepstateQuoteLensHarness(address(lens)).quoteValue(tick, q, up);
    }
}

interface DeepstateQuoteLensHarness {
    function quoteValue(int32, uint256, bool) external view returns (uint256);
}
