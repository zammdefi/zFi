#!/usr/bin/env node
//
// Privacy markup and copy contract tests.
//
// Keeps true HTML/copy contracts in one place so the rest of the privacy
// suite can stay focused on behavior and internal policy contracts.
//
// Usage: node test/privacy/test_markup_contracts.mjs
//
import { strict as assert } from 'node:assert';
import { createTestRunner, loadPrivacyMarkupSource, loadPrivacyTestApi } from './_app_source_utils.mjs';

const { test, done } = createTestRunner();
const { api } = loadPrivacyTestApi();
const appHtml = loadPrivacyMarkupSource();

console.log('\n-- Privacy markup contracts --');

test('withdrawal fail-closed copy stays explicit', () => {
  assert(!appHtml.includes('Proceed anyway?'));
  assert(!appHtml.includes('Proceed with self-submit?'));
  assert(!appHtml.includes('Confirm relay fallback via entrypoint'));
  assert(!appHtml.includes('Relay quote refreshed with unchanged withdrawal data. Reusing proof.'));
  assert(!appHtml.includes('Relay withdrawal data changed after quote refresh. Re-generating proof once.'));
  assert(appHtml.includes(api.constants.messages.relayQuoteRetryRequired));
});

test('privacy markup exposes the stable DOM ids used by the live tests', () => {
  const ids = [
    api.constants.dom.privacyTabId,
    api.constants.dom.loadResultsId,
    api.constants.dom.activitySectionId,
    ...api.constants.dom.progressIds,
    ...api.constants.dom.draftHiddenSections,
  ];
  for (const id of ids) {
    assert(appHtml.includes(`id="${id}"`), `missing markup contract id: ${id}`);
  }
});

await done();
