// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

import "forge-std/Test.sol";
import {Bitgetol} from "../src/Bitgetol.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IRouter {
    function snwap(
        address tokenIn,
        uint256 amountIn,
        address recipient,
        address tokenOut,
        uint256 amountOutMin,
        address executor,
        bytes calldata executorData
    ) external payable returns (uint256 amountOut);

    function multicall(bytes[] calldata data) external payable returns (bytes[] memory);
}

/// @notice Deploys Bitgetol on a mainnet fork, calls the Bitget test API via FFI
///         to get swap calldata for an ETH→USDC trade, then executes it through
///         zRouter.snwap and verifies the output.
contract TestBitgetol is Test {
    Bitgetol bitgetol;

    address constant ZROUTER = 0x000000000000FB114709235f1ccBFfb925F600e4;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    function setUp() public {
        bitgetol = new Bitgetol();
    }

    /// @notice Call Bitget test API via FFI, get calldata, execute through zRouter
    function test_bitget_swap_eth_to_usdc() public {
        uint256 swapAmount = 0.1 ether;
        vm.deal(address(this), swapAmount);

        // FFI: call Bitget API to get swap calldata
        // Returns: abi.encode(address target, bytes calldata)
        string[] memory cmd = new string[](3);
        cmd[0] = "node";
        cmd[1] = "-e";
        cmd[2] = string(
            abi.encodePacked(
                "const crypto=require('crypto');" "const K='6AE25C9BFEEC4D815097ECD54DDE36B9A1F2B069';"
                "const S='C2638D162310C10D5DAFC8013871F2868E065040';" "async function sign(path,body){"
                "const ts=String(Date.now());" "const payload=JSON.stringify(Object.fromEntries("
                "Object.entries({apiPath:path,body:JSON.stringify(body),'x-api-key':K,'x-api-timestamp':ts})"
                ".sort(([a],[b])=>a.localeCompare(b))));"
                "const sig=crypto.createHmac('sha256',S).update(payload).digest('base64');"
                "return{'x-api-key':K,'x-api-timestamp':ts,'x-api-signature':sig,'Content-Type':'application/json'};}"
                "async function main(){" "const B='https://bopenapi.bgwapi.io';"
                "const qBody={fromChain:'eth',toChain:'eth',fromContract:'',toContract:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',fromAmount:'100000000000000000'};"
                "const qH=await sign('/bgw-pro/swapx/pro/quote',qBody);"
                "const qR=await(await fetch(B+'/bgw-pro/swapx/pro/quote',{method:'POST',headers:qH,body:JSON.stringify(qBody)})).json();"
                "if(qR.status!==0){process.stderr.write('quote failed: '+JSON.stringify(qR));process.exit(1);}"
                "const market=qR.data.market;" "const toAmt=qR.data.toAmount;"
                "const sBody={fromChain:'eth',toChain:'eth',fromContract:'',toContract:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',fromAmount:'100000000000000000',fromAddress:'",
                vm.toString(address(bitgetol)),
                "',toAddress:'",
                vm.toString(address(bitgetol)),
                "',market:market,slippage:'0.05'};" "const sH=await sign('/bgw-pro/swapx/pro/swap',sBody);"
                "const sR=await(await fetch(B+'/bgw-pro/swapx/pro/swap',{method:'POST',headers:sH,body:JSON.stringify(sBody)})).json();"
                "if(sR.status!==0){process.stderr.write('swap failed: '+JSON.stringify(sR));process.exit(1);}"
                "const target=sR.data.contract;" "const calldata=sR.data.calldata;"
                // ABI-encode: (address target, bytes calldata, uint256 toAmount)
                "const ethers=require('ethers');"
                "const enc=ethers.AbiCoder.defaultAbiCoder().encode(['address','bytes','uint256'],[target,calldata,toAmt]);"
                "process.stdout.write(enc);}" "main().catch(e=>{process.stderr.write(e.message);process.exit(1);});"
            )
        );

        bytes memory result = vm.ffi(cmd);
        (address target, bytes memory calldata_, uint256 toAmount) = abi.decode(result, (address, bytes, uint256));

        assertTrue(target != address(0), "API returned zero target");
        assertTrue(calldata_.length > 0, "API returned empty calldata");
        assertTrue(toAmount > 0, "API returned zero toAmount");

        emit log_named_address("bitget router target", target);
        emit log_named_uint("expected toAmount (USDC)", toAmount);
        emit log_named_uint("calldata length", calldata_.length);

        // Build the Bitgetol adapter calldata
        bytes memory bitgetolData = abi.encodeWithSelector(
            Bitgetol.swap.selector,
            target, // router (Bitget's contract)
            address(0), // tokenIn (ETH)
            USDC, // tokenOut
            address(this), // recipient
            calldata_ // Bitget swap calldata
        );

        // Build snwap call through zRouter
        uint256 minOut = toAmount * 95 / 100; // 5% slippage buffer
        bytes memory snwapCall = abi.encodeWithSelector(
            IRouter.snwap.selector,
            address(0), // tokenIn (ETH)
            uint256(0), // amountIn (ETH sent via msg.value)
            address(this), // recipient
            USDC, // tokenOut
            minOut, // amountOutMin
            address(bitgetol), // executor
            bitgetolData // executorData
        );

        // Execute via multicall
        bytes[] memory calls = new bytes[](1);
        calls[0] = snwapCall;
        bytes memory multicall = abi.encodeWithSelector(IRouter.multicall.selector, calls);

        uint256 usdcBefore = IERC20(USDC).balanceOf(address(this));

        (bool ok, bytes memory ret) = ZROUTER.call{value: swapAmount}(multicall);
        if (!ok) {
            emit log_named_bytes("revert_data", ret);
        }
        assertTrue(ok, "swap reverted");

        uint256 usdcAfter = IERC20(USDC).balanceOf(address(this));
        uint256 received = usdcAfter - usdcBefore;

        emit log_named_uint("USDC received", received);
        assertGt(received, 0, "received zero USDC");
        assertGe(received, minOut, "received less than minOut");
    }

    /// @notice Test that the adapter gracefully handles when the API calldata
    ///         targets the wrong router (simulates rejection scenario)
    function test_bitget_revert_bad_calldata() public {
        vm.deal(address(this), 0.1 ether);

        // Construct bogus calldata that should revert
        bytes memory bogusCalldata = hex"deadbeef";
        bytes memory bitgetolData = abi.encodeWithSelector(
            Bitgetol.swap.selector,
            address(0xdead), // bogus router
            address(0),
            USDC,
            address(this),
            bogusCalldata
        );

        bytes memory snwapCall = abi.encodeWithSelector(
            IRouter.snwap.selector,
            address(0),
            uint256(0),
            address(this),
            USDC,
            uint256(1), // expect at least 1 USDC
            address(bitgetol),
            bitgetolData
        );

        bytes[] memory calls = new bytes[](1);
        calls[0] = snwapCall;
        bytes memory multicall = abi.encodeWithSelector(IRouter.multicall.selector, calls);

        (bool ok,) = ZROUTER.call{value: 0.1 ether}(multicall);
        assertFalse(ok, "should revert with bad calldata");
    }

    receive() external payable {}
}
