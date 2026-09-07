#!/usr/bin/env node
// Remove one token's listing from a generated batch, calls and all.
//
// A listing is not one call. `build-foreign-listing.mjs` emits `listForeign`,
// then `setStandard`, then `setArt`, then optionally `setLogoSVG` and any
// `setExtra` - all keyed to an id derived from the token. Dropping the
// `listForeign` alone would leave the rest pointing at an id that no longer
// exists, and `_mustEdit` reverts `Unknown()` on the first of them, taking the
// whole atomic batch with it. So this drops every call that names the id, and
// proves the survivors are byte-identical to what they were.
//
// Usage: node script/drop-listing.mjs <calldata file> <chainId> <token> <out file>
import fs from "node:fs";
import {AbiCoder, Interface, JsonRpcProvider, getAddress, keccak256, toBeHex, zeroPadValue} from "ethers";

const REGISTRY = "0x0000006013dF75A31678B786061C2B54bf531524";
const OWNER = "0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2";
const FOREIGN_FLAG = 1n << 255n;

const iface = new Interface([
  "function multicall(bytes[] data) payable returns (bytes[])",
  "function listForeign(uint8,uint64,bytes32 account,string,string,uint8,uint24,uint32,string)",
]);

const [file, chainIdArg, tokenArg, outFile] = process.argv.slice(2);
if (!file || !chainIdArg || !tokenArg || !outFile) {
  console.error("usage: <calldata file> <chainId> <token> <out file>");
  process.exit(1);
}
const chainId = Number(chainIdArg);
const token = getAddress(tokenArg);
const account = zeroPadValue(token, 32);
const id = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(
  ["uint8", "uint64", "bytes32"], [0, chainId, account]))) | FOREIGN_FLAG;
const idWord = toBeHex(id, 32).slice(2).toLowerCase();
const acctWord = account.slice(2).toLowerCase();

const before = fs.readFileSync(file, "utf8").trim();
const original = iface.decodeFunctionData("multicall", before)[0];

// A call belongs to this listing if it is the `listForeign` naming the account,
// or any later call whose first argument is the id that listing gets.
const kept = [], dropped = [];
for (const c of original) {
  const body = c.slice(10).toLowerCase();
  const isList = c.slice(0, 10) === iface.getFunction("listForeign").selector && body.slice(128, 192) === acctWord;
  const namesId = body.slice(0, 64) === idWord;
  (isList || namesId ? dropped : kept).push(c);
}
if (!dropped.length) { console.error(`no calls for ${token} in ${file}`); process.exit(1); }

const after = iface.encodeFunctionData("multicall", [kept]);
const reread = iface.decodeFunctionData("multicall", after)[0];
if (reread.length !== kept.length) throw Error("call count is wrong");
for (let i = 0; i < kept.length; i++) if (reread[i] !== kept[i]) throw Error(`surviving call ${i} changed`);
// And nothing that survived may still name the dead id.
for (const c of kept) if (c.slice(10).toLowerCase().slice(0, 64) === idWord) throw Error("a surviving call still names the dropped id");

const p = new JsonRpcProvider("https://ethereum-rpc.publicnode.com", 1, {staticNetwork: true});
await p.call({from: OWNER, to: REGISTRY, data: after});

fs.writeFileSync(outFile, after + "\n");
console.log(`dropped ${dropped.length} call(s) for ${token} (id ${toBeHex(id, 32)})`);
console.log(`  ${original.length} calls -> ${kept.length}, ${(before.length - 2) / 2} -> ${(after.length - 2) / 2} bytes`);
console.log(`  survivors byte-identical, none reference the dropped id, batch simulates clean from the owner`);
console.log(`  wrote ${outFile}`);
