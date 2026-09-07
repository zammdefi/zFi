#!/usr/bin/env node
// List a Base or Robinhood token on the canonical TokenList (mainnet,
// token.list.wei.limo) as a foreign eip155 listing, from the registry owner's
// multisig. Emits ONE `multicall(bytes[])` calldata file per run, so a listing
// is never briefly visible half-built, plus a record the Safe UI can be filled
// from.
//
// WHY THIS SHAPE. zSwap's dropdown on a chain is whatever the mainnet registry
// lists for that chain id (`loadTokenListRun` keeps rows with `k=eip155` and
// `c=CHAIN_ID`), falling back to the page's built-in list only when the registry
// has nothing swappable there. So the way to iterate the Base or Robinhood list
// is to list, rank, re-art or delist here - never to edit the page.
//
// A foreign listing has no on-chain source the registry can read, so name,
// symbol and decimals are typed by the owner. This script reads them from the
// token ON ITS OWN CHAIN and refuses to guess, and the page verifies `decimals`
// against the chain again when it renders, so a typo cannot mis-scale amounts.
//
// Usage:
//   node script/build-foreign-listing.mjs --chain 8453 --token 0x8335…2913 \
//     --like 0xA0b8…eB48            # copy logo, colour and rank from this mainnet listing
//     [--logo path.svg] [--color 2775ca] [--rank 995000] [--url …] [--desc …]
//     [--extra origin=bitcoin]      # any bytes32-keyed note, repeatable
//     [--v4pool v1:0:0:60:0x2C67…6444]  # a v4 pool key, hooked or not
//     [--token 0x… --like 0x… …]    # more tokens: one multicall lists them all
//     [--out deploy/USDC-8453-list]
//
// `--like` also records the equivalence as an extra (`eq` = eip155:1:<address>),
// so a consumer can tell that Base USDC is the same asset as mainnet USDC.

import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {AbiCoder, Interface, JsonRpcProvider, getAddress, keccak256, toBeHex, zeroPadValue} from "ethers";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "0x0000006013dF75A31678B786061C2B54bf531524";
const OWNER = "0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2";
const MAINNET = "https://ethereum-rpc.publicnode.com";
const CHAINS = {
  8453: {name: "Base", rpc: "https://mainnet.base.org"},
  4663: {name: "Robinhood", rpc: "https://rpc.mainnet.chain.robinhood.com"},
};
const FOREIGN_FLAG = 1n << 255n;
const ZERO_ADDR = "0x" + "00".repeat(20);
const KIND_EVM = 0;
const STANDARD_ERC20 = 2;

const registry = new Interface([
  "function listForeign(uint8 kind,uint64 chainId,bytes32 account,string name_,string symbol_,uint8 decimals_,uint24 color,uint32 rank,string logo) returns (uint256)",
  "function setStandard(uint256 id,uint8 standard_)",
  "function setArt(uint256 id,uint24 color,uint32 rank,string logo,string url_,string description_)",
  "function setLogoSVG(uint256 id,string svg)",
  "function setExtra(uint256 id,bytes32 key,string value)",
  "function multicall(bytes[] data) payable returns (bytes[])",
  "function isListed(uint256 id) view returns (bool)",
  "function json(uint256 id) view returns (string)",
]);
const erc20 = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : undefined; };
const chainId = Number(flag("--chain"));
if (!CHAINS[chainId]) { console.error("usage: --chain 8453|4663 --token 0x… [--like 0x…] …"); process.exit(1); }
// Tokens are grouped with whatever `--like/--logo/--color/--rank/--url/--desc/--extra`
// follow them, up to the next `--token`.
const jobs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--token") jobs.push({token: getAddress(argv[++i]), extras: []});
  else if (argv[i] === "--like" && jobs.length) jobs.at(-1).like = getAddress(argv[++i]);
  else if (argv[i] === "--logo" && jobs.length) jobs.at(-1).logo = argv[++i];
  else if (argv[i] === "--color" && jobs.length) jobs.at(-1).color = argv[++i];
  else if (argv[i] === "--rank" && jobs.length) jobs.at(-1).rank = Number(argv[++i]);
  else if (argv[i] === "--url" && jobs.length) jobs.at(-1).url = argv[++i];
  else if (argv[i] === "--desc" && jobs.length) jobs.at(-1).desc = argv[++i];
  else if (argv[i] === "--extra" && jobs.length) jobs.at(-1).extras.push(argv[++i]);
  else if (argv[i] === "--v4pool" && jobs.length) jobs.at(-1).v4pool = argv[++i];
}
if (!jobs.length) { console.error("at least one --token is required"); process.exit(1); }
const outBase = flag("--out");

// ------------------------------------------------------------------ helpers

const l2 = new JsonRpcProvider(CHAINS[chainId].rpc, chainId, {staticNetwork: true});
const l1 = new JsonRpcProvider(MAINNET, 1, {staticNetwork: true});
const call = async (p, to, iface, fn, args = []) => iface.decodeFunctionResult(fn, await p.call({to, data: iface.encodeFunctionData(fn, args)}));
const foreignId = (id, account) =>
  (BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["uint8", "uint64", "bytes32"], [KIND_EVM, id, account]))) | FOREIGN_FLAG);
// An extra key is a raw bytes32. The renderer prints it as a WORD when every
// byte is printable ASCII and as HEX otherwise, and the page matches on what it
// printed - so a key that is a hash has to be passed as its hash. `zfi.v4pool`
// is one: writing it as `bytes32("zfi.v4pool")` renders the word `zfi.v4pool`,
// which the page never looks for, and the pool is silently invisible.
const label = (s) => {
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  const b = Buffer.from(s, "utf8");
  if (!b.length || b.length > 32) throw Error(`extra key must be 1-32 bytes or a 0x-prefixed bytes32: ${s}`);
  if (b.some((c) => c < 0x20 || c > 0x7e)) throw Error(`extra key must be printable ASCII or a bytes32: ${s}`);
  return "0x" + b.toString("hex").padEnd(64, "0");
};

// `TokenList.EXTRA_MAX`. `setExtra` TRUNCATES past it rather than reverting, so
// an over-long value is stored sheared - and a pool key cut mid-address routes
// nowhere while still looking like a listing that has one.
const EXTRA_MAX = 256;

/// keccak256("zfi.v4pool") - the key zSwap reads pool keys from.
const V4POOL_KEY = "0x95a932c205571d4d1ca72715c642a2eca21dde79ffc28ff11509681f9383385f";

// Chains where a published v4 pool can actually be quoted. zSwap prices every
// pool it reads from this extra by running it through a V4QuoteLens; where none
// is deployed the page's `V4LENS === ZERO` guard drops them all and the swapper
// sees no route, so publishing one there is writing a promise nothing can keep.
// One CREATE3 address on every chain, each holding that chain's build bound to
// that chain's Uniswap V4Quoter. See deploy/V4QuoteLensL2.md.
const V4LENS_ADDRESS = "0x00000000Dc6f467A7AA88e216a904Cf758453EbC";
const V4LENS = {1: V4LENS_ADDRESS, 8453: V4LENS_ADDRESS, 4663: V4LENS_ADDRESS};

/**
 * Parse a `zfi.v4pool` value EXACTLY as zSwap's `parseV4Pools` does, and refuse
 * anything it would drop.
 *
 *   v1 : other : fee : tickSpacing : hooks   (`;`-separated, up to 8)
 *
 * `other` is the currency paired against the LISTED token (`0` for native ETH)
 * and the listed token is not repeated - the entry is already on its listing.
 * The page sorts the pair to recover currency0/currency1.
 *
 * Every rejection here is a pool the page would silently skip: it has no way to
 * report a malformed spec, so the only place a typo can be caught is before the
 * multisig signs it.
 */
const parseV4Pools = (spec, token) => {
  const specs = spec.split(";").map((x) => x.trim()).filter(Boolean);
  if (!specs.length) throw Error("--v4pool is empty");
  if (specs.length > 8) throw Error(`--v4pool carries ${specs.length} pools; the page reads 8`);
  return specs.map((one) => {
    const p = one.split(":");
    if (p.length !== 5 || p[0] !== "v1") throw Error(`--v4pool: expected v1:other:fee:tickSpacing:hooks, got ${one}`);
    const addr = (x, what) => {
      if (x === "0") return "0x" + "00".repeat(20);
      if (!/^0x[0-9a-fA-F]{40}$/.test(x)) throw Error(`--v4pool: ${what} is not an address or 0: ${x}`);
      return getAddress(x);
    };
    const other = addr(p[1], "other");
    const hooks = addr(p[4], "hooks");
    if (!/^\d{1,7}$/.test(p[2]) || !/^\d{1,7}$/.test(p[3])) throw Error(`--v4pool: fee and tickSpacing are 1-7 digits: ${one}`);
    if (Number(p[3]) < 1) throw Error(`--v4pool: tickSpacing must be at least 1: ${one}`);
    if (other.toLowerCase() === token.toLowerCase()) throw Error(`--v4pool: a pool cannot pair ${token} with itself`);
    return {other, fee: Number(p[2]), ts: Number(p[3]), hooks};
  });
};
const svgFromDataUrl = (u) => {
  const m = /^data:image\/svg\+xml;base64,(.+)$/.exec(u || "");
  return m ? Buffer.from(m[1], "base64").toString("utf8") : null;
};

// ------------------------------------------------------------------ build

const calls = [];
const record = [];
for (const j of jobs) {
  const code = await l2.getCode(j.token);
  if (code.length <= 2) throw Error(`${j.token} has no code on ${CHAINS[chainId].name}`);
  const [name] = await call(l2, j.token, erc20, "name");
  const [symbol] = await call(l2, j.token, erc20, "symbol");
  const [decimals] = await call(l2, j.token, erc20, "decimals");
  if (name.length > 40 || symbol.length > 12) throw Error(`${symbol}: name ≤ 40 and symbol ≤ 12 characters on the registry`);
  const account = zeroPadValue(j.token, 32);
  const id = foreignId(chainId, account);
  const [listed] = await call(l1, REGISTRY, registry, "isListed", [id]);
  if (listed) throw Error(`${symbol} on ${chainId} is already listed as id ${toBeHex(id)}`);

  // The mainnet equivalent, if any: its logo, colour and rank carry over so the
  // L2 list reads like the mainnet one, and the equivalence is written down.
  let like = null;
  if (j.like) {
    const [js] = await call(l1, REGISTRY, registry, "json", [BigInt(j.like)]);
    like = JSON.parse(js);
    if (like.k !== "eip155" || Number(like.c) !== 1) throw Error(`--like must name a mainnet listing, got ${like.k}:${like.c}`);
  }
  const color = parseInt((j.color || (like && like.t ? like.t.replace("#", "") : "627eea")), 16);
  const rank = j.rank ?? (like ? Number(like.r) : 900_000);
  const svg = j.logo ? fs.readFileSync(path.resolve(j.logo), "utf8") : like ? svgFromDataUrl(like.l) : null;
  if (svg && !svg.includes("http://www.w3.org/2000/svg")) throw Error(`${symbol}: the logo must be SVG markup carrying the svg namespace`);
  const url = j.url ?? (like ? like.u || "" : "");
  const desc = j.desc ?? (like ? `${like.n || symbol} on ${CHAINS[chainId].name}` : "");
  const extras = j.extras.map((e) => { const i = e.indexOf("="); return [e.slice(0, i), e.slice(i + 1)]; });
  if (like) extras.unshift(["eq", `eip155:1:${j.like.toLowerCase()}`]);

  // A v4 pool key, checked against the chain it names before it is written.
  // The page cannot report a bad one - it drops what it cannot parse and routes
  // through what is left - so a hook address that is an EOA, or a pool nobody
  // can quote, has to be refused here or not at all.
  if (j.v4pool) {
    const pools = parseV4Pools(j.v4pool, j.token);
    for (const q of pools) {
      if (q.hooks !== ZERO_ADDR && (await l2.getCode(q.hooks)).length <= 2) throw Error(`${symbol}: hook ${q.hooks} has no code on ${CHAINS[chainId].name}`);
      if (q.other !== ZERO_ADDR && (await l2.getCode(q.other)).length <= 2) throw Error(`${symbol}: paired currency ${q.other} has no code on ${CHAINS[chainId].name}`);
    }
    // Not only the hooked ones. The page reads EVERY pool it takes from this
    // extra through the lens, so with `V4LENS` zero it quotes none of them and
    // the listing carries a route the swapper can never be offered.
    if (!V4LENS[chainId]) {
      throw Error(`${symbol}: chain ${chainId} has no V4QuoteLens, so zSwap quotes nothing from a zfi.v4pool entry there - see deploy/L2Listing.md`);
    }
    extras.push([V4POOL_KEY, j.v4pool.split(";").map((x) => x.trim()).filter(Boolean).join(";")]);
  }
  for (const [k, v] of extras) {
    if (v.length > EXTRA_MAX) throw Error(`${symbol}: extra ${k} is ${v.length} characters; setExtra truncates past ${EXTRA_MAX}`);
  }

  const mine = [];
  mine.push(registry.encodeFunctionData("listForeign", [KIND_EVM, chainId, account, name, symbol, decimals, color, rank, ""]));
  mine.push(registry.encodeFunctionData("setStandard", [id, STANDARD_ERC20]));
  if (url || desc) mine.push(registry.encodeFunctionData("setArt", [id, color, rank, "", url, desc]));
  if (svg) mine.push(registry.encodeFunctionData("setLogoSVG", [id, svg]));
  for (const [k, v] of extras) mine.push(registry.encodeFunctionData("setExtra", [id, label(k), v]));
  calls.push(...mine);
  record.push({symbol, name, decimals: Number(decimals), token: j.token, id: toBeHex(id, 32), rank, color: color.toString(16).padStart(6, "0"), logo: !!svg, like: j.like || null, extras, calls: mine.length});
  console.log(`${symbol.padEnd(8)} ${j.token}  dec=${decimals}  rank=${rank}  logo=${svg ? "yes" : "no"}  id=${toBeHex(id, 32)}  (${mine.length} calls)`);
}

const data = registry.encodeFunctionData("multicall", [calls]);
// Simulate the whole batch from the owner before writing anything.
try {
  await l1.call({from: OWNER, to: REGISTRY, data});
} catch (e) {
  console.error("the batch would revert from the owner:", e.shortMessage || e.message);
  process.exit(1);
}
const base = outBase || path.join("deploy", `${record.map((r) => r.symbol).join("+")}-${chainId}-list`);
fs.writeFileSync(path.join(ROOT, base + ".calldata.txt"), data + "\n");
const rows = record.map((r) => `| ${r.symbol} | \`${r.token}\` | ${r.decimals} | ${r.rank} | ${r.logo ? "yes" : "no"} | ${r.like ? "`" + r.like + "`" : "—"} | ${r.calls} |`).join("\n");
fs.writeFileSync(path.join(ROOT, base + ".md"), `# List ${record.map((r) => r.symbol).join(", ")} on ${CHAINS[chainId].name} — registry owner tx

One transaction: a \`multicall\` of ${calls.length} owner calls, atomic. Generated by
\`script/build-foreign-listing.mjs\`; name, symbol and decimals were read from each
token on chain ${chainId}, and the batch simulated cleanly from the owner.

## Transaction

| field | value |
| --- | --- |
| to | \`${REGISTRY}\` (TokenList registry, mainnet) |
| value | \`0\` |
| data | contents of [\`${path.basename(base)}.calldata.txt\`](./${path.basename(base)}.calldata.txt) |
| from | \`${OWNER}\` (registry owner) |
| operation | CALL (not delegatecall) |

${(data.length - 2) / 2} bytes, selector \`0xac9650d8\` (\`multicall(bytes[])\`).

## Listings

| symbol | token on ${chainId} | dec | rank | logo | mainnet equivalent | calls |
|---|---|---|---|---|---|---|
${rows}

Each listing is \`listForeign\` (EVM, ${chainId}) → \`setStandard(ERC20)\` → \`setArt\` (url,
description) → \`setLogoSVG\` → \`setExtra\` per note. Ids are hashes of
(kind, chainId, account), so delisting and re-listing yields the same id.

Verify before sending: \`FOREIGN_LISTING=${base}.calldata.txt forge test --match-path test/ForeignListingTx.t.sol\`
replays this exact calldata against a mainnet fork as the owner and reads every
field back.
`);
console.log(`\nwrote ${base}.calldata.txt (${(data.length - 2) / 2} bytes, ${calls.length} calls) and ${base}.md`);
