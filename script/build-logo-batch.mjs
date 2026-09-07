#!/usr/bin/env node
// One owner transaction that gives listings their artwork.
//
// `setLogoSVG` is the only owner call that takes markup rather than a URI: the
// registry base64s it into a `data:image/svg+xml` and stores THAT, so the cap
// applies to the encoded form, not the source. It also reverts unless the markup
// carries the SVG namespace - and a revert inside a multicall takes every other
// listing's art down with it, so each file is checked here before it is encoded.
//
// A listing must already exist: `setLogoSVG` goes through `_mustEdit`, which
// reverts `Unknown()` on an id that was never listed.
//
// Usage: node script/build-logo-batch.mjs <out> <chainId:token:file> ...
import fs from "node:fs";
import {AbiCoder, Interface, JsonRpcProvider, getAddress, keccak256, toBeHex, zeroPadValue} from "ethers";

const REGISTRY = "0x0000006013dF75A31678B786061C2B54bf531524";
const OWNER = "0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2";
const FOREIGN_FLAG = 1n << 255n;
const LOGO_MAX = 24_576;

const iface = new Interface([
  "function multicall(bytes[] data) payable returns (bytes[])",
  "function setLogoSVG(uint256 id,string svg)",
  "function isListed(uint256 id) view returns (bool)",
]);

const [out, ...specs] = process.argv.slice(2);
if (!out || !specs.length) { console.error("usage: <out> <chainId:token:file> ..."); process.exit(1); }

const p = new JsonRpcProvider("https://ethereum-rpc.publicnode.com", 1, {staticNetwork: true});
const calls = [], rows = [];
for (const spec of specs) {
  const [chainIdRaw, tokenRaw, file] = spec.split(":");
  const chainId = Number(chainIdRaw), token = getAddress(tokenRaw);
  const svg = fs.readFileSync(file, "utf8").trim();
  if (!svg.includes("http://www.w3.org/2000/svg")) throw Error(`${file}: no svg namespace - setLogoSVG would revert`);
  if (/<script|<foreignObject|javascript:|<!ENTITY/i.test(svg)) throw Error(`${file}: refuses active content`);
  const uri = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
  if (uri.length > LOGO_MAX) throw Error(`${file}: stored uri is ${uri.length} B, over the ${LOGO_MAX} cap`);

  const id = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(
    ["uint8", "uint64", "bytes32"], [0, chainId, zeroPadValue(token, 32)]))) | FOREIGN_FLAG;
  const [listed] = iface.decodeFunctionResult("isListed",
    await p.call({to: REGISTRY, data: iface.encodeFunctionData("isListed", [id])}));
  if (!listed) throw Error(`${token} on ${chainId} is not listed yet - setLogoSVG would revert Unknown()`);

  calls.push(iface.encodeFunctionData("setLogoSVG", [id, svg]));
  rows.push({chainId, token, file, svg: svg.length, uri: uri.length, id: toBeHex(id, 32)});
  console.log(`${String(chainId).padEnd(5)} ${token}  ${String(svg.length).padStart(5)} B svg -> ${String(uri.length).padStart(5)} B stored  ${file}`);
}

const data = iface.encodeFunctionData("multicall", [calls]);
await p.call({from: OWNER, to: REGISTRY, data});
fs.writeFileSync(out, data + "\n");
console.log(`\n${calls.length} setLogoSVG calls, ${(data.length - 2) / 2} bytes`);
console.log("simulates clean from the owner; wrote " + out);
