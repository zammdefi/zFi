// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import {QuoteExactSingleParams, PoolKey, IV4Quoter} from "./V4QuoteLens.sol";

/// @title V4QuoteLensL2
/// @notice `V4QuoteLens` for a chain that is not Ethereum mainnet.
///
/// @dev WHY A SECOND CONTRACT. `V4QuoteLens` binds Uniswap's mainnet V4Quoter
///      as a `constant`, which is right for the chain it was mined and deployed
///      for and useless anywhere else: the same bytecode on Base staticcalls an
///      address with no code, and a call to a codeless address SUCCEEDS with
///      empty returndata, so the `try` around it does not catch and the lens
///      would answer (0, 0) for every pool - "no route" for pools that trade.
///      Its source is pinned by a CREATE2 manifest against live bytecode, so the
///      quoter cannot be made a constructor argument there. This is that same
///      lens with the quoter bound at deployment instead.
///
/// @dev WHY IT IS NEEDED AT ALL. zSwap reads a hooked pool's key from the token
///      list (`zfi.v4pool`) and prices it HERE, because the local tick math in
///      `zQuoterBase` and `zQuoterRobinhood` is structurally unable to price a
///      pool a hook prices: a hook may replace the curve with a BeforeSwapDelta,
///      take an afterSwap delta out of the output, or set the fee per swap, and
///      none of that is in slot0 and liquidity. Until this is deployed on a
///      chain the page's `V4LENS === ZERO` guard drops every pool the list
///      publishes there, so a `zfi.v4pool` extra on a Base or Robinhood listing
///      is inert - see `deploy/L2Listing.md`.
///
/// @dev CONFIRMED, NOT ASSUMED. The constructor requires the quoter to have code
///      AND its `poolManager()` to be the singleton named at deployment. A
///      quoter for the wrong chain, or an address that merely looks like one,
///      fails here rather than answering (0, 0) forever afterwards.
contract V4QuoteLensL2 {
    /// @notice Uniswap's V4Quoter on this chain.
    address public immutable V4_QUOTER;

    error BadQuoter();

    constructor(address quoter, address poolManager) {
        if (quoter.code.length == 0) revert BadQuoter();
        (bool ok, bytes memory ret) = quoter.staticcall(abi.encodeWithSignature("poolManager()"));
        if (!ok || ret.length != 32 || abi.decode(ret, (address)) != poolManager) revert BadQuoter();
        V4_QUOTER = quoter;
    }

    /// @notice Quote one hooked V4 hop, in the same shape `zQuoterV4.quoteV4`
    ///         returns, so a caller can pick between them on `hooks != 0` alone.
    /// @param exactOut  `swapAmount` is the desired output rather than the input.
    /// @param swapAmount Input when `exactOut` is false, output when it is true.
    /// @return amountIn  What must be paid.
    /// @return amountOut What is received.
    ///
    /// @dev A pool that cannot serve the quote - not initialised, a hook that
    ///      reverts, liquidity exhausted before the exact-out target - returns
    ///      (0, 0) rather than reverting, so one dead pool cannot take down a
    ///      multi-venue quote sweep. Callers must treat a zero leg as "no route",
    ///      not as "free".
    function quoteV4Hooked(
        bool exactOut,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        int24 tickSpacing,
        address hooks,
        uint256 swapAmount,
        bytes calldata hookData
    ) public returns (uint256 amountIn, uint256 amountOut) {
        return _quote(exactOut, tokenIn, tokenOut, fee, tickSpacing, hooks, swapAmount, hookData);
    }

    /// @notice `quoteV4Hooked` with no hook data, the common case.
    function quoteV4Hooked(
        bool exactOut,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        int24 tickSpacing,
        address hooks,
        uint256 swapAmount
    ) public returns (uint256 amountIn, uint256 amountOut) {
        return _quote(exactOut, tokenIn, tokenOut, fee, tickSpacing, hooks, swapAmount, "");
    }

    /// @notice Quote one input against several candidate amounts in a single
    ///         call, so a page sizing a trade pays one round trip, not N.
    /// @dev Hooked pools are not necessarily linear, so a quote for 2x the input
    ///      is not 2x the output - which is why each amount needs its own quote.
    function quoteV4HookedBatch(
        bool exactOut,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        int24 tickSpacing,
        address hooks,
        uint256[] calldata swapAmounts
    ) public returns (uint256[] memory amountsIn, uint256[] memory amountsOut) {
        amountsIn = new uint256[](swapAmounts.length);
        amountsOut = new uint256[](swapAmounts.length);
        for (uint256 i; i < swapAmounts.length; ++i) {
            (amountsIn[i], amountsOut[i]) =
                quoteV4Hooked(exactOut, tokenIn, tokenOut, fee, tickSpacing, hooks, swapAmounts[i]);
        }
    }

    /// @notice "I want at least `targetOut`" for a pool that has no exact-out.
    ///
    /// @dev A custom-curve hook often implements only the exact-in direction and
    ///      reverts on the other; the way around it is to search the direction
    ///      that does work. Every step runs the hook for real, so the answer is
    ///      the hook's own pricing rather than an inversion of a formula it does
    ///      not follow.
    ///
    /// @dev ASSUMES OUTPUT RISES WITH INPUT. True of any sane pool, but a hook is
    ///      arbitrary code and could break it; the result is then merely a worse
    ///      input, never an unsafe one, because the returned `amountOut` is a
    ///      real quote that the caller still checks.
    ///
    /// @dev SIMULATION ONLY. Every step is a full `unlock` and swap, so this
    ///      costs roughly `maxIters` times a quote. Fine in `eth_call`, wrong in
    ///      a transaction.
    function solveExactOut(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        int24 tickSpacing,
        address hooks,
        uint256 targetOut,
        uint256 maxIn,
        uint256 maxIters
    ) public returns (uint256 amountIn, uint256 amountOut) {
        if (targetOut == 0 || maxIn == 0) return (0, 0);
        if (maxIters == 0 || maxIters > 128) maxIters = 128;

        (, uint256 hiOut) = _quote(false, tokenIn, tokenOut, fee, tickSpacing, hooks, maxIn, "");
        if (hiOut < targetOut) return (0, 0);

        uint256 lo; // known short
        uint256 hi = maxIn; // known sufficient
        amountIn = maxIn;
        amountOut = hiOut;

        for (uint256 i; i < maxIters && hi - lo > 1; ++i) {
            uint256 mid = lo + (hi - lo) / 2;
            (, uint256 midOut) = _quote(false, tokenIn, tokenOut, fee, tickSpacing, hooks, mid, "");
            if (midOut >= targetOut) {
                hi = mid;
                amountIn = mid;
                amountOut = midOut;
            } else {
                lo = mid;
            }
        }
    }

    function _quote(
        bool exactOut,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        int24 tickSpacing,
        address hooks,
        uint256 swapAmount,
        bytes memory hookData
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        if (swapAmount == 0 || swapAmount > type(uint128).max) return (0, 0);

        bool zeroForOne = uint160(tokenIn) < uint160(tokenOut);
        PoolKey memory key = zeroForOne
            ? PoolKey(tokenIn, tokenOut, fee, tickSpacing, hooks)
            : PoolKey(tokenOut, tokenIn, fee, tickSpacing, hooks);

        QuoteExactSingleParams memory params =
            QuoteExactSingleParams(key, zeroForOne, uint128(swapAmount), hookData);

        if (exactOut) {
            try IV4Quoter(V4_QUOTER).quoteExactOutputSingle(params) returns (uint256 got, uint256) {
                return (got, swapAmount);
            } catch {
                return (0, 0);
            }
        }
        try IV4Quoter(V4_QUOTER).quoteExactInputSingle(params) returns (uint256 got, uint256) {
            return (swapAmount, got);
        } catch {
            return (0, 0);
        }
    }
}
