#!/usr/bin/env node
// Append a native-ETH listing to a generated foreign-listing batch.
//
// WHY IT IS MISSING AND WHY IT MATTERS. `build-foreign-listing.mjs` takes
// `--token <address>`, so it can only list contracts. The native asset has no
// address, and mainnet's own list carries it as a `listForeign(EVM, chainId, 0)`
// at rank 1,000,000 - the top row. Without the equivalent on an L2 the page's
// `anchors` fallback still puts ETH in the dropdown, but AFTER every registry
// row, because anchors are appended once the ranked rows are in. Measured: ETH
// lands 9th of 10 on Base. Listing it puts it back where mainnet has it.
//
// The art, colour and link are copied from mainnet's own ETH listing rather than
// invented: native ETH on an L2 IS ether, so it should not look like a different
// asset on a different tab.
//
// Usage: node script/append-native-eth.mjs <calldata file> <chainId> <chain name>
import fs from "node:fs";
import {AbiCoder, Interface, JsonRpcProvider, keccak256, toBeHex} from "ethers";

const REGISTRY = "0x0000006013dF75A31678B786061C2B54bf531524";
const OWNER = "0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2";
const MAINNET = "https://ethereum-rpc.publicnode.com";
const FOREIGN_FLAG = 1n << 255n;
const KIND_EVM = 0;
const STANDARD_NATIVE = 1;
const ZERO32 = "0x" + "00".repeat(32);

const iface = new Interface([
  "function multicall(bytes[] data) payable returns (bytes[])",
  "function listForeign(uint8 kind,uint64 chainId,bytes32 account,string name_,string symbol_,uint8 decimals_,uint24 color,uint32 rank,string logo) returns (uint256)",
  "function setStandard(uint256 id,uint8 standard_)",
  "function setArt(uint256 id,uint24 color,uint32 rank,string logo,string url_,string description_)",
  "function setLogoSVG(uint256 id,string svg)",
  "function json(uint256 id) view returns (string)",
  "function rankedIds() view returns (uint256[])",
  "function isListed(uint256 id) view returns (bool)",
]);

const [file, chainIdArg, chainName] = process.argv.slice(2);
if (!file || !chainIdArg || !chainName) {
  console.error("usage: <calldata file> <chainId> <chain name>");
  process.exit(1);
}
const chainId = Number(chainIdArg);

const p = new JsonRpcProvider(MAINNET, 1, {staticNetwork: true});
const call = async (fn, args) =>
  iface.decodeFunctionResult(fn, await p.call({to: REGISTRY, data: iface.encodeFunctionData(fn, args)}));

// Mainnet's own ETH row is the source of truth for what ether looks like here.
const [ids] = await call("rankedIds", []);
let eth = null;
for (const id of ids) {
  const [js] = await call("json", [id]);
  const t = JSON.parse(js);
  if (t.p === "Native" && Number(t.c) === 1) { eth = t; break; }
}
if (!eth) throw Error("mainnet has no Native listing to copy from");
const svg = (() => {
  const m = /^data:image\/svg\+xml;base64,(.+)$/.exec(eth.l || "");
  if (!m) throw Error("mainnet ETH logo is not a base64 SVG data URI");
  const s = Buffer.from(m[1], "base64").toString("utf8");
  // `setLogoSVG` reverts without this, and a revert inside a multicall takes the
  // whole batch with it.
  if (!s.includes("http://www.w3.org/2000/svg")) throw Error("copied SVG has no namespace");
  return s;
})();
const color = parseInt(String(eth.t || "#627eea").replace("#", ""), 16);

const id = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(
  ["uint8", "uint64", "bytes32"], [KIND_EVM, chainId, ZERO32]))) | FOREIGN_FLAG;
const [listed] = await call("isListed", [id]);
if (listed) { console.log("already listed; nothing to do"); process.exit(0); }

const add = [
  iface.encodeFunctionData("listForeign", [KIND_EVM, chainId, ZERO32, "Ether", "ETH", 18, color, Number(eth.r), ""]),
  iface.encodeFunctionData("setStandard", [id, STANDARD_NATIVE]),
  iface.encodeFunctionData("setArt", [id, color, Number(eth.r), "", eth.u || "", `Ether on ${chainName}`]),
  iface.encodeFunctionData("setLogoSVG", [id, svg]),
];

const before = fs.readFileSync(file, "utf8").trim();
const original = iface.decodeFunctionData("multicall", before)[0];
const calls = [...original, ...add];
const after = iface.encodeFunctionData("multicall", [calls]);

// Every call that was there before must still be there, in order, unchanged.
const reread = iface.decodeFunctionData("multicall", after)[0];
if (reread.length !== original.length + add.length) throw Error("call count is wrong");
for (let i = 0; i < original.length; i++) if (reread[i] !== original[i]) throw Error(`call ${i} changed`);

await p.call({from: OWNER, to: REGISTRY, data: after});

fs.writeFileSync(file, after + "\n");
console.log(`appended native ETH for ${chainName} (${chainId}) at rank ${eth.r}, id ${toBeHex(id, 32)}`);
console.log(`  colour #${color.toString(16).padStart(6, "0")}, ${svg.length} B of SVG copied from mainnet's ETH listing`);
console.log(`  ${original.length} calls -> ${calls.length}, ${(before.length - 2) / 2} -> ${(after.length - 2) / 2} bytes`);
console.log("  earlier calls unchanged, and the whole batch simulates clean from the owner");
