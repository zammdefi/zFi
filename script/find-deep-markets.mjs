#!/usr/bin/env node
// Which tokens have a live Deepstate book that zSwap does not list yet.
//
// A book zSwap cannot see is a market its users cannot trade. `check-deep-
// coverage.mjs` asks that of the tokens already listed; this asks it of every
// token the exchange's own front end mentions, which is the closest thing to a
// market index the chain offers - there is no registry of books to enumerate.
import {Interface, JsonRpcProvider} from "ethers";
import fs from "node:fs";

const RPC = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const DS = "0x6cf19308C22FC82ea620Fa0B3E94948d20f27B96";
const LENS = "0x000000D579c1829a4b9BB720f0C26062AE608C45";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
// Already listed on 4663.
const LISTED = new Set([
  "0x0000000000000000000000000000000000000000", "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168", "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
  "0x1da24f6bb623b9d1afeae3f3146659a2662d6d27", "0x01637b14b7378b99de75a64d50656d98488d9a4d",
]);

const E = new Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);
const I = new Interface([
  "function poolId(address,address) pure returns (bytes32)",
  "function poolEpoch(bytes32) view returns (uint256)",
  "function roots(address,address,uint256) view returns (bytes32,bytes32)",
]);
const L = new Interface(["function quoteDeep(address,address,uint256) view returns (uint256,uint256)"]);

const p = new JsonRpcProvider(RPC, 4663, {staticNetwork: true});
const cands = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
  // Order nodes and selector fragments look like addresses; real ones do not end
  // in a long run of zeros or begin with a 4-byte selector followed by padding.
  .filter((a) => !/0{20,}$/.test(a) && a !== "0x" + "0".repeat(40) && !LISTED.has(a));

console.log(`probing ${cands.length} candidate addresses for ERC-20-ness and a USDG book\n`);
const found = [];
for (const a of cands) {
  try {
    if ((await p.getCode(a)).length <= 2) continue;
    const [sym] = E.decodeFunctionResult("symbol", await p.call({to: a, data: E.encodeFunctionData("symbol")}));
    const [dec] = E.decodeFunctionResult("decimals", await p.call({to: a, data: E.encodeFunctionData("decimals")}));
    const [t0, t1] = BigInt(a) < BigInt(USDG) ? [a, USDG] : [USDG, a];
    const [pid] = I.decodeFunctionResult("poolId", await p.call({to: DS, data: I.encodeFunctionData("poolId", [t0, t1])}));
    const [epoch] = I.decodeFunctionResult("poolEpoch", await p.call({to: DS, data: I.encodeFunctionData("poolEpoch", [pid])}));
    const [ask, bid] = I.decodeFunctionResult("roots", await p.call({to: DS, data: I.encodeFunctionData("roots", [t0, t1, epoch])}));
    if (/^0x0+$/.test(ask) && /^0x0+$/.test(bid)) continue;
    let priced = 0n;
    try {
      // One whole unit, not a hundredth: a token worth a fraction of a cent
      // rounds a small probe to zero and reads as "no book" when it has one.
      // STATE did exactly that.
      const probe = 10n ** BigInt(dec);
      [priced] = L.decodeFunctionResult("quoteDeep", await p.call({to: LENS, data: L.encodeFunctionData("quoteDeep", [a, USDG, probe])}));
    } catch {}
    found.push({a, sym, dec: Number(dec), sides: [/^0x0+$/.test(ask) ? "" : "ask", /^0x0+$/.test(bid) ? "" : "bid"].filter(Boolean).join("+"), priced});
    console.log(`  ${sym.padEnd(10)} ${a}  ${String(dec).padStart(2)}dec  book:${found.at(-1).sides.padEnd(8)} ${priced > 0n ? `quotes (${priced} raw USDG per 0.01)` : "no quote"}`);
  } catch {}
}
console.log(found.length ? `\n${found.length} unlisted token(s) with a live Deepstate book` : "\nno unlisted token has a live book");
