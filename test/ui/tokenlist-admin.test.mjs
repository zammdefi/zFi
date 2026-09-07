/**
 * The admin page hand-encodes ABI calldata, and that calldata goes to a
 * multisig that signs it against a live registry holding the canonical token
 * list. There is no compiler between the page and the chain, so an offset that
 * is one word out does not fail loudly — it produces a well-formed transaction
 * that writes something other than what the operator typed.
 *
 * So every encoder is compared against ethers' own Interface, argument for
 * argument, including the shapes most likely to be got wrong: several dynamic
 * tails in one call, an empty string, a string that lands exactly on a word
 * boundary, and one that does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Interface, getAddress } from 'ethers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(ROOT, 'dapp/tokenlist-admin.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

/** Run the page's script with just enough DOM for its module-level code. */
function load() {
  const els = new Map();
  const stub = () => ({
    value: '', textContent: '', innerHTML: '', className: '', style: {}, dataset: {},
    appendChild() {}, addEventListener() {}, querySelector: () => null,
    querySelectorAll: () => [], onclick: null, onchange: null,
  });
  const ctx = {
    document: {
      getElementById: (id) => { if (!els.has(id)) els.set(id, stub()); return els.get(id); },
      createElement: stub,
      querySelectorAll: () => [],
    },
    fetch: async () => { throw Error('no network in this test'); },
    TextEncoder, TextDecoder, BigInt, Number, Math, String, Array, JSON, Error, Event,
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // The page's encoders are top-level `const`, so evaluate and then hand them
  // back out by name rather than reaching into a closure.
  vm.runInContext(script + '\n;globalThis.__x = {encodeOne, extraKey, encString, encColor, V4POOL_KEY, EXTRA_MAX};', ctx);
  return ctx.__x;
}

const X = load();

const REG = new Interface([
  'function listForeign(uint8 kind,uint64 chainId,bytes32 account,string name_,string symbol_,uint8 decimals_,uint24 color,uint32 rank,string logo)',
  'function setExtra(uint256 id,bytes32 key,string value)',
  'function setArt(uint256 id,uint24 color,uint32 rank,string logo,string url_,string description_)',
  'function setRank(uint256 id,uint32 rank)',
  'function setStandard(uint256 id,uint8 standard_)',
  'function delist(uint256 id)',
  'function sync(uint256 id)',
]);

const TOKEN = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ID = '0xaba60ba16815f38375928895eb5685ed3aa63aff5c00cca390da03f054b8e769';
const eq = (mine, theirs, what) =>
  assert.equal(mine.toLowerCase(), theirs.toLowerCase(), `${what} disagrees with ethers`);

test('listForeign — four head words and two dynamic tails', () => {
  for (const [name, symbol] of [
    ['USD Coin', 'USDC'],
    ['', ''],                                  // both tails empty
    ['x'.repeat(32), 'y'.repeat(12)],          // name lands on a word boundary
    ['x'.repeat(33), 'z'],                     // and one that does not
  ]) {
    const q = { kind: 'listForeign', v: { chainId: '8453', token: TOKEN, name, symbol, decimals: '6', color: '627eea', rank: '995000' } };
    // An empty symbol is refused by the page on purpose; encode it directly.
    if (!symbol) continue;
    eq(X.encodeOne(q),
      REG.encodeFunctionData('listForeign', [0, 8453n, '0x' + TOKEN.slice(2).toLowerCase().padStart(64, '0'), name, symbol, 6, 0x627eea, 995000, '']),
      `listForeign(${JSON.stringify(name)})`);
  }
});

test('setExtra — the v4pool key is the hash, not the word', () => {
  const q = { kind: 'setExtra', v: { id: ID, key: 'v4pool', value: 'v1:0:3000:10:0' } };
  eq(X.encodeOne(q), REG.encodeFunctionData('setExtra', [BigInt(ID), X.V4POOL_KEY, 'v1:0:3000:10:0']), 'setExtra(v4pool)');
  assert.equal(X.extraKey('v4pool'), X.V4POOL_KEY);
  assert.equal(X.extraKey('zfi.v4pool'), X.V4POOL_KEY);
  // A word key is right-padded ASCII; that is what the renderer prints as a word.
  assert.equal(X.extraKey('origin'), '0x6f726967696e' + '0'.repeat(52));
});

test('setExtra — a word key and an empty value round-trip', () => {
  for (const value of ['bitcoin', '', 'eip155:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']) {
    const q = { kind: 'setExtra', v: { id: ID, key: 'origin', value } };
    eq(X.encodeOne(q), REG.encodeFunctionData('setExtra', [BigInt(ID), X.extraKey('origin'), value]), `setExtra(${JSON.stringify(value)})`);
  }
});

test('setExtra refuses a value setExtra would silently shear', () => {
  const q = { kind: 'setExtra', v: { id: ID, key: 'origin', value: 'x'.repeat(X.EXTRA_MAX + 1) } };
  assert.throws(() => X.encodeOne(q), /truncates past 256/);
  // Exactly at the cap is fine.
  q.v.value = 'x'.repeat(X.EXTRA_MAX);
  assert.doesNotThrow(() => X.encodeOne(q));
});

test('setArt — three dynamic tails', () => {
  for (const [url, desc] of [['', ''], ['https://x.example', 'USD Coin on Base'], ['u'.repeat(32), 'd'.repeat(65)]]) {
    const q = { kind: 'setArt', v: { id: ID, color: '#f7931a', rank: '996000', url, description: desc } };
    eq(X.encodeOne(q), REG.encodeFunctionData('setArt', [BigInt(ID), 0xf7931a, 996000, '', url, desc]), `setArt(${JSON.stringify(url)})`);
  }
});

test('the fixed-width calls', () => {
  eq(X.encodeOne({ kind: 'setRank', v: { id: ID, rank: '996000' } }), REG.encodeFunctionData('setRank', [BigInt(ID), 996000]), 'setRank');
  eq(X.encodeOne({ kind: 'setStandard', v: { id: ID, standard: '2' } }), REG.encodeFunctionData('setStandard', [BigInt(ID), 2]), 'setStandard');
  eq(X.encodeOne({ kind: 'delist', v: { id: ID } }), REG.encodeFunctionData('delist', [BigInt(ID)]), 'delist');
  eq(X.encodeOne({ kind: 'sync', v: { id: ID } }), REG.encodeFunctionData('sync', [BigInt(ID)]), 'sync');
});

test('a colour survives 627eea, #627eea and 0x627eea alike', () => {
  const want = X.encColor('627eea');
  for (const c of ['#627eea', '0x627eea', '627EEA']) assert.equal(X.encColor(c), want, c);
});

test('an id that is not hex is refused rather than encoded as zero', () => {
  for (const bad of ['', 'nonsense', '12345']) {
    assert.throws(() => X.encodeOne({ kind: 'delist', v: { id: bad } }), /id must be 0x-hex/, JSON.stringify(bad));
  }
});
