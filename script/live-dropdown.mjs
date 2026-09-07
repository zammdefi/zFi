#!/usr/bin/env node
// The dropdown a chain gets from the registry AS IT STANDS ON MAINNET NOW.
//
// The sibling `simulate-dropdown.mjs` applies a batch on a fork to predict this.
// Once the batch is executed for real there is no need to predict: read the live
// registry the way the page does, and run the page against it.
//
// Usage: node script/live-dropdown.mjs <chainId>
import { A, MockChain, loadPage, fixedRateQuoter, closeAllPages } from "../test/ui/harness.mjs";

const REG = "0x0000006013dF75A31678B786061C2B54bf531524";
const RPC = process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com";
const chainId = Number(process.argv[2]);
if (!chainId) { console.error("usage: <chainId>"); process.exit(1); }
const ETH = 10n ** 18n;

const call = async (data) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: REG, data }, "latest"] }) });
  const j = await r.json();
  if (j.error) throw Error(j.error.message);
  return j.result;
};
const decStr = (h) => {
  const b = h.replace(/^0x/, "");
  const off = Number(BigInt("0x" + b.slice(0, 64))) * 2;
  const len = Number(BigInt("0x" + b.slice(off, off + 64)));
  return Buffer.from(b.slice(off + 64, off + 64 + len * 2), "hex").toString();
};

const raw = await call("0xdf7ca268");
const b = raw.replace(/^0x/, "");
const n = Number(BigInt("0x" + b.slice(64, 128)));
const rows = [];
for (let i = 0; i < n; i++) {
  const id = BigInt("0x" + b.slice(128 + i * 64, 192 + i * 64));
  rows.push(JSON.parse(decStr(await call("0x74e18e96" + id.toString(16).padStart(64, "0")))));
}
console.log(`live registry: ${rows.length} listings\n`);

const chain = new MockChain({ chainId: "0x" + chainId.toString(16) });
chain.registry = rows;
chain.conviction = rows.map((_, i) => i + 1);
chain.setNative(A.ACCOUNT, 10n * ETH);
chain.quoteHandler = fixedRateQuoter({ rate: 3000n * ETH });
for (const t of rows) {
  if (Number(t.c) !== chainId) continue;
  if (!/^0x[0-9a-fA-F]{40}$/.test(t.a || "") || /^0x0{40}$/.test(t.a)) continue;
  chain.setToken(t.a, { symbol: t.s, decimals: t.d, name: t.n });
}
const page = await loadPage({ chain, hash: null });
await page.waitFor(() => page.window.eval("listLive"), { label: "the registry list" });
const shown = page.window.eval("TOKENS.map(t=>({sym:t.sym,addr:t.addr,dec:t.dec,std:t.std,v4:(t.v4||[]).length,desc:t.desc,art:t.icon.startsWith('<img')?'registry svg':'generated initial'}))");
console.log(`dropdown on chain ${chainId} — ${shown.length} rows`);
for (const t of shown) console.log(`  ${t.sym.padEnd(8)} ${t.addr} ${String(t.dec).padStart(2)}dec ${t.std}  ${t.art}${t.v4 ? ` v4pools=${t.v4}` : ""}`);
console.log(`\nlist note: ${page.text("listNote") || "(none)"}`);
page.close();
await closeAllPages();
