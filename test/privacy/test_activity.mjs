#!/usr/bin/env node
//
// Privacy Pools activity derivation tests.
//
// Covers activity history generation from recovered pool accounts,
// pool-account mapping, timestamp handling, time-ago formatting,
// sorting, and rendering edge cases.
//
// Usage: node test/privacy/test_activity.mjs
//
import { strict as assert } from 'node:assert';
import { createElement, createHarness as createPrivacyHarness, createPoseidonContext, createTestRunner, flushMicrotasks, loadPrivacyTestApi } from './_app_source_utils.mjs';

const { poseidon1, poseidon2 } = createPoseidonContext();
const { test, done } = createTestRunner();

const { api } = loadPrivacyTestApi();
const { ppNormalizeReviewStatus, ppLoadedAccountLabelKey } = api.shared;
const PP_REVIEW_STATUS = api.constants.reviewStatus;
const {
  ppBuildActivityFromAccountRows,
  ppActivityFindWithdrawnAmount,
  ppActivityGetStatus,
  ppActivityGetStatusLabel,
  ppActivityGetStatusColor,
  ppResolveActivityTimestamps,
  ppGetTimeAgo,
  ppCompareActivity,
  ppwGetVisibleActivityRows,
  ppwScheduleActivityTimestampResolution,
} = api.activity;

// ── Test helpers ─────────────────────────────────────────────────────

const SCOPE = 0xF241d57C6DebAe225c0F2e6eA1529373C9A9C9fBn;
const SAFE_KEYS = {
  masterNullifier: poseidon1([111n]),
  masterSecret: poseidon1([222n]),
};

function makeLoadedRow(overrides) {
  return {
    asset: 'ETH',
    depositIndex: 0,
    poolAddress: '0xpool',
    walletSeedVersion: 'v2',
    pending: false,
    value: '1000000000000000000',
    label: poseidon2([1n, 2n]),
    txHash: '0xdep1',
    blockNumber: 100,
    depositTxHash: '0xdep1',
    depositBlockNumber: 100,
    withdrawalIndex: null,
    source: 'deposit',
    derivation: 'safe',
    reviewStatus: PP_REVIEW_STATUS.APPROVED,
    isValid: true,
    isWithdrawable: true,
    timestamp: 1700000000,
    ragequit: false,
    ...overrides,
  };
}

function buildAssetResult(asset, rows, withdrawnMap = new Map()) {
  return { asset, rows, withdrawnMap };
}

function createLiveActivityHarness(statePatch = {}, globals = {}) {
  return createPrivacyHarness({
    statePatch,
    globals: {
      console: { log() {}, warn() {}, error() {} },
      tokens(value) {
        return String(value);
      },
      ...globals,
    },
    baseElements: {
      ppwActivitySection: createElement(),
    },
  });
}

// ── Activity derivation ──────────────────────────────────────────────

console.log('\n── Activity derivation ──');

test('deposit-only history produces one Deposit record per row', () => {
  const row1 = makeLoadedRow({ depositTxHash: '0xdep1', txHash: '0xdep1', blockNumber: 100, depositBlockNumber: 100 });
  const row2 = makeLoadedRow({ depositTxHash: '0xdep2', txHash: '0xdep2', blockNumber: 200, depositBlockNumber: 200, label: poseidon2([3n, 4n]) });
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row1, row2])], []);

  assert.equal(activity.length, 2);
  assert.equal(activity[0].action, 'Deposit');
  assert.equal(activity[1].action, 'Deposit');
  assert.equal(activity[0].txHash, '0xdep1');
  assert.equal(activity[1].txHash, '0xdep2');
});

test('deposit-only history across multiple assets', () => {
  const ethRow = makeLoadedRow({ asset: 'ETH', depositTxHash: '0xeth1', txHash: '0xeth1' });
  const boldRow = makeLoadedRow({ asset: 'BOLD', depositTxHash: '0xbold1', txHash: '0xbold1' });
  const wstethRow = makeLoadedRow({ asset: 'wstETH', depositTxHash: '0xwsteth1', txHash: '0xwsteth1' });
  const activity = ppBuildActivityFromAccountRows([
    buildAssetResult('ETH', [ethRow]),
    buildAssetResult('BOLD', [boldRow]),
    buildAssetResult('wstETH', [wstethRow]),
  ], []);

  assert.equal(activity.length, 3);
  const assets = activity.map(a => a.asset);
  assert(assets.includes('ETH'));
  assert(assets.includes('BOLD'));
  assert(assets.includes('wstETH'));
});

test('full withdrawal produces Deposit + Withdrawal records', () => {
  const row = makeLoadedRow({
    source: 'spent',
    value: '0',
    originalValue: '1000000000000000000',
    txHash: '0xwd1',
    blockNumber: 200,
    depositTxHash: '0xdep1',
    depositBlockNumber: 100,
    reviewStatus: PP_REVIEW_STATUS.SPENT,
    isValid: false,
    isWithdrawable: false,
  });
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row])], []);

  assert.equal(activity.length, 2);
  const deposit = activity.find(a => a.action === 'Deposit');
  const withdrawal = activity.find(a => a.action === 'Withdrawal');
  assert(deposit);
  assert(withdrawal);
  assert.equal(deposit.txHash, '0xdep1');
  assert.equal(deposit.reviewStatus, PP_REVIEW_STATUS.SPENT, 'fully-withdrawn deposit activity should show spent');
  assert.equal(withdrawal.txHash, '0xwd1');
  assert.equal(withdrawal.amount, '1000000000000000000');
});

test('partial withdrawal chain produces Deposit + Withdrawal records', () => {
  const label = poseidon2([5n, 6n]);
  const wdMap = new Map();
  wdMap.set('dummy-key', { value: 3000000000000000000n, txHash: '0xwd1', blockNumber: 200 });

  const row = makeLoadedRow({
    source: 'change',
    value: '7000000000000000000',
    label,
    txHash: '0xwd1',
    blockNumber: 200,
    depositTxHash: '0xdep1',
    depositBlockNumber: 100,
    withdrawalIndex: 0,
  });
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row], wdMap)], []);

  assert.equal(activity.length, 2);
  const deposit = activity.find(a => a.action === 'Deposit');
  const withdrawal = activity.find(a => a.action === 'Withdrawal');
  assert(deposit);
  assert(withdrawal);
  assert.equal(deposit.txHash, '0xdep1');
  assert.equal(withdrawal.txHash, '0xwd1');
  // Withdrawal amount resolved from withdrawnMap
  assert.equal(withdrawal.amount, String(3000000000000000000n));
});

test('ragequit flow produces Deposit + Ragequit records', () => {
  const label = poseidon2([7n, 8n]);
  const row = makeLoadedRow({
    source: 'spent',
    value: '0',
    originalValue: '5000000000000000000',
    label,
    txHash: '0xrq1',
    blockNumber: 300,
    depositTxHash: '0xdep1',
    depositBlockNumber: 100,
    ragequit: true,
    reviewStatus: PP_REVIEW_STATUS.EXITED,
    isValid: false,
    isWithdrawable: false,
  });
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row])], []);

  assert.equal(activity.length, 2);
  const deposit = activity.find(a => a.action === 'Deposit');
  const ragequit = activity.find(a => a.action === 'Ragequit');
  assert(deposit);
  assert(ragequit);
  assert.equal(deposit.txHash, '0xdep1');
  assert.equal(deposit.reviewStatus, PP_REVIEW_STATUS.EXITED, 'ragequit deposit activity should show exited');
  assert.equal(ragequit.txHash, '0xrq1');
  assert.equal(ragequit.amount, '5000000000000000000');
  assert.equal(ragequit.reviewStatus, PP_REVIEW_STATUS.APPROVED);
});

test('deposit with pending review status propagates to activity', () => {
  const row = makeLoadedRow({ reviewStatus: PP_REVIEW_STATUS.PENDING, isValid: false, isWithdrawable: false });
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row])], []);

  assert.equal(activity.length, 1);
  assert.equal(activity[0].reviewStatus, PP_REVIEW_STATUS.PENDING);
});

test('deposit with declined status propagates to activity', () => {
  const row = makeLoadedRow({ reviewStatus: PP_REVIEW_STATUS.DECLINED, isValid: false, isWithdrawable: false });
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row])], []);

  assert.equal(activity.length, 1);
  assert.equal(activity[0].reviewStatus, PP_REVIEW_STATUS.DECLINED);
});

test('deposit with poi_required status propagates to activity', () => {
  const row = makeLoadedRow({ reviewStatus: PP_REVIEW_STATUS.POI_REQUIRED, isValid: false, isWithdrawable: false });
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row])], []);

  assert.equal(activity.length, 1);
  assert.equal(activity[0].reviewStatus, PP_REVIEW_STATUS.POI_REQUIRED);
});

test('empty rows produce empty activity', () => {
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [])], []);
  assert.equal(activity.length, 0);
});

test('duplicate deposit txHash is deduplicated', () => {
  // Two rows from the same deposit lineage (e.g., change note chain) should only produce one Deposit record
  const label = poseidon2([9n, 10n]);
  const row1 = makeLoadedRow({
    source: 'spent',
    value: '0',
    originalValue: '10000000000000000000',
    label,
    txHash: '0xwd1',
    blockNumber: 200,
    depositTxHash: '0xdep1',
    depositBlockNumber: 100,
    reviewStatus: PP_REVIEW_STATUS.SPENT,
  });
  // A second row with the same depositTxHash (shouldn't happen in practice but tests dedup)
  const row2 = makeLoadedRow({
    source: 'deposit',
    value: '5000000000000000000',
    label: poseidon2([11n, 12n]),
    txHash: '0xdep1',
    blockNumber: 100,
    depositTxHash: '0xdep1',
    depositBlockNumber: 100,
  });
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row1, row2])], []);
  const deposits = activity.filter(a => a.action === 'Deposit');
  assert.equal(deposits.length, 1, 'duplicate deposit txHash should be deduplicated');
});

test('null activity inputs return empty array without warning noise', () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args); };
  try {
    const activity = ppBuildActivityFromAccountRows(null, null);
    assert.equal(activity.length, 0);
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

// ── Pool-account mapping ─────────────────────────────────────────────

console.log('\n── Pool-account mapping ──');

test('activity rows resolve to the same PA-# shown in My Pools', () => {
  const label1 = poseidon2([20n, 21n]);
  const label2 = poseidon2([22n, 23n]);

  const loadedRows = [
    makeLoadedRow({ asset: 'ETH', label: label1, depositTxHash: '0xd1', txHash: '0xd1' }),
    makeLoadedRow({ asset: 'ETH', label: label2, depositTxHash: '0xd2', txHash: '0xd2' }),
  ];
  const activityRows = ppBuildActivityFromAccountRows([buildAssetResult('ETH', loadedRows)], []);

  // Simulate the PA-# resolution logic from ppwRenderActivity
  for (const row of activityRows) {
    if (row.label == null) continue;
    const labelKey = ppLoadedAccountLabelKey(row.label);
    for (let j = 0; j < loadedRows.length; j++) {
      if (loadedRows[j].asset === row.asset && ppLoadedAccountLabelKey(loadedRows[j].label) === labelKey) {
        row._resolvedPA = 'PA-' + (j + 1);
        break;
      }
    }
  }

  const d1 = activityRows.find(a => a.txHash === '0xd1');
  const d2 = activityRows.find(a => a.txHash === '0xd2');
  assert.equal(d1._resolvedPA, 'PA-1');
  assert.equal(d2._resolvedPA, 'PA-2');
});

test('unresolved labels omit the badge cleanly', () => {
  const label = poseidon2([30n, 31n]);
  const unknownLabel = poseidon2([99n, 99n]);

  const loadedRows = [
    makeLoadedRow({ asset: 'ETH', label: label, depositTxHash: '0xd1', txHash: '0xd1' }),
  ];
  const activityRows = ppBuildActivityFromAccountRows([
    buildAssetResult('ETH', [
      makeLoadedRow({ asset: 'ETH', label: unknownLabel, depositTxHash: '0xd2', txHash: '0xd2' }),
    ]),
  ], []);

  // Try to resolve against loadedRows (which don't contain unknownLabel)
  for (const row of activityRows) {
    row._resolvedPA = null;
    if (row.label == null) continue;
    const labelKey = ppLoadedAccountLabelKey(row.label);
    for (let j = 0; j < loadedRows.length; j++) {
      if (loadedRows[j].asset === row.asset && ppLoadedAccountLabelKey(loadedRows[j].label) === labelKey) {
        row._resolvedPA = 'PA-' + (j + 1);
        break;
      }
    }
  }

  assert.equal(activityRows[0]._resolvedPA, null, 'unresolved label should not produce a PA badge');
});

test('label === 0 still maps correctly', () => {
  const zeroLabel = 0n;

  const loadedRows = [
    makeLoadedRow({ asset: 'ETH', label: zeroLabel, depositTxHash: '0xd1', txHash: '0xd1' }),
  ];
  const activityRows = ppBuildActivityFromAccountRows([buildAssetResult('ETH', loadedRows)], []);

  for (const row of activityRows) {
    row._resolvedPA = null;
    if (row.label == null) continue;
    const labelKey = ppLoadedAccountLabelKey(row.label);
    for (let j = 0; j < loadedRows.length; j++) {
      if (loadedRows[j].asset === row.asset && ppLoadedAccountLabelKey(loadedRows[j].label) === labelKey) {
        row._resolvedPA = 'PA-' + (j + 1);
        break;
      }
    }
  }

  const d1 = activityRows.find(a => a.txHash === '0xd1');
  assert.equal(d1._resolvedPA, 'PA-1', 'label === 0 should still map');
});

// ── Lifecycle ────────────────────────────────────────────────────────

console.log('\n── Activity lifecycle ──');

test('activity is rebuilt on every load (no stale carry-over)', () => {
  // First load
  const row1 = makeLoadedRow({ depositTxHash: '0xd1', txHash: '0xd1', blockNumber: 100 });
  const activity1 = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row1])], []);
  assert.equal(activity1.length, 1);

  // Second load with different data
  const row2 = makeLoadedRow({ depositTxHash: '0xd2', txHash: '0xd2', blockNumber: 200 });
  const activity2 = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row2])], []);
  assert.equal(activity2.length, 1);
  assert.equal(activity2[0].txHash, '0xd2', 'activity should reflect new load, not previous');
});

test('activity failures do not block pool accounts (returns empty)', () => {
  // Simulate corrupted row data that might trip derivation
  const badRow = { ...makeLoadedRow(), depositTxHash: undefined, txHash: undefined };
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [badRow])], []);
  // Should not throw and should return an empty or safe array
  assert(Array.isArray(activity), 'returns an array');
  assert.equal(activity.length, 0, 'corrupted rows produce no activity entries');
});

// ── Timestamp tests ──────────────────────────────────────────────────

console.log('\n── Timestamps ──');

test('deposit rows use ASP timestamps when available', () => {
  const row = makeLoadedRow({ timestamp: 1700000000 });
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row])], []);

  assert.equal(activity.length, 1);
  assert.equal(activity[0].timestamp, 1700000000);
});

test('withdrawal and ragequit rows use null timestamp (resolved from block later)', () => {
  const row = makeLoadedRow({
    source: 'spent',
    value: '0',
    originalValue: '1000',
    txHash: '0xwd1',
    blockNumber: 200,
    depositTxHash: '0xdep1',
    depositBlockNumber: 100,
    ragequit: true,
    reviewStatus: PP_REVIEW_STATUS.EXITED,
    timestamp: 1700000000,
  });
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row])], []);

  const ragequit = activity.find(a => a.action === 'Ragequit');
  assert(ragequit);
  assert.equal(ragequit.timestamp, null, 'ragequit timestamp should be null (resolved from block)');
});

test('failed timestamp lookups render dash and do not break ordering', () => {
  const timeAgo = ppGetTimeAgo(null);
  assert.equal(timeAgo, '\u2013', 'null timestamp should render as dash');

  const timeAgoUndef = ppGetTimeAgo(undefined);
  assert.equal(timeAgoUndef, '\u2013', 'undefined timestamp should render as dash');
});

test('getTimeAgo thresholds match Privacy Pools frontend behavior', () => {
  const now = Math.floor(Date.now() / 1000);

  assert.equal(ppGetTimeAgo(now), 'just now');
  assert.equal(ppGetTimeAgo(now - 30), 'just now');
  assert.equal(ppGetTimeAgo(now - 60), '1 minute ago');
  assert.equal(ppGetTimeAgo(now - 120), '2 minutes ago');
  assert.equal(ppGetTimeAgo(now - 3599), '59 minutes ago');
  assert.equal(ppGetTimeAgo(now - 3600), '1 hour ago');
  assert.equal(ppGetTimeAgo(now - 7200), '2 hours ago');
  assert.equal(ppGetTimeAgo(now - 86400), '1 day ago');
  assert.equal(ppGetTimeAgo(now - 172800), '2 days ago');
  assert.equal(ppGetTimeAgo(now - 2592000), '30 days ago');  // 30 days stays in days
  assert.equal(ppGetTimeAgo(now - 4320000), '50 days ago');  // 50 days stays in days
  assert.equal(ppGetTimeAgo(now - 5184000), '2 months ago'); // 60 days switches to months
  assert.equal(ppGetTimeAgo(now - 31536000), '1 year ago');
});

// ── Sorting ──────────────────────────────────────────────────────────

console.log('\n── Activity sorting ──');

test('activity sorted newest-first by block number', () => {
  const a = { action: 'Deposit', blockNumber: 100, txHash: '0xa' };
  const b = { action: 'Deposit', blockNumber: 200, txHash: '0xb' };
  const c = { action: 'Deposit', blockNumber: 150, txHash: '0xc' };

  const sorted = [a, b, c].sort(ppCompareActivity);
  assert.equal(sorted[0].blockNumber, 200);
  assert.equal(sorted[1].blockNumber, 150);
  assert.equal(sorted[2].blockNumber, 100);
});

test('same-block rows use txHash as tiebreaker', () => {
  const a = { action: 'Deposit', blockNumber: 100, txHash: '0xa' };
  const b = { action: 'Deposit', blockNumber: 100, txHash: '0xb' };

  const sorted = [a, b].sort(ppCompareActivity);
  // b > a lexicographically, so b should come first (descending)
  assert.equal(sorted[0].txHash, '0xb');
  assert.equal(sorted[1].txHash, '0xa');
});

test('same-block same-tx rows use action type as tiebreaker', () => {
  const deposit = { action: 'Deposit', blockNumber: 100, txHash: '0xa' };
  const withdrawal = { action: 'Withdrawal', blockNumber: 100, txHash: '0xa' };
  const ragequit = { action: 'Ragequit', blockNumber: 100, txHash: '0xa' };

  const sorted = [deposit, withdrawal, ragequit].sort(ppCompareActivity);
  // Action order: Ragequit=0, Withdrawal=1, Deposit=2
  assert.equal(sorted[0].action, 'Ragequit');
  assert.equal(sorted[1].action, 'Withdrawal');
  assert.equal(sorted[2].action, 'Deposit');
});

test('null block numbers sort to bottom', () => {
  const a = { action: 'Deposit', blockNumber: null, txHash: '0xa' };
  const b = { action: 'Deposit', blockNumber: 100, txHash: '0xb' };

  const sorted = [a, b].sort(ppCompareActivity);
  assert.equal(sorted[0].blockNumber, 100);
  assert.equal(sorted[1].blockNumber, null);
});

// ── Status behavior ──────────────────────────────────────────────────

console.log('\n── Status behavior ──');

test('withdrawal rows use completed status', () => {
  const row = { action: 'Withdrawal', reviewStatus: PP_REVIEW_STATUS.APPROVED };
  assert.equal(ppActivityGetStatus(row), 'completed');
});

test('ragequit rows use completed status', () => {
  const row = { action: 'Ragequit', reviewStatus: PP_REVIEW_STATUS.APPROVED };
  assert.equal(ppActivityGetStatus(row), 'completed');
});

test('deposit rows inherit review status', () => {
  assert.equal(ppActivityGetStatus({ action: 'Deposit', reviewStatus: 'pending' }), 'pending');
  assert.equal(ppActivityGetStatus({ action: 'Deposit', reviewStatus: 'approved' }), 'approved');
  assert.equal(ppActivityGetStatus({ action: 'Deposit', reviewStatus: 'declined' }), 'declined');
  assert.equal(ppActivityGetStatus({ action: 'Deposit', reviewStatus: 'poi_required' }), 'poi_required');
});

test('status labels match expected values', () => {
  assert.equal(ppActivityGetStatusLabel('approved'), 'Approved');
  assert.equal(ppActivityGetStatusLabel('pending'), 'Pending');
  assert.equal(ppActivityGetStatusLabel('declined'), 'Declined');
  assert.equal(ppActivityGetStatusLabel('exited'), 'Ragequit');
  assert.equal(ppActivityGetStatusLabel('spent'), 'Spent');
  assert.equal(ppActivityGetStatusLabel('poi_required'), 'POA Needed');
  assert.equal(ppActivityGetStatusLabel('unknown'), 'Pending');
});

test('status colors are defined for key statuses', () => {
  assert(ppActivityGetStatusColor('approved').includes('green'));
  assert(ppActivityGetStatusColor('declined').includes('error'));
  assert(ppActivityGetStatusColor('pending').includes('muted'));
});

// ── Rendering edge cases ─────────────────────────────────────────────

console.log('\n── Rendering edge cases ──');

test('six-row default slicing', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push(makeLoadedRow({
      depositTxHash: '0xd' + i,
      txHash: '0xd' + i,
      blockNumber: 100 + i,
      label: poseidon2([BigInt(40 + i), BigInt(50 + i)]),
    }));
  }
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', rows)], []);
  assert.equal(activity.length, 10);

  // Default visible count should be 6
  const PP_ACTIVITY_DEFAULT_VISIBLE = 6;
  const visible = activity.slice(0, PP_ACTIVITY_DEFAULT_VISIBLE);
  assert.equal(visible.length, 6);
});

test('visible activity helper returns the default six rows until expanded', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ txHash: '0x' + i }));
  assert.equal(ppwGetVisibleActivityRows(history, false).length, 6);
  assert.equal(ppwGetVisibleActivityRows(history, true).length, 10);
});

test('empty activity does not break rendering path', () => {
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [])], []);
  assert.equal(activity.length, 0);
  // The render function checks for empty array and hides the section
});

test('live activity render stays hidden before My Pools has loaded', () => {
  const harness = createLiveActivityHarness({
    _ppwActivityHistory: [],
    _ppwHasResolvedLoadState: false,
    _ppwLoadAbort: null,
  });
  harness.api.activity.ppwRenderActivity();
  assert.equal(harness.elements.ppwActivitySection.style.display, 'none');
  assert.equal(harness.elements.ppwActivitySection.innerHTML, '');
});

test('live activity render shows loading copy during the initial My Pools load', () => {
  const harness = createLiveActivityHarness({
    _ppwActivityHistory: [],
    _ppwHasResolvedLoadState: false,
    _ppwLoadAbort: { aborted: false },
  });
  harness.api.activity.ppwRenderActivity();
  assert.equal(harness.elements.ppwActivitySection.style.display, '');
  assert.match(harness.elements.ppwActivitySection.innerHTML, /Loading activity\.\.\./);
});

test('live activity render shows explicit empty copy after a resolved load', () => {
  const harness = createLiveActivityHarness({
    _ppwActivityHistory: [],
    _ppwHasResolvedLoadState: true,
    _ppwLoadAbort: null,
  });
  harness.api.activity.ppwRenderActivity();
  assert.equal(harness.elements.ppwActivitySection.style.display, '');
  assert.match(harness.elements.ppwActivitySection.innerHTML, /Your activity will appear here when there's something to show\./);
});

test('resolved load state renders immediately and hydrates only the visible six rows', async () => {
  const calls = [];
  const history = Array.from({ length: 10 }, (_, i) => ({
    action: 'Deposit',
    asset: 'ETH',
    amount: '1',
    label: poseidon2([BigInt(100 + i), BigInt(200 + i)]),
    txHash: '0xdep' + i,
    blockNumber: 100 + i,
    timestamp: null,
    reviewStatus: PP_REVIEW_STATUS.APPROVED,
  }));
  const harness = createLiveActivityHarness({
    _ppwActivityHistory: history,
    _ppwHasResolvedLoadState: true,
  });
  harness.context.ppwRenderPoolAccounts = () => {
    calls.push('render-pools');
  };
  harness.context.ppResolveActivityTimestamps = async (rows) => {
    calls.push(['resolve', rows.length]);
    rows[0].timestamp = 1700000000;
  };

  harness.api.load.ppwRenderResolvedLoadState();
  assert.match(harness.elements.ppwActivitySection.innerHTML, /Activity/);
  await flushMicrotasks({ strategy: 'set-immediate' });

  assert.deepEqual(calls, ['render-pools', ['resolve', 6]]);
});

test('expanding activity hydrates newly visible rows on demand', async () => {
  const resolveCalls = [];
  const history = Array.from({ length: 10 }, (_, i) => ({
    action: 'Deposit',
    asset: 'ETH',
    amount: '1',
    label: poseidon2([BigInt(300 + i), BigInt(400 + i)]),
    txHash: '0xhist' + i,
    blockNumber: 200 + i,
    timestamp: i < 6 ? 1700000000 + i : null,
    reviewStatus: PP_REVIEW_STATUS.APPROVED,
  }));
  const harness = createLiveActivityHarness({
    _ppwActivityHistory: history,
    _ppwHasResolvedLoadState: true,
    _ppwActivityExpanded: false,
  });
  harness.context.ppResolveActivityTimestamps = async (rows) => {
    resolveCalls.push(rows.filter((row) => row.timestamp == null).map((row) => row.txHash));
    for (const row of rows) {
      if (row.timestamp == null) row.timestamp = 1700001000;
    }
  };

  harness.api.activity.ppwToggleActivityExpanded();
  await flushMicrotasks({ strategy: 'set-immediate' });

  assert.deepEqual(resolveCalls, [['0xhist6', '0xhist7', '0xhist8', '0xhist9']]);
});

test('stale timestamp hydration completions do not trigger a superseded rerender', async () => {
  let resolveFirst;
  let resolveSecond;
  const firstDone = new Promise((resolve) => { resolveFirst = resolve; });
  const secondDone = new Promise((resolve) => { resolveSecond = resolve; });
  let resolveCall = 0;
  const history1 = Array.from({ length: 6 }, (_, i) => ({
    action: 'Deposit',
    asset: 'ETH',
    amount: '1',
    label: poseidon2([BigInt(500 + i), BigInt(600 + i)]),
    txHash: '0xold' + i,
    blockNumber: 300 + i,
    timestamp: null,
    reviewStatus: PP_REVIEW_STATUS.APPROVED,
  }));
  const history2 = Array.from({ length: 6 }, (_, i) => ({
    action: 'Deposit',
    asset: 'ETH',
    amount: '1',
    label: poseidon2([BigInt(700 + i), BigInt(800 + i)]),
    txHash: '0xnew' + i,
    blockNumber: 400 + i,
    timestamp: null,
    reviewStatus: PP_REVIEW_STATUS.APPROVED,
  }));
  const harness = createLiveActivityHarness({
    _ppwActivityHistory: history1,
    _ppwHasResolvedLoadState: true,
  });
  harness.context.ppwRenderPoolAccounts = () => {};
  harness.context.ppResolveActivityTimestamps = (rows) => {
    resolveCall += 1;
    const done = resolveCall === 1 ? firstDone : secondDone;
    return done.then(() => {
      rows[0].timestamp = resolveCall;
    });
  };
  let renderCount = 0;
  harness.elements.ppwActivitySection = {
    _innerHTML: '',
    textContent: '',
    style: { display: '' },
    set innerHTML(value) {
      this._innerHTML = value;
      renderCount += 1;
    },
    get innerHTML() {
      return this._innerHTML;
    },
  };

  harness.api.load.ppwRenderResolvedLoadState();
  harness.api.activity.ppwWriteActivityHistory(history2);
  harness.api.load.ppwRenderResolvedLoadState();
  assert.equal(renderCount, 2);

  resolveFirst();
  await flushMicrotasks({ strategy: 'set-immediate' });
  assert.equal(renderCount, 2);

  resolveSecond();
  await flushMicrotasks({ strategy: 'set-immediate' });
  assert.equal(renderCount, 3);
});

test('partial data (only some rows have timestamps) does not break', () => {
  const row1 = makeLoadedRow({ timestamp: 1700000000, depositTxHash: '0xd1', txHash: '0xd1' });
  const row2 = makeLoadedRow({ timestamp: null, depositTxHash: '0xd2', txHash: '0xd2', label: poseidon2([60n, 61n]) });
  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row1, row2])], []);

  assert.equal(activity.length, 2);
  assert.equal(activity[0].timestamp, 1700000000);
  assert.equal(activity[1].timestamp, null);
  // Both should produce valid timeAgo output
  assert.notEqual(ppGetTimeAgo(activity[0].timestamp), '\u2013');
  assert.equal(ppGetTimeAgo(activity[1].timestamp), '\u2013');
});

test('legacy-to-safe lineage continuity produces correct activity', () => {
  // Legacy deposit that was partially withdrawn and migrated to safe
  const label = poseidon2([70n, 71n]);
  const row = makeLoadedRow({
    source: 'change',
    value: '7000000000000000000',
    label,
    txHash: '0xwd1',
    blockNumber: 200,
    depositTxHash: '0xdep1',
    depositBlockNumber: 100,
    derivation: 'safe',
    withdrawalIndex: 0,
  });

  const wdMap = new Map();
  wdMap.set('key1', { value: 3000000000000000000n, txHash: '0xwd1', blockNumber: 200 });

  const activity = ppBuildActivityFromAccountRows([buildAssetResult('ETH', [row], wdMap)], []);

  assert.equal(activity.length, 2);
  const deposit = activity.find(a => a.action === 'Deposit');
  const withdrawal = activity.find(a => a.action === 'Withdrawal');
  assert(deposit);
  assert(withdrawal);
  assert.equal(deposit.txHash, '0xdep1');
  assert.equal(withdrawal.txHash, '0xwd1');
});

// ── ppActivityFindWithdrawnAmount ─────────────────────────────────────

console.log('\n── Withdrawn amount resolution ──');

test('finds withdrawn amount by matching txHash in withdrawnMap', () => {
  const wdMap = new Map();
  wdMap.set('key1', { value: 5000000000000000000n, txHash: '0xwd1', blockNumber: 200 });
  wdMap.set('key2', { value: 2000000000000000000n, txHash: '0xwd2', blockNumber: 300 });

  const row = { txHash: '0xwd1' };
  const amount = ppActivityFindWithdrawnAmount(row, wdMap);
  assert.equal(amount, String(5000000000000000000n));
});

test('returns null when txHash not found in withdrawnMap', () => {
  const wdMap = new Map();
  wdMap.set('key1', { value: 5n, txHash: '0xother', blockNumber: 200 });

  const row = { txHash: '0xwd1' };
  const amount = ppActivityFindWithdrawnAmount(row, wdMap);
  assert.equal(amount, null);
});

test('returns null when withdrawnMap is null or row has no txHash', () => {
  assert.equal(ppActivityFindWithdrawnAmount({}, null), null);
  assert.equal(ppActivityFindWithdrawnAmount({ txHash: null }, new Map()), null);
});

await done();
