// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

/// @title V4QuoteLensPM
/// @notice A `V4QuoteLens` for a chain where Uniswap never deployed a V4Quoter.
///
/// @dev SUPERSEDED - NOT DEPLOYED, AND ITS PREMISE NO LONGER HOLDS. This was
///      written believing Robinhood Chain (4663) had no V4Quoter at any findable
///      address. It does: `0x8DC178EFb8111Bb0973dd9d722ebeFf267c98F94`, whose
///      `poolManager()` is `0x8366a39CC670B4001A1121B8F6A443A643e40951` - the
///      same manager `zRouterLiteRobinhood` names. `V4QuoteLensL2` binds to it
///      and IS deployed on 4663 (see deploy/l2/manifest.json), at the same
///      CREATE3 address as on mainnet and Base, which is what zSwap's chain
///      table points every chain at. Nothing references this file but its own
///      test. Keep it only as the fallback design for a future chain that
///      genuinely lacks a quoter; do not deploy it to 4663.
///
/// @dev WHAT IT WOULD HAVE SOLVED. `V4QuoteLens` and `V4QuoteLensL2` both
///      delegate to Uniswap's periphery `V4Quoter`. With nothing to bind, the
///      page's `V4LENS === ZERO` guard drops every pool a listing publishes, so
///      a `zfi.v4pool` extra would be inert. This closes that without vendoring
///      v4-periphery (which drags in v4-core, permit2 and solmate to compile one
///      thin wrapper).
///
/// @dev THE MECHANISM IS UNISWAP'S, NOT A REIMPLEMENTATION. Quoting a hooked
///      pool from state is impossible - a hook may replace the curve with a
///      BeforeSwapDelta, take an afterSwap delta out of the output, or set the
///      fee per swap, and none of that is in slot0 and liquidity. The only thing
///      that prices one correctly is RUNNING it. So, exactly as `V4Quoter` does:
///      `unlock` the PoolManager, perform the real swap inside the callback, and
///      REVERT with the resulting delta. The revert unwinds the swap; the delta
///      is caught and decoded out here. Hook logic, hook deltas and dynamic fees
///      are then correct by construction rather than by reimplementation.
///
/// @dev WHY THIS IS NOT `view`. `unlock` writes transient storage, and TSTORE is
///      forbidden under STATICCALL, so this and everything wrapping it must be
///      `nonpayable`. Off-chain callers lose nothing - `eth_call` simulates a
///      nonpayable function fine. On-chain callers cannot use it from a `view`
///      context; that is the price of quoting a hook honestly.
///
/// @dev NOTHING IS EVER SETTLED HERE. The callback reverts before `settle`, so
///      this contract never holds, owes or moves a token, and needs no balance.
///      A quote that did settle would be a swap.
///
/// @dev WHICH POOLS. Quoting one is not endorsing one. The page routes through a
///      hooked pool only when the curated token list carries that pool's spec -
///      the list is the trust decision, made by the same DAO that curates the
///      tokens. Execution adds its own bound: the router re-checks the user's
///      minimum at settlement, so a hook that turns hostile between quote and
///      swap can waste a transaction but cannot push a fill past the bound it
///      was quoted against.
contract V4QuoteLensPM {
    /// @notice The v4 singleton this lens quotes against.
    address public immutable POOL_MANAGER;

    /// @dev Carries a quote out of the callback. Reverting is the RETURN PATH,
    ///      not an error: it is what unwinds the swap that produced the answer.
    error QuoteResult(int256 delta);

    error BadPoolManager();
    error NotPoolManager();

    constructor(address poolManager) {
        // A call to a codeless address SUCCEEDS with empty returndata, so an
        // unchecked wrong address would make every quote (0, 0) forever and
        // "no route" would be indistinguishable from "wrong chain".
        if (poolManager.code.length == 0) revert BadPoolManager();
        POOL_MANAGER = poolManager;
    }

    /// @notice Quote one V4 hop, in the same shape `V4QuoteLens.quoteV4Hooked`
    ///         returns, so the page can call either without knowing which.
    /// @param exactOut  `swapAmount` is the desired output rather than the input.
    /// @param swapAmount Input when `exactOut` is false, output when it is true.
    /// @return amountIn  What must be paid.
    /// @return amountOut What is received.
    ///
    /// @dev A pool that cannot serve the quote - not initialised, a hook that
    ///      reverts, liquidity exhausted before the exact-out target - returns
    ///      (0, 0) rather than reverting, so one dead pool cannot take down a
    ///      multi-venue sweep. Callers must treat a zero leg as "no route", not
    ///      as "free". `exactOut` is the common casualty: a custom-curve hook
    ///      often implements only the exact-in direction and reverts on the
    ///      other - that is the hook's answer, not a fault here.
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
    /// @dev Bisects exact-in quotes for the smallest input whose output clears
    ///      `targetOut`. Each step runs the hook for real, so the answer is the
    ///      hook's own pricing rather than an inversion of a formula it does not
    ///      follow.
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

    /// @dev The PoolManager calls this back inside `unlock`. It performs the swap
    ///      and then reverts with the delta - see `QuoteResult`.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        // The callback is the only place a swap is performed, and it performs it
        // unconditionally. Anyone could otherwise call it directly; it would
        // revert on the PoolManager's own lock check, but failing here names the
        // reason instead of surfacing an unrelated error from inside v4.
        if (msg.sender != POOL_MANAGER) revert NotPoolManager();

        (PoolKey memory key, bool zeroForOne, int256 amountSpecified, bytes memory hookData) =
            abi.decode(data, (PoolKey, bool, int256, bytes));

        int256 delta = IV4PoolManager(POOL_MANAGER).swap(
            key,
            SwapParams(
                zeroForOne,
                amountSpecified,
                zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE
            ),
            hookData
        );

        // Unwinds the swap AND carries the answer out. Nothing is settled, so
        // this contract never owes or holds a currency.
        revert QuoteResult(delta);
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
        // v4's `amountSpecified` is an int256 and the pool's own accounting is
        // int128, so anything that cannot round-trip is no route rather than a
        // number this contract invents.
        if (swapAmount == 0 || swapAmount > uint256(uint128(type(int128).max))) return (0, 0);
        if (tokenIn == tokenOut) return (0, 0);

        // v4 sorts the pair and the caller does not get to choose; native ETH is
        // the zero address, so it is always currency0.
        bool zeroForOne = uint160(tokenIn) < uint160(tokenOut);
        PoolKey memory key = zeroForOne
            ? PoolKey(tokenIn, tokenOut, fee, tickSpacing, hooks)
            : PoolKey(tokenOut, tokenIn, fee, tickSpacing, hooks);

        // v4's sign convention: exact-in negative, exact-out positive.
        int256 amountSpecified = exactOut ? int256(swapAmount) : -int256(swapAmount);

        try IV4PoolManager(POOL_MANAGER).unlock(abi.encode(key, zeroForOne, amountSpecified, hookData))
        {
            // `unlockCallback` always reverts, so reaching here means the
            // PoolManager returned without calling back - not a quote.
            return (0, 0);
        } catch (bytes memory reason) {
            // Only OUR result selector is an answer. Anything else is a genuine
            // failure - an uninitialised pool, a reverting hook, liquidity
            // exhausted before an exact-out target - and is no route.
            if (reason.length != 36 || bytes4(reason) != QuoteResult.selector) return (0, 0);
            int256 delta;
            assembly ("memory-safe") {
                delta := mload(add(reason, 36))
            }

            // BalanceDelta is (amount0, amount1) from the SWAPPER's side:
            // negative is owed to the pool, positive is owed to the swapper.
            int128 a0 = int128(delta >> 128);
            int128 a1 = int128(delta);
            int128 paid = zeroForOne ? a0 : a1;
            int128 recv = zeroForOne ? a1 : a0;

            // A hook is arbitrary code and may return a delta with either sign
            // on either side. Refuse to report a negative receipt or a positive
            // payment as a quantity rather than casting it into a huge uint.
            if (paid > 0 || recv < 0) return (0, 0);
            amountIn = uint256(uint128(-paid));
            amountOut = uint256(uint128(recv));
            if (amountIn == 0 || amountOut == 0) return (0, 0);
        }
    }
}

uint160 constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
uint160 constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IV4PoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
}
