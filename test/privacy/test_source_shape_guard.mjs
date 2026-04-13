#!/usr/bin/env node
//
// Privacy source-shape guard.
//
// Prevents the privacy suite from drifting back to tests that depend on
// function ordering, local variable names, or source-text anchors.
//
// Usage: node test/privacy/test_source_shape_guard.mjs
//
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestRunner, loadPrivacyTestApi } from './_app_source_utils.mjs';

const { test, done } = createTestRunner();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const allowedFiles = new Set([
  '_app_source_utils.mjs',
  'test_markup_contracts.mjs',
  'test_source_shape_guard.mjs',
]);

const forbiddenPatterns = [
  { label: 'extractAppFunctions', regex: /\bextractAppFunctions\s*\(/ },
  { label: 'getSourceSlice', regex: /\bgetSourceSlice\s*\(/ },
  { label: 'getAppSourceSlice', regex: /\bgetAppSourceSlice\s*\(/ },
  { label: 'APP_HTML.includes', regex: /\bAPP_HTML\.includes\s*\(/ },
  { label: 'APP_HTML.indexOf', regex: /\bAPP_HTML\.indexOf\s*\(/ },
  { label: 'loadPrivacyMarkupSource outside markup tests', regex: /\bloadPrivacyMarkupSource\s*\(/ },
  { label: 'loader destructuring source', regex: /\{[^}]*\bsource\b[^}]*\}\s*=\s*loadPrivacyTestApi\b/ },
  { label: 'loader destructuring runtimeSource', regex: /\{[^}]*\bruntimeSource\b[^}]*\}\s*=\s*loadPrivacyTestApi\b/ },
  { label: 'function-marker indexOf anchor', regex: /\bindexOf\(\s*['"](?:async\s+)?function\s+/ },
  { label: 'public api.state access', regex: /\bapi\.state\b/ },
  { label: 'generic state.apply access', regex: /\bstate\.apply\b/ },
  { label: 'generic state.snapshot access', regex: /\bstate\.snapshot\b/ },
  { label: 'harness setState wrapper', regex: /\bsetState\s*\(/ },
  { label: 'harness getState wrapper', regex: /\bgetState\s*\(/ },
  { label: 'runtime bootstrap helper access', regex: /\bppBootstrapInternalTestState\b/ },
];

console.log('\n-- Privacy source-shape guard --');

test('privacy tests avoid source-shape assertions outside the markup contract file', () => {
  const files = readdirSync(__dirname).filter((file) => file.endsWith('.mjs'));
  for (const file of files) {
    if (allowedFiles.has(file)) continue;
    const source = readFileSync(path.join(__dirname, file), 'utf8');
    for (const pattern of forbiddenPatterns) {
      assert(!pattern.regex.test(source), `${file} reintroduced forbidden source-shape pattern: ${pattern.label}`);
    }
  }
});

test('normal privacy loader no longer returns raw source fields', () => {
  const utilsSource = readFileSync(path.join(__dirname, '_app_source_utils.mjs'), 'utf8');
  assert(!/runtimeSource\s*:/.test(utilsSource), 'loadPrivacyTestApi returned runtimeSource again');
  assert(!/source\s*:/.test(utilsSource), 'loadPrivacyTestApi returned source again');
  assert(/export function loadPrivacyMarkupSource\s*\(/.test(utilsSource), 'missing dedicated markup loader');
  assert(!/ppBootstrapInternalTestState/.test(utilsSource), 'loader should not call a runtime bootstrap helper');
});

test('public privacy test api no longer exposes generic state topology', () => {
  const { api, context } = loadPrivacyTestApi();
  assert.equal('state' in api, false, 'public __PP_TEST_API__ should not expose state');
  assert.equal('ppBootstrapInternalTestState' in context, false, 'runtime should not expose bootstrap helper');
});

await done();
