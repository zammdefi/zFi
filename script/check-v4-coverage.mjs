#!/usr/bin/env node
// Are our deployed quoters telling the truth about Uniswap v4, and what are
// they blind to?
//
// TWO QUESTIONS, AND THEY ARE DIFFERENT.
//
//   1. AGREEMENT. Our quoters price a v4 pool by walking the tick bitmap from
//      StateView. Uniswap's V4Quoter prices it by running the swap. For a
//      HOOKLESS pool both are exact, so they must land on the same number; a
//      difference is a defect in our tick math, and it would misprice v3 and
//      Aerodrome Slipstream too, since one engine feeds all three.
//
//   2. COVERAGE. The aggregate sweep asks for four fee tiers at their canonical
//      tick spacings with no hook - on EVERY chain, mainnet included. A pool at
//      any other (fee, spacing), a dynamic-fee pool, or any hooked pool is
//      invisible to it and always was. Those are not bugs to fix in the quoter:
//      the space is unbounded and cannot be swept. They are pools the curator
//      publishes on the token list as `zfi.v4pool`, which the page then prices
//      through the V4QuoteLens. This prints the ones it can find so that list
//      can be written from evidence rather than guessed at.
//
// Usage: node script/check-v4-coverage.mjs [chainId ...]     (default: all)
import {Interface, JsonRpcProvider} from "ethers";

const ZERO = "0x0000000000000000000000000000000000000000";

const CHAINS = {
  1: {
    name: "Ethereum",
    rpc: "https://ethereum-rpc.publicnode.com",
    quoter: "0x56033EBF90EbdEf9D74b38e5F7201c0624EFef01", // zQuoterV4, the corrected v4 path
    quoterAbi: "function quoteV4(bool,address,address,uint24,int24,address,uint256) view returns (uint256,uint256)",
    v4Quoter: "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203",
    pairs: [
      ["ETH", ZERO, "USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
      ["ETH", ZERO, "USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7"],
      ["ETH", ZERO, "WBTC", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"],
      ["ETH", ZERO, "wstETH", "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"],
    ],
  },
  8453: {
    name: "Base",
    rpc: "https://mainnet.base.org",
    quoter: "0x000000bd2DB80567c23E353ca95a251c573cBf9B", // zQuoterBase
    quoterAbi: "function quoteV4(bool,address,address,uint24,uint256) view returns (uint256,uint256)",
    v4Quoter: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
    pairs: [
      ["ETH", ZERO, "USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
      ["ETH", ZERO, "cbBTC", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"],
      ["ETH", ZERO, "AERO", "0x940181a94A35A4569E4529A3CDfB74e38FD98631"],
      ["ETH", ZERO, "wstETH", "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452"],
    ],
  },
  4663: {
    name: "Robinhood",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    quoter: "0x000000bd2DB80567c23E353ca95a251c573cBf9B", // zQuoterRobinhood
    quoterAbi: "function quoteV4(bool,address,address,uint24,uint256) view returns (uint256,uint256)",
    v4Quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
    pairs: [
      ["ETH", ZERO, "USDG", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"],
      ["WETH", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", "USDG", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"],
      ["ETH", ZERO, "NVDA", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"],
      ["ETH", ZERO, "DEEP", "0x1DA24f6Bb623b9d1aFEae3F3146659A2662D6d27"],
      ["ETH", ZERO, "MARIAN", "0x01637b14B7378B99dE75A64d50656d98488D9a4d"],
    ],
  },
};

// What the sweep asks for. `_spacingFromBps` pairs each fee with exactly one
// spacing, on every chain, so this table IS the sweep's reach.
const SWEPT = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
// Spacings a pool may legally use with those fees but the sweep never asks for.
// Not exhaustive - tickSpacing is any int24 in [1, 32767] - just the ones pools
// are actually created at.
const UNSWEPT_SPACINGS = [1, 10, 30, 50, 60, 100, 200, 2000];
const DYNAMIC_FEE = 0x800000;

const v4q = new Interface([
  "function quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes)) returns (uint256,uint256)",
]);

const AMOUNT = 10n ** 16n; // 0.01 ETH

// EVERY CALL IN A CHAIN'S SECTION IS PINNED TO ONE BLOCK. Without it the two
// quoters are asked about different states: Base and Robinhood mint every two
// seconds, and a traded pool moves between the request to ours and the request
// to Uniswap's. That showed up as a 1,609-in-25,000,000 "disagreement" on
// Robinhood WETH/USDG - not a defect in the tick math, just two clocks.
async function quoteUniswap(p, quoter, tokenIn, tokenOut, fee, spacing, hooks, blockTag) {
  const zeroForOne = BigInt(tokenIn) < BigInt(tokenOut);
  const key = zeroForOne ? [tokenIn, tokenOut, fee, spacing, hooks] : [tokenOut, tokenIn, fee, spacing, hooks];
  try {
    const ret = await p.call({to: quoter, blockTag, data: v4q.encodeFunctionData("quoteExactInputSingle", [[key, zeroForOne, AMOUNT, "0x"]])});
    return v4q.decodeFunctionResult("quoteExactInputSingle", ret)[0];
  } catch {
    return 0n;
  }
}

let bad = 0;
const chains = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CHAINS);

for (const id of chains) {
  const c = CHAINS[id];
  if (!c) { console.error(`unknown chain ${id}`); process.exitCode = 1; continue; }
  const p = new JsonRpcProvider(c.rpc, Number(id), {staticNetwork: true});
  const ours = new Interface([c.quoterAbi]);
  // `uint24` CONTAINS `int24`, so the obvious substring test called every L2
  // quoter seven-arg and every call failed to encode. Count the parameters.
  const sevenArg = c.quoterAbi.split("(")[1].split(")")[0].split(",").length === 7;
  const blockTag = await p.getBlockNumber();
  console.log(`\n=== ${c.name} (${id}) — zQuoter ${c.quoter} vs Uniswap V4Quoter ${c.v4Quoter} @ block ${blockTag}`);

  for (const [symIn, tokenIn, symOut, tokenOut] of c.pairs) {
    // 1. AGREEMENT over what the sweep actually asks for.
    for (const [fee, spacing] of SWEPT) {
      const args = sevenArg
        ? [false, tokenIn, tokenOut, fee, spacing, ZERO, AMOUNT]
        : [false, tokenIn, tokenOut, fee, AMOUNT];
      let mine = 0n;
      try {
        const ret = await p.call({to: c.quoter, blockTag, data: ours.encodeFunctionData("quoteV4", args)});
        mine = ours.decodeFunctionResult("quoteV4", ret)[1];
      } catch (e) { mine = -1n; console.log(`       (call failed: ${e.shortMessage || e.message})`); }
      const theirs = await quoteUniswap(p, c.v4Quoter, tokenIn, tokenOut, fee, spacing, ZERO, blockTag);
      if (mine === -1n) { console.log(`  FAIL ${symIn}/${symOut} ${fee}/${spacing}: our quoter reverted (Uniswap says ${theirs})`); bad++; continue; }
      if (mine === theirs) {
        console.log(`  ok   ${symIn}/${symOut} ${String(fee).padStart(5)}/${String(spacing).padStart(4)}  ${theirs === 0n ? "no pool, both agree" : theirs}`);
      } else {
        console.log(`  FAIL ${symIn}/${symOut} ${fee}/${spacing}: ours ${mine}, Uniswap ${theirs}`);
        bad++;
      }
    }

    // 2. COVERAGE: pools that exist at a (fee, spacing) the sweep never asks for.
    const missed = [];
    for (const [fee] of [...SWEPT, [DYNAMIC_FEE]]) {
      for (const spacing of UNSWEPT_SPACINGS) {
        if (SWEPT.some(([f, s]) => f === fee && s === spacing)) continue;
        const out = await quoteUniswap(p, c.v4Quoter, tokenIn, tokenOut, fee, spacing, ZERO, blockTag);
        if (out > 0n) missed.push({fee, spacing, out});
      }
    }
    if (missed.length) {
      console.log(`  ${missed.length} live ${symIn}/${symOut} pool(s) the sweep cannot reach — publish as zfi.v4pool:`);
      for (const m of missed) {
        const other = tokenIn === ZERO ? "0" : tokenIn;
        console.log(`     v1:${other}:${m.fee}:${m.spacing}:0    (0.01 ETH -> ${m.out})`);
      }
    } else {
      console.log(`  no unswept ${symIn}/${symOut} pools found at the spacings probed`);
    }
  }
}

console.log(bad ? `\n${bad} disagreement(s) — the tick math and Uniswap's quoter do not match` : "\nevery swept tier agrees with Uniswap's own quoter");
process.exitCode = bad ? 1 : 0;
