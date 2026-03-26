#!/usr/bin/env node
//
// Privacy account recovery parity tests.
//
// Covers the SDK-v1.2.0-aligned account reconstruction paths that are easy to
// regress in the app because they are rebuilt manually in the browser:
//
//   - legacy -> safe migration detection
//   - zero-value migration slot counting
//   - ragequit handling for loaded pool accounts
//   - pending detection against inserted leaves
//   - mixed legacy/safe ordering in the Pool Accounts list
//
// Usage: node test/privacy/test_account_recovery.mjs
//
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

const ctx = vm.createContext({
  window: {},
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  Uint8Array,
  Array,
  BigInt,
});
vm.runInContext(readFileSync(path.join(ROOT, 'dapp/poseidon1.min.js'), 'utf8'), ctx);
vm.runInContext(readFileSync(path.join(ROOT, 'dapp/poseidon2.min.js'), 'utf8'), ctx);
vm.runInContext(readFileSync(path.join(ROOT, 'dapp/poseidon3.min.js'), 'utf8'), ctx);

const { poseidon1, poseidon2, poseidon3 } = ctx.window;

function ppDeriveDepositKeys(masterNullifier, masterSecret, scope, index) {
  const nullifier = poseidon3([masterNullifier, scope, BigInt(index)]);
  const secret = poseidon3([masterSecret, scope, BigInt(index)]);
  const precommitment = poseidon2([nullifier, secret]);
  return { nullifier, secret, precommitment };
}

function ppDeriveWithdrawalKeys(masterNullifier, masterSecret, label, withdrawalIndex) {
  const nullifier = poseidon3([masterNullifier, label, BigInt(withdrawalIndex)]);
  const secret = poseidon3([masterSecret, label, BigInt(withdrawalIndex)]);
  const precommitment = poseidon2([nullifier, secret]);
  return { nullifier, secret, precommitment };
}

function ppHashHex(value) {
  return '0x' + BigInt(value).toString(16).padStart(64, '0');
}

function ppCompareLoadedAccounts(a, b) {
  const assetOrder = { ETH: 0, BOLD: 1, wstETH: 2 };
  const assetDelta = (assetOrder[a.asset] ?? 99) - (assetOrder[b.asset] ?? 99);
  if (assetDelta !== 0) return assetDelta;

  const aDepositBlock = a.depositBlockNumber == null ? Number.MAX_SAFE_INTEGER : Number(a.depositBlockNumber);
  const bDepositBlock = b.depositBlockNumber == null ? Number.MAX_SAFE_INTEGER : Number(b.depositBlockNumber);
  if (aDepositBlock !== bDepositBlock) return aDepositBlock - bDepositBlock;

  const aDepositIdx = a.depositIndex == null ? Number.MAX_SAFE_INTEGER : Number(a.depositIndex);
  const bDepositIdx = b.depositIndex == null ? Number.MAX_SAFE_INTEGER : Number(b.depositIndex);
  if (aDepositIdx !== bDepositIdx) return aDepositIdx - bDepositIdx;

  const aBlock = a.blockNumber == null ? Number.MAX_SAFE_INTEGER : Number(a.blockNumber);
  const bBlock = b.blockNumber == null ? Number.MAX_SAFE_INTEGER : Number(b.blockNumber);
  if (aBlock !== bBlock) return aBlock - bBlock;

  return String(a.txHash || '').localeCompare(String(b.txHash || ''));
}

const PP_PENDING_DEPOSIT_RESERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function ppNormalizePendingDepositReservations(entries, minDepositIndex = 0, now = Date.now()) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : [])
    .map(entry => ({
      depositIndex: Number(entry?.depositIndex),
      txHash: entry?.txHash ? String(entry.txHash) : null,
      createdAt: Number(entry?.createdAt),
      status: entry?.status === 'confirmed' ? 'confirmed' : 'pending',
    }))
    .filter(entry => Number.isInteger(entry.depositIndex) && entry.depositIndex >= minDepositIndex)
    .filter(entry => Number.isFinite(entry.createdAt) && (now - entry.createdAt) < PP_PENDING_DEPOSIT_RESERVATION_TTL_MS)
    .sort((a, b) => a.depositIndex - b.depositIndex || b.createdAt - a.createdAt)
    .filter(entry => {
      const key = String(entry.depositIndex);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function ppResolveReservedSafeDepositIndex(recoveredIndex, reservations) {
  const byIndex = new Map((Array.isArray(reservations) ? reservations : []).map(entry => [Number(entry.depositIndex), entry]));
  let nextIndex = recoveredIndex;
  while (true) {
    const reservation = byIndex.get(nextIndex);
    if (!reservation) return { nextIndex, pendingIndex: null };
    if (reservation.status !== 'confirmed') {
      return { nextIndex, pendingIndex: nextIndex };
    }
    nextIndex++;
  }
}

function ppTraceLoadedAccountChain(initial, withdrawnMap, legacyKeys, safeKeys) {
  const depositTxHash = initial.depositTxHash;
  const depositBlockNumber = initial.depositBlockNumber;
  const initialValue = initial.value;
  let current = initial;
  let migrated = false;

  while (current && current.source !== 'spent') {
    const nullHashHex = ppHashHex(poseidon1([current.nullifier]));
    const w = withdrawnMap.get(nullHashHex);
    if (!w) break;

    const changeValue = BigInt(current.value) - BigInt(w.value);
    if (changeValue <= 0n) {
      if (changeValue === 0n && current.derivation === 'legacy') {
        const migratedKeys = ppDeriveWithdrawalKeys(
          safeKeys.masterNullifier,
          safeKeys.masterSecret,
          BigInt(current.label),
          0,
        );
        const expectedMigratedCommitment = poseidon3([changeValue, BigInt(current.label), migratedKeys.precommitment]);
        if (w.newCommitment && expectedMigratedCommitment === BigInt(w.newCommitment)) {
          migrated = true;
        }
      }
      current = {
        value: '0',
        source: 'spent',
        depositTxHash,
        depositBlockNumber,
        originalValue: initialValue,
        derivation: current.derivation,
      };
      break;
    }

    const nextIndex = current.withdrawalIndex == null ? 0 : Number(current.withdrawalIndex) + 1;
    const keyset = current.derivation === 'legacy' ? legacyKeys : safeKeys;
    const changeKeys = ppDeriveWithdrawalKeys(
      keyset.masterNullifier,
      keyset.masterSecret,
      BigInt(current.label),
      nextIndex,
    );
    const expectedCommitment = poseidon3([changeValue, BigInt(current.label), changeKeys.precommitment]);
    if (w.newCommitment && expectedCommitment === BigInt(w.newCommitment)) {
      current = {
        nullifier: changeKeys.nullifier,
        secret: changeKeys.secret,
        precommitment: changeKeys.precommitment,
        value: changeValue.toString(),
        label: current.label,
        commitment: ppHashHex(expectedCommitment),
        txHash: w.txHash,
        blockNumber: w.blockNumber,
        depositTxHash,
        depositBlockNumber,
        withdrawalIndex: nextIndex,
        source: 'change',
        derivation: current.derivation,
      };
      continue;
    }

    if (current.derivation === 'legacy') {
      const migratedIndex = 0;
      const migratedKeys = ppDeriveWithdrawalKeys(
        safeKeys.masterNullifier,
        safeKeys.masterSecret,
        BigInt(current.label),
        migratedIndex,
      );
      const expectedMigratedCommitment = poseidon3([changeValue, BigInt(current.label), migratedKeys.precommitment]);
      if (w.newCommitment && expectedMigratedCommitment === BigInt(w.newCommitment)) {
        migrated = true;
        current = {
          nullifier: migratedKeys.nullifier,
          secret: migratedKeys.secret,
          precommitment: migratedKeys.precommitment,
          value: changeValue.toString(),
          label: current.label,
          commitment: ppHashHex(expectedMigratedCommitment),
          txHash: w.txHash,
          blockNumber: w.blockNumber,
          depositTxHash,
          depositBlockNumber,
          withdrawalIndex: migratedIndex,
          source: 'change',
          derivation: 'safe',
          migratedFrom: 'legacy',
        };
        continue;
      }
    }

    current = null;
  }

  return { current, migrated };
}

function ppCollectWalletAccountsForDerivation({
  asset,
  scope,
  poolAddress,
  depositEvents,
  withdrawnMap,
  ragequitMap,
  insertedLeaves,
  derivation,
  keyset,
  legacyKeys,
  safeKeys,
  startIndex = 0,
}) {
  const results = [];
  let migratedCount = 0;
  let consecutiveMisses = 0;

  for (let index = startIndex; consecutiveMisses < 10; index++) {
    const dk = ppDeriveDepositKeys(keyset.masterNullifier, keyset.masterSecret, scope, index);
    const pch = ppHashHex(dk.precommitment);
    const ev = depositEvents.get(pch);

    if (!ev) {
      consecutiveMisses++;
      continue;
    }
    consecutiveMisses = 0;

    const initial = {
      nullifier: dk.nullifier,
      secret: dk.secret,
      precommitment: dk.precommitment,
      value: ev.value,
      label: ev.label,
      commitment: ev.commitment,
      txHash: ev.txHash,
      blockNumber: ev.blockNumber,
      depositTxHash: ev.txHash,
      depositBlockNumber: ev.blockNumber,
      withdrawalIndex: null,
      source: 'deposit',
      derivation,
    };

    const traced = ppTraceLoadedAccountChain(initial, withdrawnMap, legacyKeys, safeKeys);
    if (traced.migrated) migratedCount++;
    if (!traced.current) continue;

    const current = traced.current;
    const ragequitLabel = current.label != null ? current.label : initial.label;
    const ragequit = ragequitMap?.get(ppHashHex(ragequitLabel));
    if (ragequit) {
      const originalValue = current.source === 'spent'
        ? (current.originalValue ?? initial.value)
        : current.value;
      results.push({
        asset,
        depositIndex: index,
        poolAddress,
        pending: false,
        value: '0',
        label: ragequitLabel,
        txHash: ragequit.txHash,
        blockNumber: ragequit.blockNumber,
        depositTxHash: initial.depositTxHash,
        depositBlockNumber: initial.depositBlockNumber,
        originalValue: String(originalValue),
        source: 'spent',
        derivation: current.derivation,
        ragequit: true,
      });
      continue;
    }

    const currentCommitment = current.commitment == null
      ? null
      : (typeof current.commitment === 'string' ? current.commitment : ppHashHex(current.commitment));
    const pending = current.source === 'deposit' && currentCommitment && !insertedLeaves.has(currentCommitment);
    results.push({
      asset,
      depositIndex: index,
      poolAddress,
      pending,
      ...current,
    });
  }

  return { results, migratedCount };
}

function makeDepositEvent(keys, scope, index, label, value, blockNumber, txHash) {
  const dk = ppDeriveDepositKeys(keys.masterNullifier, keys.masterSecret, scope, index);
  return {
    dk,
    event: {
      commitment: ppHashHex(poseidon3([value, label, dk.precommitment])),
      label,
      value,
      txHash,
      blockNumber,
    },
  };
}

function makeWithdrawalEvent(currentNullifier, withdrawn, newCommitment, blockNumber, txHash) {
  return {
    key: ppHashHex(poseidon1([currentNullifier])),
    event: {
      value: withdrawn,
      newCommitment,
      txHash,
      blockNumber,
    },
  };
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    console.log(`       ${e.message}`);
  }
}

const SCOPE = 0xF241d57C6DebAe225c0F2e6eA1529373C9A9C9fBn;
const SAFE_KEYS = {
  masterNullifier: poseidon1([111n]),
  masterSecret: poseidon1([222n]),
};
const LEGACY_KEYS = {
  masterNullifier: poseidon1([333n]),
  masterSecret: poseidon1([444n]),
};

console.log('\n── Account recovery parity ──');

test('legacy partial migration is recovered as a safe change note at index 0', () => {
  const label = poseidon2([1n, 2n]);
  const { dk, event } = makeDepositEvent(LEGACY_KEYS, SCOPE, 0, label, 10n, 100n, '0xdep1');
  const migratedKeys = ppDeriveWithdrawalKeys(SAFE_KEYS.masterNullifier, SAFE_KEYS.masterSecret, label, 0);
  const remainingValue = 7n;
  const { key, event: withdrawalEvent } = makeWithdrawalEvent(
    dk.nullifier,
    3n,
    ppHashHex(poseidon3([remainingValue, label, migratedKeys.precommitment])),
    101n,
    '0xwd1',
  );

  const { results, migratedCount } = ppCollectWalletAccountsForDerivation({
    asset: 'ETH',
    scope: SCOPE,
    poolAddress: '0xpool',
    depositEvents: new Map([[ppHashHex(dk.precommitment), event]]),
    withdrawnMap: new Map([[key, withdrawalEvent]]),
    ragequitMap: new Map(),
    insertedLeaves: new Set(),
    derivation: 'legacy',
    keyset: LEGACY_KEYS,
    legacyKeys: LEGACY_KEYS,
    safeKeys: SAFE_KEYS,
  });

  assert.equal(migratedCount, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].source, 'change');
  assert.equal(results[0].derivation, 'safe');
  assert.equal(results[0].withdrawalIndex, 0);
  assert.equal(results[0].value, '7');
});

test('zero-value legacy migration still counts as a migrated slot', () => {
  const label = poseidon2([3n, 4n]);
  const { dk, event } = makeDepositEvent(LEGACY_KEYS, SCOPE, 0, label, 5n, 110n, '0xdep2');
  const migratedKeys = ppDeriveWithdrawalKeys(SAFE_KEYS.masterNullifier, SAFE_KEYS.masterSecret, label, 0);
  const { key, event: withdrawalEvent } = makeWithdrawalEvent(
    dk.nullifier,
    5n,
    ppHashHex(poseidon3([0n, label, migratedKeys.precommitment])),
    111n,
    '0xwd2',
  );

  const { results, migratedCount } = ppCollectWalletAccountsForDerivation({
    asset: 'ETH',
    scope: SCOPE,
    poolAddress: '0xpool',
    depositEvents: new Map([[ppHashHex(dk.precommitment), event]]),
    withdrawnMap: new Map([[key, withdrawalEvent]]),
    ragequitMap: new Map(),
    insertedLeaves: new Set(),
    derivation: 'legacy',
    keyset: LEGACY_KEYS,
    legacyKeys: LEGACY_KEYS,
    safeKeys: SAFE_KEYS,
  });

  assert.equal(migratedCount, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].source, 'spent');
  assert.equal(results[0].originalValue, 5n);
});

test('ragequit marks a loaded account as spent and non-withdrawable', () => {
  const label = poseidon2([5n, 6n]);
  const { dk, event } = makeDepositEvent(SAFE_KEYS, SCOPE, 1, label, 9n, 120n, '0xdep3');
  const ragequitMap = new Map([[
    ppHashHex(label),
    { value: 9n, txHash: '0xrq1', blockNumber: 121n },
  ]]);

  const { results } = ppCollectWalletAccountsForDerivation({
    asset: 'ETH',
    scope: SCOPE,
    poolAddress: '0xpool',
    depositEvents: new Map([[ppHashHex(dk.precommitment), event]]),
    withdrawnMap: new Map(),
    ragequitMap,
    insertedLeaves: new Set([event.commitment]),
    derivation: 'safe',
    keyset: SAFE_KEYS,
    legacyKeys: LEGACY_KEYS,
    safeKeys: SAFE_KEYS,
    startIndex: 1,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].source, 'spent');
  assert.equal(results[0].ragequit, true);
  assert.equal(results[0].originalValue, '9');
});

test('pending detection compares normalized commitment hex values', () => {
  const label = poseidon2([7n, 8n]);
  const { dk, event } = makeDepositEvent(SAFE_KEYS, SCOPE, 2, label, 4n, 130n, '0xdep4');

  const available = ppCollectWalletAccountsForDerivation({
    asset: 'ETH',
    scope: SCOPE,
    poolAddress: '0xpool',
    depositEvents: new Map([[ppHashHex(dk.precommitment), event]]),
    withdrawnMap: new Map(),
    ragequitMap: new Map(),
    insertedLeaves: new Set([event.commitment]),
    derivation: 'safe',
    keyset: SAFE_KEYS,
    legacyKeys: LEGACY_KEYS,
    safeKeys: SAFE_KEYS,
    startIndex: 2,
  });
  const pending = ppCollectWalletAccountsForDerivation({
    asset: 'ETH',
    scope: SCOPE,
    poolAddress: '0xpool',
    depositEvents: new Map([[ppHashHex(dk.precommitment), event]]),
    withdrawnMap: new Map(),
    ragequitMap: new Map(),
    insertedLeaves: new Set(),
    derivation: 'safe',
    keyset: SAFE_KEYS,
    legacyKeys: LEGACY_KEYS,
    safeKeys: SAFE_KEYS,
    startIndex: 2,
  });

  assert.equal(available.results[0].pending, false);
  assert.equal(pending.results[0].pending, true);
});

test('next safe deposit index still counts ragequitted safe slots after legacy migration', () => {
  const legacyLabel = poseidon2([9n, 10n]);
  const safeLabel = poseidon2([11n, 12n]);

  const { dk: legacyDk, event: legacyEvent } = makeDepositEvent(LEGACY_KEYS, SCOPE, 0, legacyLabel, 6n, 140n, '0xdep5');
  const migratedKeys = ppDeriveWithdrawalKeys(SAFE_KEYS.masterNullifier, SAFE_KEYS.masterSecret, legacyLabel, 0);
  const { key: legacyWithdrawalKey, event: legacyWithdrawalEvent } = makeWithdrawalEvent(
    legacyDk.nullifier,
    6n,
    ppHashHex(poseidon3([0n, legacyLabel, migratedKeys.precommitment])),
    141n,
    '0xwd5',
  );

  const { dk: safeDk, event: safeEvent } = makeDepositEvent(SAFE_KEYS, SCOPE, 1, safeLabel, 8n, 142n, '0xdep6');
  const ragequitMap = new Map([[
    ppHashHex(safeLabel),
    { value: 8n, txHash: '0xrq2', blockNumber: 143n },
  ]]);

  const legacyScan = ppCollectWalletAccountsForDerivation({
    asset: 'ETH',
    scope: SCOPE,
    poolAddress: '0xpool',
    depositEvents: new Map([[ppHashHex(legacyDk.precommitment), legacyEvent]]),
    withdrawnMap: new Map([[legacyWithdrawalKey, legacyWithdrawalEvent]]),
    ragequitMap: new Map(),
    insertedLeaves: new Set(),
    derivation: 'legacy',
    keyset: LEGACY_KEYS,
    legacyKeys: LEGACY_KEYS,
    safeKeys: SAFE_KEYS,
  });

  const safeScan = ppCollectWalletAccountsForDerivation({
    asset: 'ETH',
    scope: SCOPE,
    poolAddress: '0xpool',
    depositEvents: new Map([[ppHashHex(safeDk.precommitment), safeEvent]]),
    withdrawnMap: new Map(),
    ragequitMap,
    insertedLeaves: new Set([safeEvent.commitment]),
    derivation: 'safe',
    keyset: SAFE_KEYS,
    legacyKeys: LEGACY_KEYS,
    safeKeys: SAFE_KEYS,
    startIndex: legacyScan.migratedCount,
  });

  assert.equal(legacyScan.migratedCount, 1);
  assert.equal(safeScan.results.length, 1);
  assert.equal(legacyScan.migratedCount + safeScan.results.length, 2);
});

test('mixed legacy and safe accounts stay ordered by deposit chronology, not derivation', () => {
  const rows = [
    {
      asset: 'ETH',
      derivation: 'safe',
      depositIndex: 1,
      depositBlockNumber: 201n,
      blockNumber: 201n,
      txHash: '0xbbb',
    },
    {
      asset: 'ETH',
      derivation: 'legacy',
      depositIndex: 0,
      depositBlockNumber: 200n,
      blockNumber: 200n,
      txHash: '0xaaa',
    },
  ];

  rows.sort(ppCompareLoadedAccounts);
  assert.equal(rows[0].derivation, 'legacy');
  assert.equal(rows[1].derivation, 'safe');
});

test('confirmed pending-deposit reservations advance the next safe slot', () => {
  const resolved = ppResolveReservedSafeDepositIndex(2, [
    { depositIndex: 2, status: 'confirmed', createdAt: 10 },
    { depositIndex: 3, status: 'confirmed', createdAt: 20 },
  ]);

  assert.equal(resolved.nextIndex, 4);
  assert.equal(resolved.pendingIndex, null);
});

test('unconfirmed pending-deposit reservations block the next safe slot', () => {
  const resolved = ppResolveReservedSafeDepositIndex(2, [
    { depositIndex: 2, status: 'pending', createdAt: 10 },
    { depositIndex: 3, status: 'confirmed', createdAt: 20 },
  ]);

  assert.equal(resolved.nextIndex, 2);
  assert.equal(resolved.pendingIndex, 2);
});

test('pending-deposit reservation normalization prunes stale and superseded entries', () => {
  const now = 50_000;
  const normalized = ppNormalizePendingDepositReservations([
    { depositIndex: 0, status: 'pending', createdAt: now - 1000 },
    { depositIndex: 2, status: 'pending', createdAt: now - 5000 },
    { depositIndex: 2, status: 'confirmed', createdAt: now - 100 },
    { depositIndex: 4, status: 'pending', createdAt: now - PP_PENDING_DEPOSIT_RESERVATION_TTL_MS - 1 },
    { depositIndex: 'bad', status: 'pending', createdAt: now - 100 },
  ], 1, now);

  assert.deepEqual(
    normalized.map(entry => ({ depositIndex: entry.depositIndex, status: entry.status })),
    [
      { depositIndex: 2, status: 'confirmed' },
    ],
  );
});

console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`\x1b[32m  All ${passed} tests passed.\x1b[0m\n`);
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failed} failed, ${passed} passed.\x1b[0m\n`);
  process.exit(1);
}
