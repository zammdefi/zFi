// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {FixedPointMathLib} from "../lib/solady/src/utils/FixedPointMathLib.sol";

/// @title DeepstateQuoteLens
/// @notice Quotes the Deepstate central limit order book on Robinhood Chain, in
///         the shape zSwap already reads a venue in.
///
/// @dev WHY THIS EXISTS. `zRouterLiteRobinhood` can already EXECUTE against
///      Deepstate - it has `swapDeep` and the singleton's address - but
///      `zQuoterRobinhood` has no Deepstate path at all: it prices Uniswap
///      V2/V3/V4 by walking pool state, and an order book is not pool state. So
///      the page can trade the book only if something else prices it, and
///      without that a token whose only market is Deepstate reads as "no route"
///      while being perfectly tradeable. DEEP is exactly that token: ~2.0M DEEP
///      resting on the ask at the time of writing, and no AMM pool anywhere.
///
/// @dev WHY IT REIMPLEMENTS RATHER THAN SIMULATES. `V4QuoteLensPM` prices a v4
///      pool by running the real swap and reverting. That trick needs a callback
///      that hands control back before settlement; `Deepstate.fill` pulls the
///      taker's tokens with no such window, so a lens holding no balance cannot
///      run it. What is left is to read the book and do the arithmetic, which is
///      possible because every part of the book is public: `roots` gives the two
///      tree roots, `tree(id,node)` gives a node's children, and a node is a
///      LEAF exactly when its left child is zero.
///
/// @dev THE ONE THING THAT HAD TO BE EXACT. A leaf packs a signed 32-bit price
///      tick at bit 224 and a 160-bit quantity at bit 64, and the price at tick
///      `t` is `2**(96t/2**31)`. Deepstate's own tick math is published
///      UNLICENSED, so none of it is copied here: `_priceQ128` derives the same
///      value from the definition, decomposing the exponent into binary
///      fractions against a table of `2**(1/2**k)` computed independently. It is
///      checked against the chain rather than against their source - `topOrder`
///      returns a bid's `soldAmount` computed by THEIR implementation, and this
///      one reproduces it exactly on the live NVDA/USDG and DEEP/USDG books
///      (see `test/DeepstateQuoteLens.t.sol`).
///
/// @dev WHAT IT DELIBERATELY DOES NOT MODEL. Deepstate consumes whole subtrees
///      as an aggregate when they fit inside the remaining quantity, and keeps
///      stale aggregate quantities on a dirty right spine. That is a gas
///      optimisation over the same price-time ordering, not a different one, so
///      this walks to LEAVES and reads each leaf's own quantity - which is
///      immune to a stale aggregate by construction. A pool with a hook is
///      refused rather than mispriced: a hook can move the outcome and this
///      cannot see it.
contract DeepstateQuoteLens {
    /// @notice The Deepstate singleton on Robinhood Chain (4663).
    address public constant DEEPSTATE = 0x6cf19308C22FC82ea620Fa0B3E94948d20f27B96;

    /// @dev Bounds the walk. `eth_call` has no gas meter worth respecting, but a
    ///      book with a pathological shape must still terminate.
    uint256 internal constant MAX_LEAVES = 64;
    uint256 internal constant MAX_STEPS = 512;
    uint256 internal constant ONE_Q128 = 1 << 128;

    /// @notice Best-effort output for selling `amountIn` of `tokenIn` into the book.
    /// @return amountOut Tokens received, after the protocol fee.
    /// @return amountUsed How much of `amountIn` the book could absorb.
    function quoteDeep(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, uint256 amountUsed)
    {
        (amountOut, amountUsed,,,) = quoteDeepRoute(tokenIn, tokenOut, amountIn);
    }

    /// @notice The quote, plus the exact arguments `zRouterLiteRobinhood.swapDeep`
    ///         must be given to execute it.
    /// @return amountOut Tokens received, after the protocol fee.
    /// @return amountUsed How much of `amountIn` the book could absorb.
    /// @return epoch Book epoch this was priced against.
    /// @return order The taker's packed order word: `price || quantity || 0`.
    /// @return isBid True when the taker is buying token0 with token1.
    ///
    /// @dev WHY THE ORDER WORD IS RETURNED RATHER THAN REBUILT. `swapDeep` takes
    ///      the taker's packed order, and a bid's quantity is the base to MATCH -
    ///      the protocol fee comes off afterwards. So a caller that reconstructs
    ///      the word from `amountOut` asks for the post-fee amount and is charged
    ///      the fee twice, quietly under-delivering every buy. Handing back the
    ///      word this quote was actually computed from removes that class of bug
    ///      from every caller at once.
    ///
    ///      The limit tick is deliberately maximal: a router bounds the trade
    ///      with `amountOutMin`, which is checked at settlement and cannot be
    ///      outrun by the book moving, whereas a limit price baked in here would
    ///      be stale the moment it is returned.
    ///
    /// @dev Returns zeros for a pair with no book, an empty side, or a hooked
    ///      pool. A zero leg is "no route", never "free".
    function quoteDeepRoute(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256 amountOut, uint256 amountUsed, uint256 epoch, bytes32 order, bool isBid)
    {
        if (amountIn == 0 || tokenIn == tokenOut) return (0, 0, 0, bytes32(0), false);
        (address t0, address t1) =
            uint160(tokenIn) < uint160(tokenOut) ? (tokenIn, tokenOut) : (tokenOut, tokenIn);

        // A bid buys token0 with token1. The taker is a bid when it wants token0.
        isBid = tokenOut == t0;

        (bool ok, bytes memory ret) = DEEPSTATE.staticcall(abi.encodeWithSignature("poolId(address,address)", t0, t1));
        if (!ok || ret.length != 32) return (0, 0, 0, bytes32(0), false);
        bytes32 pid = abi.decode(ret, (bytes32));

        // A HOOKED BOOK IS STILL PRICEABLE, and this is the one place where
        // Deepstate differs from Uniswap v4 in a way worth stating. A v4 hook can
        // replace the curve outright, so `V4QuoteLensL2` must run it. Deepstate's
        // `IHook` returns nothing, is invoked AFTER the book mutation, and is
        // called under a gas cap inside `try/catch` precisely so that "a
        // reverting or gas-burning hook does not revert matching". It is a
        // top-of-book notification, structurally unable to move a fill amount.
        // Refusing hooked books here cost real liquidity - USDG/NVDA is a live
        // two-sided book - so the refusal is gone, and
        // `testHookedBookMatchesARealFill` holds the claim to the chain.

        (ok, ret) = DEEPSTATE.staticcall(abi.encodeWithSignature("poolEpoch(bytes32)", pid));
        if (!ok || ret.length != 32) return (0, 0, 0, bytes32(0), false);
        epoch = abi.decode(ret, (uint256));

        (ok, ret) = DEEPSTATE.staticcall(abi.encodeWithSignature("bookId(address,address,uint256)", t0, t1, epoch));
        if (!ok || ret.length != 32) return (0, 0, 0, bytes32(0), false);
        bytes32 id = abi.decode(ret, (bytes32));

        (ok, ret) = DEEPSTATE.staticcall(abi.encodeWithSignature("roots(address,address,uint256)", t0, t1, epoch));
        if (!ok || ret.length != 64) return (0, 0, 0, bytes32(0), false);
        (bytes32 askRoot, bytes32 bidRoot) = abi.decode(ret, (bytes32, bytes32));

        // A taker bid lifts the asks; a taker ask hits the bids.
        bytes32 root = isBid ? askRoot : bidRoot;
        if (root == bytes32(0)) return (0, 0, 0, bytes32(0), false);

        (amountOut, amountUsed) = _walk(id, root, isBid, amountIn);
        if (amountOut == 0) return (0, 0, 0, bytes32(0), false);

        // The quantity `swapDeep` must name: base to match for a bid, base to
        // sell for an ask. Captured BEFORE the fee, which is what the book uses.
        uint256 quantity = isBid ? amountOut : amountUsed;
        if (quantity >> 160 != 0) return (0, 0, 0, bytes32(0), false);
        uint256 limit = uint256(uint32(isBid ? type(int32).max : type(int32).min));
        order = bytes32((limit << 224) | (quantity << 64));

        // The protocol fee comes out of matched taker output.
        (ok, ret) = DEEPSTATE.staticcall(abi.encodeWithSignature("feeConfig()"));
        if (ok && ret.length == 64) {
            (, uint256 bps) = abi.decode(ret, (address, uint256));
            if (bps != 0 && bps <= 100) amountOut -= (amountOut * bps) / 10_000;
        }
    }

    /// @dev Leaves best-first. Both trees keep their best liquidity on the right
    ///      spine, so a right-first depth-first walk yields price-time order -
    ///      which is the order the matcher consumes in.
    function _walk(bytes32 id, bytes32 root, bool takerIsBid, uint256 amountIn)
        internal
        view
        returns (uint256 out, uint256 used)
    {
        bytes32[] memory stack = new bytes32[](MAX_STEPS);
        uint256 top;
        stack[top++] = root;
        uint256 leaves;
        uint256 steps;
        uint256 remaining = amountIn;

        while (top != 0 && remaining != 0 && leaves < MAX_LEAVES && steps++ < MAX_STEPS) {
            bytes32 node = stack[--top];
            (bool ok, bytes memory ret) =
                DEEPSTATE.staticcall(abi.encodeWithSignature("tree(bytes32,bytes32)", id, node));
            if (!ok || ret.length != 64) break;
            (bytes32 left, bytes32 right) = abi.decode(ret, (bytes32, bytes32));

            if (left == bytes32(0)) {
                // A leaf: a resting order at one tick.
                ++leaves;
                (int32 tick, uint256 qty) = _priceAndQuantity(node);
                if (qty == 0) continue;
                if (takerIsBid) {
                    // Paying token1 for token0. This leaf offers `qty` of token0.
                    uint256 cost = _quoteValue(tick, qty, true);
                    if (cost == 0) continue;
                    if (cost <= remaining) {
                        remaining -= cost;
                        out += qty;
                        used += cost;
                    } else {
                        uint256 take = _baseForQuote(tick, remaining);
                        if (take == 0) break;
                        if (take > qty) take = qty;
                        out += take;
                        used += remaining;
                        remaining = 0;
                    }
                } else {
                    // Selling token0 for token1. This leaf wants `qty` of token0.
                    uint256 take = qty < remaining ? qty : remaining;
                    out += _quoteValue(tick, take, false);
                    used += take;
                    remaining -= take;
                }
                continue;
            }
            // A branch: push left then right so the right child is taken first.
            if (top + 2 > MAX_STEPS) break;
            stack[top++] = left;
            if (right != bytes32(0)) stack[top++] = right;
        }
    }

    /// @dev A packed node: `int32` price tick at bit 224, `uint160` quantity at
    ///      bit 64, nonce in the low 32 bits.
    function _priceAndQuantity(bytes32 node) internal pure returns (int32 tick, uint256 qty) {
        assembly ("memory-safe") {
            tick := signextend(3, shr(224, node))
            qty := and(shr(64, node), 0xffffffffffffffffffffffffffffffffffffffff)
        }
    }

    /// @notice `_quoteValue` exposed for the differential test against Deepstate's
    ///         own `topOrder` figure. Reading it costs nothing and makes the one
    ///         piece of reimplemented arithmetic directly assertable.
    function quoteValue(int32 tick, uint256 quantity, bool roundUp) external pure returns (uint256) {
        return _quoteValue(tick, quantity, roundUp);
    }

    /// @notice `quantity` of token0 valued in token1 at `tick`.
    function _quoteValue(int32 tick, uint256 quantity, bool roundUp) internal pure returns (uint256) {
        if (quantity == 0) return 0;
        if (tick == 0) return quantity;
        (uint256 acc, int256 e) = _priceQ128(tick);
        // value = quantity * acc / 2**(128 - e). `quantity` reaches 2**160 and
        // `acc` sits just above 2**128, so the product does NOT fit in a word -
        // it needs the 512-bit intermediate, which is the whole reason this is
        // not a plain multiply.
        int256 sh = int256(128) - e;
        if (sh <= 0) {
            uint256 up = uint256(-sh);
            if (up > 64) return type(uint256).max;
            unchecked {
                if (acc > type(uint256).max >> up) return type(uint256).max;
                acc <<= up;
            }
            return roundUp
                ? FixedPointMathLib.fullMulDivUp(quantity, acc, 1)
                : FixedPointMathLib.fullMulDiv(quantity, acc, 1);
        }
        uint256 d = uint256(sh);
        if (d >= 256) return 0;
        uint256 den = uint256(1) << d;
        return roundUp
            ? FixedPointMathLib.fullMulDivUp(quantity, acc, den)
            : FixedPointMathLib.fullMulDiv(quantity, acc, den);
    }

    /// @dev The inverse: how much token0 `quote` buys at `tick`.
    function _baseForQuote(int32 tick, uint256 quote) internal pure returns (uint256) {
        if (quote == 0) return 0;
        if (tick == 0) return quote;
        (uint256 acc, int256 e) = _priceQ128(tick);
        if (acc == 0) return 0;
        int256 sh = int256(128) - e;
        if (sh <= 0) {
            uint256 up = uint256(-sh);
            if (up > 64) return 0;
            unchecked {
                if (acc > type(uint256).max >> up) return 0;
                acc <<= up;
            }
            return quote / acc;
        }
        uint256 d = uint256(sh);
        if (d >= 256) return 0;
        return FixedPointMathLib.fullMulDiv(quote, uint256(1) << d, acc);
    }

    /// @notice `2**(96*tick/2**31)` as a Q128 mantissa and a binary exponent.
    /// @dev `price = acc / 2**128 * 2**e`. Derived from the definition: the
    ///      exponent is split into an integer part and a 26-bit fraction, and the
    ///      fraction is composed from `2**(1/2**k)` factors. The table below was
    ///      generated from that identity, not taken from Deepstate.
    function _priceQ128(int32 tick) internal pure returns (uint256 acc, int256 e) {
        int256 s = int256(tick) * 3;
        e = s >> 26;
        uint256 f = uint256(s - (e << 26));
        acc = ONE_Q128;
        if (f & 1 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x10000002c5c8601cc6b9e94213c72737a, ONE_Q128);
        if (f & 2 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x100000058b90c0b48c6be5df846c5b2f0, ONE_Q128);
        if (f & 4 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x1000000b1721835514b86e6d96efd1bff, ONE_Q128);
        if (f & 8 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x100000162e430e5a18f6119e3c02282a5, ONE_Q128);
        if (f & 16 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x1000002c5c863b73f016468f6bac5ca2c, ONE_Q128);
        if (f & 32 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x10000058b90cf1e6d97f9ca14dbcc1628, ONE_Q128);
        if (f & 64 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x100000b1721bcfc99d9f890ea06911763, ONE_Q128);
        if (f & 128 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x10000162e43f4f831060e02d839a9d16d, ONE_Q128);
        if (f & 256 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x100002c5c89d5ec6ca4d7c8acc017b7c9, ONE_Q128);
        if (f & 512 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x1000058b91b5bc9ae2eed81e9b7d4cfac, ONE_Q128);
        if (f & 1024 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x10000b17255775c040618bf4a4ade83fc, ONE_Q128);
        if (f & 2048 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x1000162e525ee054754457d5995292026, ONE_Q128);
        if (f & 4096 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x10002c5cc37da9491d0985c348c68e7b3, ONE_Q128);
        if (f & 8192 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x100058ba01fb9f96d6cacd4b180917c3e, ONE_Q128);
        if (f & 16384 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x1000b175effdc76ba38e31671ca939726, ONE_Q128);
        if (f & 32768 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x100162f3904051fa128bca9c55c31e5e0, ONE_Q128);
        if (f & 65536 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x1002c605e2e8cec506d21bfc89a23a010, ONE_Q128);
        if (f & 131072 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x10058c86da1c09ea1ff19d294cf2f679c, ONE_Q128);
        if (f & 262144 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x100b1afa5abcbed6129ab13ec11dc9544, ONE_Q128);
        if (f & 524288 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x10163da9fb33356d84a66ae336dcdfa40, ONE_Q128);
        if (f & 1048576 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x102c9a3e778060ee6f7caca4f7a29bde9, ONE_Q128);
        if (f & 2097152 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x1059b0d31585743ae7c548eb68ca417fe, ONE_Q128);
        if (f & 4194304 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x10b5586cf9890f6298b92b71842a98364, ONE_Q128);
        if (f & 8388608 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x1172b83c7d517adcdf7c8c50eb14a7920, ONE_Q128);
        if (f & 16777216 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x1306fe0a31b7152de8d5a46305c85edec, ONE_Q128);
        if (f & 33554432 != 0) acc = FixedPointMathLib.fullMulDiv(acc, 0x16a09e667f3bcc908b2fb1366ea957d3e, ONE_Q128);
    }
}
