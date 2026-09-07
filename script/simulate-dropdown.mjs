#!/usr/bin/env node
// What zSwap's token dropdown ACTUALLY becomes on a chain once a batch lands.
//
// Every other check reasons about the batch. This one observes the page: it
// applies the batch on a mainnet fork, takes the registry's own `json(id)` for
// every row in ranked order - the exact bytes `loadTokenListRun` fetches - and
// feeds them to the real zSwap.html running against a mock of that L2, with the
// decimals the tokens actually report there. Then it prints the dropdown.
//
// The failure this exists to catch is the silent one: a row that is listed,
// correct on chain, and still dropped by the page - a standard the page does not
// keep, a decimals cross-check the row cannot pass, a window that does not reach
// it. None of those revert. They just leave a token missing.
//
// Usage: node script/simulate-dropdown.mjs <batch file> <chainId>
import { execFileSync } from "node:child_process";
import { A, MockChain, loadPage, fixedRateQuoter, closeAllPages } from "../test/ui/harness.mjs";

const [batch, chainIdArg] = process.argv.slice(2);
if (!batch || !chainIdArg) { console.error("usage: <batch file> <chainId>"); process.exit(1); }
const chainId = Number(chainIdArg);
const ETH = 10n ** 18n;

console.log(`applying ${batch} on a mainnet fork…`);
const out = execFileSync("forge", ["test", "--match-path", "test/ListingDump.t.sol", "-vv"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  env: {
    ...process.env,
    FOREIGN_LISTING: batch,
    ETH_RPC_URL: process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com",
    FOUNDRY_ETH_RPC_URL: process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com",
  },
});
const rows = [...out.matchAll(/^\s*ROW (\{.*\})\s*$/gm)].map((m) => JSON.parse(m[1]));
if (!rows.length) { console.error("no rows dumped — did the fork test run?"); process.exit(1); }
console.log(`registry holds ${rows.length} listings after the batch\n`);

const chain = new MockChain({ chainId: "0x" + chainId.toString(16) });
chain.registry = rows;
// The lens orders by conviction; foreign rows have none, so they sit in the
// registry's own ranked order behind whatever mainnet rows carry support. The
// page's window has to reach them anyway - that is half of what this checks.
chain.conviction = rows.map((_, i) => i + 1);
chain.setNative(A.ACCOUNT, 10n * ETH);
chain.quoteHandler = fixedRateQuoter({ rate: 3000n * ETH });
for (const t of rows) {
  if (Number(t.c) !== chainId) continue;
  if (!/^0x[0-9a-fA-F]{40}$/.test(t.a || "") || /^0x0{40}$/.test(t.a)) continue;
  chain.setToken(t.a, { symbol: t.s, decimals: t.d, name: t.n });
}

const page = await loadPage({ chain, hash: null });
await page.waitFor(() => page.window.eval("listLive"), { label: "the registry list to load" });

const shown = page.window.eval("TOKENS.map(t=>({sym:t.sym,addr:t.addr,dec:t.dec,std:t.std,desc:t.desc,v4:(t.v4||[]).length}))");
const expected = rows.filter((t) => Number(t.c) === chainId && (t.p === "ERC-20" || t.p === "Native"));

console.log(`dropdown on chain ${chainId} — ${shown.length} rows\n`);
for (const t of shown) {
  console.log(`  ${t.sym.padEnd(8)} ${t.addr}  ${String(t.dec).padStart(2)}dec  ${t.std}${t.v4 ? `  v4pools=${t.v4}` : ""}${t.desc ? `\n           ${t.desc}` : ""}`);
}
const note = page.text("listNote");
console.log(`\nlist note: ${note || "(none)"}`);

const missing = expected.filter((e) => !shown.some((s) => s.addr.toLowerCase() === e.a.toLowerCase()));
const extra = shown.filter((s) => !expected.some((e) => e.a.toLowerCase() === s.addr.toLowerCase()));
console.log(`\nlisted-and-swappable for this chain: ${expected.length}`);
if (missing.length) console.log(`MISSING from the dropdown: ${missing.map((t) => t.s).join(", ")}`);
if (extra.length) console.log(`extra rows (built-in anchors or launched pools): ${extra.map((t) => t.sym).join(", ")}`);
if (!missing.length && !extra.length) console.log("every listed row reached the dropdown, and nothing else did");

page.close();
await closeAllPages();
process.exitCode = missing.length ? 1 : 0;
