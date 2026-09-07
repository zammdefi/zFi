#!/usr/bin/env node
// Check a foreign-listing batch against the chains it describes.
//
// A batch is owner-attested text about tokens on another chain, and mainnet
// cannot check a word of it. Two things can be wrong in ways that survive every
// on-mainnet test: the ADDRESS can name something other than the token whose
// name and symbol are written beside it, and the token can be real but have no
// route on that chain - a listing nobody can trade, which for a meta-DEX is
// worse than an absent one because it fails at quote time in front of a user.
//
// So this reads every listing back from the token ON ITS OWN CHAIN and then asks
// the deployed quoter for a real route.
//
// Usage: node script/check-listing-batch.mjs
import { Interface, JsonRpcProvider, getAddress } from 'ethers';
import fs from 'node:fs';

const REG = new Interface([
  'function multicall(bytes[] data)',
  'function listForeign(uint8,uint64 chainId,bytes32 account,string name_,string symbol_,uint8 decimals_,uint24,uint32 rank,string)',
]);
const ERC20 = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const QUOTER = new Interface([
  'function getQuotes(bool exactOut,address tokenIn,address tokenOut,uint256 swapAmount) view returns ((uint8,uint256,uint256,uint256) best,(uint8,uint256,uint256,uint256)[] quotes)',
]);
const AMM = ['UniV2','Sushi/Aero','zAMM','UniV3','UniV4','Curve/AeroCL','Lido','Wrap','Precision'];
const ZQ = '0x000000bd2DB80567c23E353ca95a251c573cBf9B';
const ZERO = '0x' + '00'.repeat(20);

const CH = {
  8453: { name: 'Base', rpc: 'https://mainnet.base.org', probe: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', probeSym: 'USDC', probeDec: 6 },
  4663: { name: 'Robinhood', rpc: 'https://rpc.mainnet.chain.robinhood.com', probe: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', probeSym: 'USDG', probeDec: 6 },
};

for (const [file, cid] of [['deploy/BASE-list.calldata.txt', 8453], ['deploy/ROBINHOOD-list.calldata.txt', 4663]]) {
  const c = CH[cid];
  const p = new JsonRpcProvider(c.rpc, cid, { staticNetwork: true });
  const calls = REG.decodeFunctionData('multicall', fs.readFileSync(file, 'utf8').trim())[0];
  const rows = [];
  for (const call of calls) {
    if (call.slice(0, 10) !== REG.getFunction('listForeign').selector) continue;
    const a = REG.decodeFunctionData('listForeign', call);
    rows.push({ chainId: Number(a[1]), addr: '0x' + a[2].slice(26), name: a[3], sym: a[4], dec: Number(a[5]), rank: Number(a[7]) });
  }
  console.log(`\n================ ${c.name} (${cid}) — ${rows.length} listings`);
  console.log('rank      symbol   claimed vs on-chain                              tradeable?');
  const read = async (to, fn) => {
    try { return ERC20.decodeFunctionResult(fn, await p.call({ to, data: ERC20.encodeFunctionData(fn) }))[0]; }
    catch { return null; }
  };
  for (const r of rows.sort((x, y) => y.rank - x.rank)) {
    let ident, quote = '';
    if (r.addr === ZERO) {
      ident = 'native asset, 18 dec — nothing to read';
    } else {
      const code = await p.getCode(r.addr);
      const [sym, dec, nm] = [await read(r.addr, 'symbol'), await read(r.addr, 'decimals'), await read(r.addr, 'name')];
      const symOk = sym === r.sym, decOk = Number(dec) === r.dec, nameOk = nm === r.name;
      ident = code.length <= 2 ? 'NO CODE ON CHAIN'
        : (symOk && decOk && nameOk) ? `${sym}/${dec}dec/"${nm}" — matches`
        : `MISMATCH chain says ${sym}/${dec}/"${nm}"`;
    }
    // Route: this token against the chain's ETH, or against the stable if it IS eth-like.
    const other = (r.addr === ZERO) ? c.probe : ZERO;
    const inTok = r.addr === ZERO ? ZERO : r.addr;
    const amt = r.dec >= 18 ? 10n ** 16n : 10n ** BigInt(Math.max(r.dec - 2, 0));
    try {
      const ret = await p.call({ to: ZQ, data: QUOTER.encodeFunctionData('getQuotes', [false, inTok, other, amt]) });
      const [best] = QUOTER.decodeFunctionResult('getQuotes', ret);
      quote = best[3] > 0n ? `route via ${AMM[Number(best[0])] || best[0]}` : 'NO ROUTE';
    } catch (e) { quote = 'quote failed'; }
    console.log(`${String(r.rank).padStart(8)}  ${r.sym.padEnd(8)} ${ident.padEnd(48)} ${quote}`);
  }
}
