#!/usr/bin/env node
// Which Deepstate books exist for the tokens zSwap lists on Robinhood, and which
// of them the lens can actually price.
//
// A book the lens declines is liquidity the router could execute against but the
// page will never offer, because nothing prices it. That is the gap this finds:
// not "is the quoter correct" (check-v4-coverage answers that) but "what is
// there that we are not reaching".
import {Interface, JsonRpcProvider} from "ethers";

const RPC = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const DS = "0x6cf19308C22FC82ea620Fa0B3E94948d20f27B96";
const LENS = "0x000000D579c1829a4b9BB720f0C26062AE608C45";

const I = new Interface([
  "function poolId(address,address) pure returns (bytes32)",
  "function poolEpoch(bytes32) view returns (uint256)",
  "function bookId(address,address,uint256) view returns (bytes32)",
  "function roots(address,address,uint256) view returns (bytes32,bytes32)",
  "function poolHook(bytes32) view returns (address)",
  "function topOrder(bytes32,bool) view returns (uint32,uint160)",
]);
const LI = new Interface(["function quoteDeep(address,address,uint256) view returns (uint256,uint256)"]);

// The tokens zSwap lists on 4663.
const T = {
  ETH:   ["0x0000000000000000000000000000000000000000", 18],
  WETH:  ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", 18],
  USDG:  ["0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", 6],
  NVDA:  ["0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", 18],
  DEEP:  ["0x1DA24f6Bb623b9d1aFEae3F3146659A2662D6d27", 18],
  MARIAN:["0x01637b14B7378B99dE75A64d50656d98488D9a4d", 18],
};

const p = new JsonRpcProvider(RPC, 4663, {staticNetwork: true});
const call = async (to, iface, fn, args) =>
  iface.decodeFunctionResult(fn, await p.call({to, data: iface.encodeFunctionData(fn, args)}));

const names = Object.keys(T);
const rows = [];
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const [a, da] = T[names[i]], [b] = T[names[j]];
    const [t0, t1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    try {
      const [pid] = await call(DS, I, "poolId", [t0, t1]);
      const [epoch] = await call(DS, I, "poolEpoch", [pid]);
      const [id] = await call(DS, I, "bookId", [t0, t1, epoch]);
      const [askRoot, bidRoot] = await call(DS, I, "roots", [t0, t1, epoch]);
      const empty = /^0x0+$/.test(askRoot) && /^0x0+$/.test(bidRoot);
      if (empty) continue;
      const [hook] = await call(DS, I, "poolHook", [pid]);
      const hooked = hook !== "0x0000000000000000000000000000000000000000";
      // Can the lens price it, in either direction?
      const probe = 10n ** BigInt(da) / 100n || 1n;
      let priced = false;
      for (const [x, y] of [[a, b], [b, a]]) {
        try {
          const [out] = LI.decodeFunctionResult("quoteDeep",
            await p.call({to: LENS, data: LI.encodeFunctionData("quoteDeep", [x, y, probe])}));
          if (out > 0n) { priced = true; break; }
        } catch {}
      }
      rows.push({pair: `${names[i]}/${names[j]}`, hooked, hook, priced,
        sides: [/^0x0+$/.test(askRoot) ? "" : "ask", /^0x0+$/.test(bidRoot) ? "" : "bid"].filter(Boolean).join("+")});
    } catch (e) { /* no such pool */ }
  }
}
console.log(`Deepstate books among zSwap's Robinhood listings\n`);
if (!rows.length) console.log("  none");
for (const r of rows) {
  console.log(`  ${r.pair.padEnd(12)} ${r.sides.padEnd(8)} ${r.hooked ? `HOOKED ${r.hook}` : "no hook"}  ${r.priced ? "PRICED by the lens" : "NOT PRICED — liquidity zSwap cannot reach"}`);
}
const gap = rows.filter((r) => !r.priced);
console.log(gap.length ? `\n${gap.length} book(s) with liquidity the page cannot offer` : "\nevery live book is priced");
