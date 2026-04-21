#!/usr/bin/env node
// Regenerates src/zSwap.sol from zSwap.html:
//   - hex-encodes the HTML into the bytes.concat() payload chunks
//   - updates the "(NNNNN B)" payload-size mention in the natspec
//   - updates the "(... B cap, NN B headroom)" headroom mention in the natspec
//   - rewrites the trailing /* ===== zSwap.html source ===== */ comment block
// Aborts if the HTML exceeds EIP-170 (24576 B) or contains a "*/" sequence.
// Run: node script/build-zSwap.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'zSwap.html');
const SOL_PATH = path.join(ROOT, 'src', 'zSwap.sol');

const EIP170_LIMIT = 24576;
const BYTES_PER_LINE = 80;
const INDENT = ' '.repeat(12);

const html = fs.readFileSync(HTML_PATH);
if (html.length > EIP170_LIMIT) {
  console.error(`ERROR: HTML is ${html.length} B, exceeds EIP-170 cap of ${EIP170_LIMIT} B by ${html.length - EIP170_LIMIT} B.`);
  process.exit(1);
}

const hex = html.toString('hex');
const lines = [];
for (let i = 0; i < hex.length; i += BYTES_PER_LINE * 2) {
  lines.push(`${INDENT}hex"${hex.slice(i, i + BYTES_PER_LINE * 2)}"`);
}
const hexBlock = lines.join('\n');

const sol = fs.readFileSync(SOL_PATH, 'utf8');

const startMarker = 'bytes memory payload = bytes.concat(\n';
const endMarker = '\n        );';
const startIdx = sol.indexOf(startMarker);
const endIdx = sol.indexOf(endMarker, startIdx);
if (startIdx === -1 || endIdx === -1) {
  console.error('ERROR: could not locate bytes.concat block in zSwap.sol');
  process.exit(1);
}

const replaced =
  sol.slice(0, startIdx + startMarker.length) +
  hexBlock +
  sol.slice(endIdx);

const sizedComment = replaced
  .replace(/(HTML payload \()\d+( B\))/, `$1${html.length}$2`)
  .replace(/(\d+ B cap, )\d+( B headroom)/, `$1${EIP170_LIMIT - html.length}$2`);

const htmlText = html.toString('utf8');
if (htmlText.includes('*/')) {
  console.error('ERROR: zSwap.html contains "*/" which would break the trailing Solidity block comment.');
  process.exit(1);
}

const sourceMarker = '\n\n/* ===== zSwap.html source';
const beforeSource = sizedComment.includes(sourceMarker)
  ? sizedComment.slice(0, sizedComment.indexOf(sourceMarker))
  : sizedComment.replace(/\s*$/, '');

const sourceBlock =
  `\n\n/* ===== zSwap.html source (canonical, byte-for-byte equivalent of the embedded payload) =====\n\n` +
  htmlText +
  `\n===== end of zSwap.html source ===== */\n`;

fs.writeFileSync(SOL_PATH, beforeSource + sourceBlock);

const headroom = EIP170_LIMIT - html.length;
console.log(`zSwap.html: ${html.length} B (${headroom} B headroom)`);
console.log(`src/zSwap.sol: updated with ${lines.length} hex chunks`);
