#!/usr/bin/env node
// Append a `zfi.v4pool` setExtra to an already-generated listing multicall.
//
// WHY APPEND RATHER THAN REGENERATE. The batch in `deploy/` was built, reviewed
// and gas-measured; regenerating it from the command line risks quietly changing
// a colour or a description that was chosen deliberately and is not recorded in
// the .md. Decoding the multicall and pushing ONE call onto the end leaves every
// existing call byte-identical, which is checkable - and this script checks it.
//
// Usage: node script/append-v4pool.mjs <calldata file> <chainId> <token> <spec>
import fs from "node:fs";
import path from "node:path";
import {AbiCoder, Interface, JsonRpcProvider, getAddress, keccak256, zeroPadValue, toBeHex} from "ethers";

const REGISTRY = "0x0000006013dF75A31678B786061C2B54bf531524";
const OWNER = "0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2";
const V4POOL_KEY = "0x95a932c205571d4d1ca72715c642a2eca21dde79ffc28ff11509681f9383385f";
const FOREIGN_FLAG = 1n << 255n;

const iface = new Interface([
  "function multicall(bytes[] data) payable returns (bytes[])",
  "function setExtra(uint256 id,bytes32 key,string value)",
]);

const [file, chainIdArg, tokenArg, spec] = process.argv.slice(2);
if (!file || !chainIdArg || !tokenArg || !spec) {
  console.error("usage: <calldata file> <chainId> <token> <v1:other:fee:spacing:hooks>");
  process.exit(1);
}
const chainId = Number(chainIdArg);
const token = getAddress(tokenArg);
if (spec.length > 256) throw Error(`spec is ${spec.length} chars; setExtra truncates past 256`);

const account = zeroPadValue(token, 32);
const id = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["uint8", "uint64", "bytes32"], [0, chainId, account]))) | FOREIGN_FLAG;

const before = fs.readFileSync(file, "utf8").trim();
const calls = [...iface.decodeFunctionData("multicall", before)[0]];
const add = iface.encodeFunctionData("setExtra", [id, V4POOL_KEY, spec]);
if (calls.includes(add)) { console.log("already present; nothing to do"); process.exit(0); }
calls.push(add);
const after = iface.encodeFunctionData("multicall", [calls]);

// Every call that was there before must still be there, in order, unchanged.
const reread = iface.decodeFunctionData("multicall", after)[0];
const original = iface.decodeFunctionData("multicall", before)[0];
if (reread.length !== original.length + 1) throw Error("call count is wrong");
for (let i = 0; i < original.length; i++) if (reread[i] !== original[i]) throw Error(`call ${i} changed`);

const p = new JsonRpcProvider("https://ethereum-rpc.publicnode.com", 1, {staticNetwork: true});
await p.call({from: OWNER, to: REGISTRY, data: after});

fs.writeFileSync(file, after + "\n");
console.log(`appended setExtra(${toBeHex(id, 32)}, zfi.v4pool, "${spec}")`);
console.log(`${original.length} calls -> ${calls.length}, ${(before.length - 2) / 2} -> ${(after.length - 2) / 2} bytes`);
console.log("earlier calls unchanged, and the whole batch simulates clean from the owner");
