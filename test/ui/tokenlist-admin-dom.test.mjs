/**
 * The admin page driven through its real DOM, against a mock registry.
 *
 * The encoder tests next door call `encodeOne` directly with a hand-built
 * object. That proves the ABI encoding and nothing about the page: the queue is
 * built by DOM handlers, the id arrives by clicking a table row, and the token's
 * name/symbol/decimals arrive from a button that talks to another chain. Every
 * one of those is a place where the operator sees a filled-in form and the
 * encoder receives something else.
 *
 * So this clicks the buttons.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { Interface } from 'ethers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = fs.readFileSync(path.join(ROOT, 'dapp/tokenlist-admin.html'), 'utf8');

const REG = '0x0000006013dF75A31678B786061C2B54bf531524';
const OWNER = '0x006cd14f36f65ecbb29b2519ccbe63a0dc8549f2';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_USDC_ID = '0xaba60ba16815f38375928895eb5685ed3aa63aff5c00cca390da03f054b8e769';
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const strOf = (s) => {
  const hex = Buffer.from(s, 'utf8').toString('hex');
  return word(Buffer.byteLength(s)) + (hex + '0'.repeat(64)).slice(0, Math.ceil(hex.length / 64) * 64 || 0);
};
const dynStr = (s) => '0x' + word(32) + strOf(s);

/** A registry with one mainnet listing and one Base token that answers metadata. */
function mockFetch(seen) {
  return async (_url, init) => {
    const req = JSON.parse(init.body);
    if (req.method === 'eth_getCode') return json({ result: '0x60006000' });
    if (req.method !== 'eth_call') throw Error('unexpected ' + req.method);
    const { to, data, from } = req.params[0];
    const sel = data.slice(2, 10);
    seen.push({ to, sel, from });
    if (sel === '8da5cb5b') return json({ result: '0x' + OWNER.slice(2).padStart(64, '0') });   // owner()
    if (sel === '2ddbd13a') return json({ result: '0x' + word(1) });                            // total()
    if (sel === 'df7ca268') return json({ result: '0x' + word(32) + word(1) + word(7) });        // rankedIds()
    if (sel === '74e18e96') return json({ result: dynStr(JSON.stringify(
      { i: '7', c: 1, k: 'eip155', p: 'ERC-20', a: '0x' + '11'.repeat(20), n: 'Seven', s: 'SEVEN', d: 18, r: 900000, e: [], v: true })) });
    if (sel === '7695a541') return json({ result: BASE_USDC_ID });                               // idOf
    if (sel === '06fdde03') return json({ result: dynStr('USD Coin') });
    if (sel === '95d89b41') return json({ result: dynStr('USDC') });
    if (sel === '313ce567') return json({ result: '0x' + word(6) });
    if (sel === 'ac9650d8') return json({ result: '0x' });                                       // multicall simulation
    throw Error('unhandled selector ' + sel);
  };
}
const json = (o) => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, ...o }) });

function open(seen) {
  const dom = new JSDOM(HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  dom.window.fetch = mockFetch(seen);
  // Browsers have had these as globals since 2018 and the page uses them to turn
  // ABI strings into bytes; jsdom does not put them on its window. Without this
  // every `decStr` throws inside the page's own try/catch and the table silently
  // reads back empty - which is exactly how this looked the first time it ran.
  dom.window.TextEncoder = TextEncoder;
  dom.window.TextDecoder = TextDecoder;
  return dom.window;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await tick(); };

test('Load listings paints what the registry returns', async () => {
  const seen = [];
  const w = open(seen);
  w.document.getElementById('load').onclick();
  await settle();
  const rows = w.document.querySelectorAll('#listing tbody tr');
  assert.equal(rows.length, 2, 'a header row and one listing');
  assert.equal(rows[1].children[0].textContent, 'SEVEN');
  assert.equal(rows[1].children[1].textContent, '1');
  assert.match(w.document.getElementById('regmeta').textContent, /1 listings/);
});

test('a queued listForeign reads metadata from the token chain and pairs itself with setStandard', async () => {
  const seen = [];
  const w = open(seen);
  const add = [...w.document.querySelectorAll('[data-add]')].find((b) => b.dataset.add === 'listForeign');
  add.onclick();
  await settle();

  // Fill the form the way an operator does: type into the inputs.
  const set = (field, value) => {
    const el = w.document.querySelector(`#rows [data-f="${field}"]`);
    assert.ok(el, `no input for ${field}`);
    el.value = value;
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  set('chainId', '8453');
  set('token', BASE_USDC);
  await settle();

  // The "read from that chain" button is the only way name/symbol/decimals get set.
  const btn = [...w.document.querySelectorAll('#rows button')].find((b) => /Read name/.test(b.textContent));
  assert.ok(btn, 'no metadata button on a listForeign row');
  btn.onclick();
  await settle(30);

  assert.equal(w.document.querySelector('#rows [data-f="symbol"]').value, 'USDC');
  assert.equal(w.document.querySelector('#rows [data-f="decimals"]').value, '6');

  await settle(20);
  const text = w.document.getElementById('data').textContent;
  assert.match(text, /^0xac9650d8/, 'the batch is a multicall');
  assert.match(text, /2 owner calls/, 'listForeign must be paired with setStandard');

  const iface = new Interface([
    'function multicall(bytes[] data)',
    'function listForeign(uint8,uint64,bytes32,string,string,uint8,uint24,uint32,string)',
    'function setStandard(uint256,uint8)',
  ]);
  const calls = iface.decodeFunctionData('multicall', text.split('\n')[0])[0];
  assert.equal(calls.length, 2);
  const lf = iface.decodeFunctionData('listForeign', calls[0]);
  assert.equal(lf[1], 8453n, 'chain id');
  assert.equal(lf[3], 'USD Coin', 'name came from the chain, not the operator');
  assert.equal(lf[4], 'USDC');
  assert.equal(lf[5], 6n, 'decimals');
  const ss = iface.decodeFunctionData('setStandard', calls[1]);
  assert.equal(ss[0], BigInt(BASE_USDC_ID), 'setStandard targets the id the registry derived');
  assert.equal(ss[1], 2n, 'ERC20');
});

test('clicking a listing row fills the id of the action being edited', async () => {
  const seen = [];
  const w = open(seen);
  w.document.getElementById('load').onclick();
  await settle();
  [...w.document.querySelectorAll('[data-add]')].find((b) => b.dataset.add === 'delist').onclick();
  await settle();
  w.document.querySelectorAll('#listing tbody tr')[1].onclick();
  await settle();
  const id = w.document.querySelector('#rows [data-f="id"]').value;
  assert.equal(BigInt(id), 7n, 'the row id reached the form');
  const text = w.document.getElementById('data').textContent;
  assert.match(text, /1 owner call\b/);
});

test('Simulate calls the registry as the owner, not as the browser', async () => {
  const seen = [];
  const w = open(seen);
  [...w.document.querySelectorAll('[data-add]')].find((b) => b.dataset.add === 'delist').onclick();
  await settle();
  const el = w.document.querySelector('#rows [data-f="id"]');
  el.value = '0x07';
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
  await settle();
  w.document.getElementById('sim').onclick();
  await settle(20);
  const sim = seen.find((c) => c.sel === 'ac9650d8');
  assert.ok(sim, 'the batch was never simulated');
  assert.equal(sim.from.toLowerCase(), OWNER, 'simulated as the owner');
  assert.match(w.document.getElementById('status').textContent, /simulation passed as the owner/);
});
