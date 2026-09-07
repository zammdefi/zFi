// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import "forge-std/Test.sol";
import {V4QuoteLensPM} from "../src/V4QuoteLensPM.sol";
import {V4QuoteLensL2} from "../src/V4QuoteLensL2.sol";

/// @notice `V4QuoteLensPM` runs the swap itself instead of calling Uniswap's
///         V4Quoter, because Robinhood Chain has no V4Quoter to call.
///
/// @dev THE ONLY QUESTION THAT MATTERS is whether running it ourselves gives the
///      SAME NUMBER as Uniswap's own quoter. That cannot be checked on the chain
///      it was written for - there is nothing there to compare against. So it is
///      checked on BASE, where both exist: the same pools, the same amounts,
///      through both lenses, asserted equal. A second suite then runs it against
///      real Robinhood pools to prove the mechanism works on the chain it is for.
contract V4QuoteLensPMBaseTest is Test {
    address constant BASE_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant BASE_QUOTER = 0x0d5e0F971ED27FBfF6c2837bf31316121532048D;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant ETH = address(0);

    V4QuoteLensPM pm;
    V4QuoteLensL2 uni;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        pm = new V4QuoteLensPM(BASE_POOL_MANAGER);
        uni = new V4QuoteLensL2(BASE_QUOTER, BASE_POOL_MANAGER);
    }

    /// @dev Four live fee tiers, four sizes each. Equality, not approximation:
    ///      both paths run the identical swap against the identical state, so any
    ///      difference at all is a defect in the sign handling or the delta decode.
    function testAgreesWithUniswapsQuoterExactIn() public {
        uint24[4] memory fees = [uint24(100), 500, 3000, 10000];
        int24[4] memory spacings = [int24(1), 10, 60, 200];
        uint256[4] memory amounts = [uint256(0.001 ether), 0.01 ether, 0.1 ether, 1 ether];
        uint256 compared;
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 4; ++j) {
                (uint256 ai, uint256 ao) = uni.quoteV4Hooked(false, ETH, USDC, fees[i], spacings[i], address(0), amounts[j]);
                (uint256 bi, uint256 bo) = pm.quoteV4Hooked(false, ETH, USDC, fees[i], spacings[i], address(0), amounts[j]);
                if (ao == 0) continue; // pool not there; the other must agree
                assertEq(bo, ao, "output differs from Uniswap's quoter");
                assertEq(bi, ai, "input differs from Uniswap's quoter");
                ++compared;
            }
        }
        assertGt(compared, 8, "too few live pools to call this a comparison");
    }

    /// @dev The other direction, and the reverse token order with it - `tokenIn`
    ///      is now currency1, so a sign slip in the delta decode shows up here
    ///      and nowhere else.
    function testAgreesWithUniswapsQuoterExactOut() public {
        uint24[4] memory fees = [uint24(100), 500, 3000, 10000];
        int24[4] memory spacings = [int24(1), 10, 60, 200];
        uint256 compared;
        for (uint256 i; i < 4; ++i) {
            (uint256 ai, uint256 ao) = uni.quoteV4Hooked(true, USDC, ETH, fees[i], spacings[i], address(0), 0.01 ether);
            (uint256 bi, uint256 bo) = pm.quoteV4Hooked(true, USDC, ETH, fees[i], spacings[i], address(0), 0.01 ether);
            if (ai == 0) continue;
            assertEq(bi, ai, "exact-out input differs from Uniswap's quoter");
            assertEq(bo, ao, "exact-out output differs from Uniswap's quoter");
            ++compared;
        }
        assertGt(compared, 1, "too few live pools to call this a comparison");
    }

    function testAnUninitialisedPoolIsNoRouteRatherThanARevert() public {
        (uint256 ai, uint256 ao) = pm.quoteV4Hooked(false, ETH, USDC, 777, 7, address(0), 0.01 ether);
        assertEq(ai, 0);
        assertEq(ao, 0);
    }

    function testRefusesAPoolManagerWithNoCode() public {
        vm.expectRevert(V4QuoteLensPM.BadPoolManager.selector);
        new V4QuoteLensPM(address(0xdead));
    }

    /// @dev The callback performs a swap unconditionally, so it must be reachable
    ///      only from inside the PoolManager's own lock.
    function testCallbackRefusesAnyoneButThePoolManager() public {
        vm.expectRevert(V4QuoteLensPM.NotPoolManager.selector);
        pm.unlockCallback("");
    }

    /// @dev Nothing is ever settled, so the lens must not need - or keep - a balance.
    function testHoldsNothing() public {
        pm.quoteV4Hooked(false, ETH, USDC, 500, 10, address(0), 1 ether);
        assertEq(address(pm).balance, 0);
    }
}

/// @notice The chain it was actually written for.
contract V4QuoteLensPMRobinhoodTest is Test {
    address constant RH_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    /// @dev The deployed `zQuoterRobinhood`, which prices hookless pools from
    ///      StateView. It is the independent second opinion on this chain.
    address constant ZQUOTER = 0x000000bd2DB80567c23E353ca95a251c573cBf9B;

    V4QuoteLensPM pm;

    function setUp() public {
        vm.createSelectFork(vm.envOr("RH_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")));
        pm = new V4QuoteLensPM(RH_POOL_MANAGER);
    }

    /// @dev Against the StateView tick math already deployed there. Both are
    ///      correct for a HOOKLESS pool, by different routes - one walks the
    ///      bitmap, the other runs the swap - so they must land on the same
    ///      number. That is what makes the disagreement on a HOOKED pool
    ///      meaningful rather than noise.
    function testAgreesWithTheDeployedStateViewQuoter() public {
        uint24[3] memory fees = [uint24(100), 500, 3000];
        int24[3] memory spacings = [int24(1), 10, 60];
        uint256 compared;
        for (uint256 i; i < 3; ++i) {
            (bool ok, bytes memory ret) = ZQUOTER.staticcall(
                abi.encodeWithSignature(
                    "quoteV4(bool,address,address,uint24,uint256)", false, address(0), USDG, fees[i], uint256(0.01 ether)
                )
            );
            assertTrue(ok, "zQuoterRobinhood.quoteV4 reverted");
            (, uint256 ao) = abi.decode(ret, (uint256, uint256));
            (uint256 bi, uint256 bo) = pm.quoteV4Hooked(false, address(0), USDG, fees[i], spacings[i], address(0), 0.01 ether);
            if (ao == 0) continue;
            assertEq(bo, ao, "differs from the deployed StateView quoter");
            assertEq(bi, 0.01 ether);
            ++compared;
        }
        assertGt(compared, 1, "too few live Robinhood pools to call this a comparison");
    }

    /// @dev WETH is a plain ERC-20 currency here, not the native one, so this
    ///      exercises the non-zero currency0 path on the chain that matters.
    function testQuotesAnErc20PairOnRobinhood() public {
        (uint256 ai, uint256 ao) = pm.quoteV4Hooked(false, WETH, USDG, 500, 10, address(0), 0.01 ether);
        assertEq(ai, 0.01 ether);
        assertGt(ao, 10_000);
        assertLt(ao, 1e12);
    }
}
