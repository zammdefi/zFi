// SPDX-License-Identifier: MIT
pragma solidity ^0.8.36;

import "forge-std/Test.sol";
import {V4QuoteLensL2} from "../src/V4QuoteLensL2.sol";

/// @notice The lens that lets a token-list `zfi.v4pool` entry mean something on
///         every chain the page speaks - one contract, one ABI, three chains.
///
/// @dev WHAT THIS IS GUARDING. `V4QuoteLens` binds mainnet's V4Quoter as a
///      constant. The same bytecode on Base staticcalls an address with no code
///      - and a call to a codeless address SUCCEEDS with empty returndata, so
///      the `try` does not catch and the lens answers (0, 0). "No route" and
///      "wrong chain" become indistinguishable, forever, silently. So the
///      constructor here refuses a quoter whose `poolManager()` is not the
///      singleton it was told to expect, and these tests prove the refusal fires
///      rather than being decoration - on each chain, against that chain's own
///      Uniswap deployment, with a live pool quoted through it.
abstract contract V4QuoteLensL2Fork is Test {
    address internal quoter;
    address internal poolManager;
    address internal stable; // a 6-decimal stable with a live ETH pool
    uint24 internal fee;
    int24 internal spacing;
    /// @dev A real PoolManager on ANOTHER chain: the wrong answer, not a fake one.
    address internal constant FOREIGN_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;

    V4QuoteLensL2 internal lens;

    function _fork() internal virtual;

    function setUp() public {
        _fork();
        lens = new V4QuoteLensL2(quoter, poolManager);
    }

    function testBindsTheQuoterItWasGiven() public view {
        assertEq(lens.V4_QUOTER(), quoter);
    }

    function testRefusesAQuoterForAnotherChain() public {
        address wrong = poolManager == FOREIGN_POOL_MANAGER ? address(0xbeef) : FOREIGN_POOL_MANAGER;
        vm.expectRevert(V4QuoteLensL2.BadQuoter.selector);
        new V4QuoteLensL2(quoter, wrong);
    }

    function testRefusesAnAddressWithNoCode() public {
        vm.expectRevert(V4QuoteLensL2.BadQuoter.selector);
        new V4QuoteLensL2(address(0xdead), poolManager);
    }

    /// @dev A live pool, quoted through the same call shape zSwap makes:
    ///      `quoteV4Hooked(false, tokenIn, tokenOut, fee, tickSpacing, hooks, amountIn)`,
    ///      reading `amountOut` out of the second word.
    function testQuotesALivePool() public {
        (uint256 amountIn, uint256 amountOut) =
            lens.quoteV4Hooked(false, address(0), stable, fee, spacing, address(0), 0.01 ether);
        assertEq(amountIn, 0.01 ether);
        assertGt(amountOut, 0, "the live ETH pool quoted nothing");
        // Sanity, not a price oracle: 0.01 ETH is worth far more than a cent and
        // far less than a million dollars in 6-decimal terms.
        assertGt(amountOut, 10_000);
        assertLt(amountOut, 1e12);
    }

    /// @dev The contract this quotes for is arbitrary code, and a sweep across
    ///      candidate pools must survive the ones that are not there.
    function testAnUninitialisedPoolIsNoRouteRatherThanARevert() public {
        (uint256 amountIn, uint256 amountOut) =
            lens.quoteV4Hooked(false, address(0), stable, 777, 7, address(0), 0.01 ether);
        assertEq(amountIn, 0);
        assertEq(amountOut, 0);
    }

    /// @dev Batch and single must not disagree; the page sizes trades with the
    ///      batch and executes against the single.
    function testBatchAgreesWithSingle() public {
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 0.001 ether;
        amounts[1] = 0.01 ether;
        (, uint256[] memory outs) =
            lens.quoteV4HookedBatch(false, address(0), stable, fee, spacing, address(0), amounts);
        for (uint256 i; i < 2; ++i) {
            (, uint256 one) = lens.quoteV4Hooked(false, address(0), stable, fee, spacing, address(0), amounts[i]);
            assertEq(outs[i], one, "batch and single disagree");
        }
    }
}

contract V4QuoteLensMainnetTest is V4QuoteLensL2Fork {
    function _fork() internal override {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string("https://ethereum-rpc.publicnode.com")));
        quoter = 0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203;
        poolManager = 0x000000000004444c5dc75cB358380D2e3dE08A90;
        stable = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // USDC
        fee = 500;
        spacing = 10;
    }
}

contract V4QuoteLensBaseTest is V4QuoteLensL2Fork {
    function _fork() internal override {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        quoter = 0x0d5e0F971ED27FBfF6c2837bf31316121532048D;
        poolManager = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
        stable = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // USDC
        fee = 500;
        spacing = 10;
    }
}

contract V4QuoteLensRobinhoodTest is V4QuoteLensL2Fork {
    function _fork() internal override {
        vm.createSelectFork(vm.envOr("RH_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")));
        quoter = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
        poolManager = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
        stable = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // USDG
        fee = 500;
        spacing = 10;
    }
}
