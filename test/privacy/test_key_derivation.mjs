#!/usr/bin/env node
//
// Privacy key-derivation regression & determinism tests.
//
// Runs with zero npm dependencies — loads the vendored poseidon libs straight
// from dapp/ and uses Node's built-in assert module.
//
// Usage:  node test/privacy/test_key_derivation.mjs
//
import { strict as assert } from 'node:assert';
import { webcrypto } from 'node:crypto';
import { createPoseidonContext, createKeyDerivation, createTestRunner, loadPrivacyTestApi } from './_app_source_utils.mjs';

const { poseidon1, poseidon2, poseidon3, ethers } = createPoseidonContext({ withEthers: true });
assert(typeof poseidon1 === 'function', 'poseidon1 loaded');
assert(typeof poseidon2 === 'function', 'poseidon2 loaded');
assert(typeof poseidon3 === 'function', 'poseidon3 loaded');
assert(typeof ethers?.keccak256 === 'function', 'ethers loaded');

const { ppDeriveDepositKeys, ppDeriveWithdrawalKeys } = createKeyDerivation(poseidon2, poseidon3);
const { test, done } = createTestRunner();

function deriveHdSeed(hexKey, mode = 'safe') {
  const hdKey = BigInt(hexKey);
  return mode === 'legacy' ? BigInt(Number(hdKey)) : hdKey;
}

function deriveMasterKeysFromHdKeys(key1, key2, mode = 'safe') {
  const masterNullifier = poseidon1([deriveHdSeed(key1, mode)]);
  const masterSecret = poseidon1([deriveHdSeed(key2, mode)]);
  return { masterNullifier, masterSecret };
}

function ppNormalizeWalletSeedVersion(version) {
  return version === 'v1' ? 'v1' : (version === 'v2' ? 'v2' : null);
}

function ppWalletSeedContext(version = 'v2') {
  const normalizedVersion = ppNormalizeWalletSeedVersion(version) || 'v2';
  return `privacy-pools/wallet-seed:${normalizedVersion}`;
}

function ppWalletSeedEntropyBits(version = 'v2') {
  return version === 'v1' ? 128 : 256;
}

async function ppDeriveWalletMnemonic(privateKey, version = 'v2') {
  const wallet = new ethers.Wallet(privateKey);
  const domain = { name: 'Privacy Pools', version: '1' };
  const types = {
    DeriveSeed: [
      { name: 'action', type: 'string' },
      { name: 'context', type: 'string' },
      { name: 'addressHash', type: 'bytes32' },
    ],
  };
  const message = {
    action: 'Derive Account Seed',
    context: ppWalletSeedContext(version),
    addressHash: ethers.keccak256(wallet.address),
  };
  const sig1 = await wallet.signTypedData(domain, types, message);
  const sig2 = await wallet.signTypedData(domain, types, message);
  assert.equal(sig1, sig2, 'wallet signature determinism');
  const sigBytes = ethers.getBytes(sig1);
  const r = sigBytes.slice(0, 32);
  const ikm = await webcrypto.subtle.importKey('raw', r, 'HKDF', false, ['deriveBits']);
  const hkdfBits = await webcrypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ethers.getBytes(wallet.address),
      info: new TextEncoder().encode(ppWalletSeedContext(version)),
    },
    ikm,
    ppWalletSeedEntropyBits(version),
  );
  return {
    address: wallet.address,
    signature: sig1,
    mnemonic: ethers.Mnemonic.fromEntropy(new Uint8Array(hkdfBits)),
  };
}

function ppDeriveWalletMasterKeys(mnemonic, derivation = 'safe') {
  const key1 = ethers.HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/0`).privateKey;
  const key2 = ethers.HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/1'/0/0`).privateKey;
  const toSeed = derivation === 'legacy'
    ? (hexKey) => BigInt(Number(BigInt(hexKey)))
    : (hexKey) => BigInt(hexKey);
  return {
    masterNullifier: poseidon1([toSeed(key1)]),
    masterSecret: poseidon1([toSeed(key2)]),
  };
}

const { api } = loadPrivacyTestApi();
const {
  ppBuildWalletSeedTypedData: appBuildWalletSeedTypedData,
  ppDeriveWalletSeedSignature: appDeriveWalletSeedSignature,
  ppDeriveWalletSeedMnemonicFromSignature: appDeriveWalletSeedMnemonicFromSignature,
  ppDeriveWalletSeed: appDeriveWalletSeed,
} = api.wallet;

// Mirrors ppComputeScopeForPool in the runtime. The hardcoded expected values
// in the scope tests below are the authoritative check — this helper just
// reconstructs the keccak(pool ++ 0x01 ++ asset) % SNARK_FIELD formula.
function ppComputeScope(poolAddress, assetAddress) {
  return BigInt(ethers.keccak256(
    '0x' +
    poolAddress.slice(2).toLowerCase() +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    assetAddress.slice(2).toLowerCase()
  )) % SNARK_SCALAR_FIELD;
}

// ── BN254 scalar field ───────────────────────────────────────────────────────
const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ── Test helpers ─────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
//  1. Poseidon sanity checks
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── Poseidon sanity ──');

// First run: capture reference values, then assert on re-runs.
const p1_ref = poseidon1([1n]);
const p2_ref = poseidon2([1n, 2n]);
const p3_ref = poseidon3([1n, 2n, 3n]);

test('poseidon outputs are within BN254 scalar field', () => {
  assert(p1_ref > 0n && p1_ref < SNARK_SCALAR_FIELD);
  assert(p2_ref > 0n && p2_ref < SNARK_SCALAR_FIELD);
  assert(p3_ref > 0n && p3_ref < SNARK_SCALAR_FIELD);
});

test('different inputs produce different outputs', () => {
  assert.notEqual(poseidon1([1n]), poseidon1([2n]));
  assert.notEqual(poseidon2([1n, 2n]), poseidon2([2n, 1n]));
  assert.notEqual(poseidon3([1n, 2n, 3n]), poseidon3([3n, 2n, 1n]));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. Known-answer regression vectors (Poseidon over BN254)
//
//  These values were captured from the vendored poseidon-lite@0.3.0.
//  If a future update changes the Poseidon implementation, these will catch it.
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── Known-answer vectors ──');

// Hardcoded from poseidon-lite@0.3.0 over BN254. Any change = regression.
const VECTORS = {
  p1_1:     18586133768512220936620570745912940619677854269274689475585506675881198879027n,
  p2_1_2:   7853200120776062878684798364095072458815029376092732009249414926327459813530n,
  p3_1_2_3: 6542985608222806190361240322586112750744169038454362455181422643027100751666n,
};

test('poseidon1([1]) matches known vector', () => {
  assert.equal(poseidon1([1n]), VECTORS.p1_1);
});

test('poseidon2([1,2]) matches known vector', () => {
  assert.equal(poseidon2([1n, 2n]), VECTORS.p2_1_2);
});

test('poseidon3([1,2,3]) matches known vector', () => {
  assert.equal(poseidon3([1n, 2n, 3n]), VECTORS.p3_1_2_3);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  3. Deposit key derivation
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── Deposit key derivation ──');

// Use arbitrary but fixed master keys for testing
const TEST_MASTER_NULLIFIER = poseidon1([42n]);
const TEST_MASTER_SECRET = poseidon1([43n]);
const TEST_SCOPE = 0xF241d57C6DebAe225c0F2e6eA1529373C9A9C9fBn; // ETH pool address as scope

test('deposit keys are deterministic', () => {
  const ref = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_SCOPE, 0);
  for (let i = 0; i < 3; i++) {
    const keys = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_SCOPE, 0);
    assert.equal(keys.nullifier, ref.nullifier);
    assert.equal(keys.secret, ref.secret);
    assert.equal(keys.precommitment, ref.precommitment);
  }
});

test('deposit keys differ by index', () => {
  const k0 = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_SCOPE, 0);
  const k1 = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_SCOPE, 1);
  const k2 = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_SCOPE, 2);
  assert.notEqual(k0.nullifier, k1.nullifier);
  assert.notEqual(k1.nullifier, k2.nullifier);
  assert.notEqual(k0.precommitment, k1.precommitment);
});

test('deposit keys differ by scope', () => {
  const scopeA = 0xF241d57C6DebAe225c0F2e6eA1529373C9A9C9fBn;
  const scopeB = 0xb4b5Fd38Fd4788071d7287e3cB52948e0d10b23En;
  const kA = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, scopeA, 0);
  const kB = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, scopeB, 0);
  assert.notEqual(kA.nullifier, kB.nullifier);
  assert.notEqual(kA.secret, kB.secret);
  assert.notEqual(kA.precommitment, kB.precommitment);
});

test('deposit nullifier != secret for same inputs', () => {
  const k = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_SCOPE, 0);
  assert.notEqual(k.nullifier, k.secret);
});

test('deposit precommitment matches hardcoded regression value', () => {
  const k = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_SCOPE, 0);
  assert.equal(k.precommitment, 7401488295419196436257358403189492305761693180908177863987681050820699998762n);
});

test('deposit keys are within BN254 scalar field', () => {
  for (let i = 0; i < 2; i++) {
    const k = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_SCOPE, i);
    assert(k.nullifier > 0n && k.nullifier < SNARK_SCALAR_FIELD);
    assert(k.secret > 0n && k.secret < SNARK_SCALAR_FIELD);
    assert(k.precommitment > 0n && k.precommitment < SNARK_SCALAR_FIELD);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. Withdrawal key derivation
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── Withdrawal key derivation ──');

const TEST_LABEL = poseidon2([123n, 456n]); // arbitrary commitment label

test('withdrawal keys are deterministic', () => {
  const ref = ppDeriveWithdrawalKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_LABEL, 0);
  for (let i = 0; i < 3; i++) {
    const keys = ppDeriveWithdrawalKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_LABEL, 0);
    assert.equal(keys.nullifier, ref.nullifier);
    assert.equal(keys.secret, ref.secret);
    assert.equal(keys.precommitment, ref.precommitment);
  }
});

test('withdrawal keys differ by index', () => {
  const k0 = ppDeriveWithdrawalKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_LABEL, 0);
  const k1 = ppDeriveWithdrawalKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_LABEL, 1);
  assert.notEqual(k0.nullifier, k1.nullifier);
  assert.notEqual(k0.precommitment, k1.precommitment);
});

test('withdrawal keys differ by label', () => {
  const labelA = poseidon2([123n, 456n]);
  const labelB = poseidon2([789n, 101n]);
  const kA = ppDeriveWithdrawalKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, labelA, 0);
  const kB = ppDeriveWithdrawalKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, labelB, 0);
  assert.notEqual(kA.nullifier, kB.nullifier);
  assert.notEqual(kA.precommitment, kB.precommitment);
});

test('withdrawal precommitment matches hardcoded regression value', () => {
  const k = ppDeriveWithdrawalKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_LABEL, 0);
  assert.equal(k.precommitment, 1498187307751531547739050021339576787746854005122278518607550109185386234750n);
});

test('withdrawal keys are within BN254 scalar field', () => {
  for (let i = 0; i < 2; i++) {
    const k = ppDeriveWithdrawalKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_LABEL, i);
    assert(k.nullifier > 0n && k.nullifier < SNARK_SCALAR_FIELD);
    assert(k.secret > 0n && k.secret < SNARK_SCALAR_FIELD);
    assert(k.precommitment > 0n && k.precommitment < SNARK_SCALAR_FIELD);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  5. Deposit vs withdrawal isolation
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── Cross-path isolation ──');

test('deposit and withdrawal use identical algorithm — isolation comes from distinct inputs', () => {
  // Same poseidon3 call with identical inputs → identical outputs. This is expected.
  // The safety property is that scope (pool address) and label (commitment hash)
  // are always different values in production.
  const sharedValue = 999n;
  const dk = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, sharedValue, 0);
  const wk = ppDeriveWithdrawalKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, sharedValue, 0);
  assert.equal(dk.nullifier, wk.nullifier, 'same inputs produce same output');
  assert.equal(dk.secret, wk.secret, 'same inputs produce same output');
  assert.equal(dk.precommitment, wk.precommitment, 'same inputs produce same output');
});

test('deposit scope (pool address) != withdrawal label (commitment hash) guarantees isolation', () => {
  // In production: scope is a pool contract address, label is a poseidon hash.
  // These are astronomically unlikely to collide.
  const scope = 0xF241d57C6DebAe225c0F2e6eA1529373C9A9C9fBn;
  const label = poseidon2([12345n, 67890n]); // commitment hash
  const dk = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, scope, 0);
  const wk = ppDeriveWithdrawalKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, label, 0);
  assert.notEqual(dk.nullifier, wk.nullifier);
  assert.notEqual(dk.secret, wk.secret);
  assert.notEqual(dk.precommitment, wk.precommitment);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  6. HD key derivation compatibility
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── HD key derivation (SDK v1.2.0 compatibility) ──');

test('safe hd seed keeps full 256-bit precision', () => {
  const fakeKey = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  const safeSeed = deriveHdSeed(fakeKey, 'safe');
  assert.equal(safeSeed, BigInt(fakeKey));
  assert(safeSeed > BigInt(Number(BigInt(fakeKey))), 'safe seed preserves more precision than legacy truncation');
});

test('legacy hd seed still truncates like bytesToNumber for old accounts', () => {
  const fakeKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const legacySeed = deriveHdSeed(fakeKey, 'legacy');
  assert.equal(legacySeed, BigInt(Number(BigInt(fakeKey))));
  const ref = poseidon1([legacySeed]);
  for (let i = 0; i < 3; i++) {
    assert.equal(poseidon1([deriveHdSeed(fakeKey, 'legacy')]), ref);
  }
});

test('safe and legacy master keys diverge for 256-bit hd keys', () => {
  const key1 = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const key2 = '0x2222222222222222222222222222222222222222222222222222222222222222';
  const safe = deriveMasterKeysFromHdKeys(key1, key2, 'safe');
  const legacy = deriveMasterKeysFromHdKeys(key1, key2, 'legacy');
  assert.notEqual(safe.masterNullifier, legacy.masterNullifier);
  assert.notEqual(safe.masterSecret, legacy.masterSecret);
  assert(safe.masterNullifier > 0n && safe.masterNullifier < SNARK_SCALAR_FIELD);
  assert(safe.masterSecret > 0n && safe.masterSecret < SNARK_SCALAR_FIELD);
  assert(legacy.masterNullifier > 0n && legacy.masterNullifier < SNARK_SCALAR_FIELD);
  assert(legacy.masterSecret > 0n && legacy.masterSecret < SNARK_SCALAR_FIELD);
});

console.log('\n── Wallet seed versioning ──');

test('wallet seed contexts differ between v1 and v2', () => {
  assert.equal(ppWalletSeedContext('v1'), 'privacy-pools/wallet-seed:v1');
  assert.equal(ppWalletSeedContext('v2'), 'privacy-pools/wallet-seed:v2');
  assert.notEqual(ppWalletSeedContext('v1'), ppWalletSeedContext('v2'));
});

test('legacy wallet seed uses 128-bit entropy and v2 uses 256-bit entropy', () => {
  assert.equal(ppWalletSeedEntropyBits('v1'), 128);
  assert.equal(ppWalletSeedEntropyBits('v2'), 256);
});

test('shared typed-data helper matches the canonical v1 payload exactly', () => {
  const address = '0x8fd379246834eac74B8419FfdA202CF8051F7A03';
  const typedData = JSON.parse(JSON.stringify(appBuildWalletSeedTypedData(address, 'v1')));
  assert.deepEqual(typedData, {
    domain: { name: 'Privacy Pools', version: '1' },
    types: {
      DeriveSeed: [
        { name: 'action', type: 'string' },
        { name: 'context', type: 'string' },
        { name: 'addressHash', type: 'bytes32' },
      ],
    },
    primaryType: 'DeriveSeed',
    message: {
      action: 'Derive Account Seed',
      context: 'privacy-pools/wallet-seed:v1',
      addressHash: ethers.keccak256(ethers.getBytes(address)),
    },
  });
  assert.deepEqual(Object.keys(typedData.message).sort(), ['action', 'addressHash', 'context']);
});

test('shared typed-data helper matches the canonical v2 payload exactly', () => {
  const address = '0x8fd379246834eac74B8419FfdA202CF8051F7A03';
  const typedData = JSON.parse(JSON.stringify(appBuildWalletSeedTypedData(address, 'v2')));
  assert.deepEqual(typedData, {
    domain: { name: 'Privacy Pools', version: '1' },
    types: {
      DeriveSeed: [
        { name: 'action', type: 'string' },
        { name: 'context', type: 'string' },
        { name: 'addressHash', type: 'bytes32' },
      ],
    },
    primaryType: 'DeriveSeed',
    message: {
      action: 'Derive Account Seed',
      context: 'privacy-pools/wallet-seed:v2',
      addressHash: ethers.keccak256(ethers.getBytes(address)),
    },
  });
  assert.deepEqual(Object.keys(typedData.message).sort(), ['action', 'addressHash', 'context']);
});

test('shared signature helper reproduces the canonical deterministic signature', async () => {
  const privateKey = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const wallet = new ethers.Wallet(privateKey);
  const signature = await appDeriveWalletSeedSignature(wallet, wallet.address, 'v2');
  assert.equal(
    signature,
    '0x7dd8ed1057b460d0a2939725542fa7b3f8942f3e714082435164b6c37afa8f0b3de41b054aec2e1a8e4a518042f489db09a0928d98c8d2d78ea8c9c9b97aa8911b',
  );
});

test('shared signature-to-mnemonic helper preserves the canonical v2 phrase', async () => {
  const privateKey = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const derived = await ppDeriveWalletMnemonic(privateKey, 'v2');
  const mnemonic = await appDeriveWalletSeedMnemonicFromSignature(derived.signature, derived.address, 'v2');
  assert.equal(
    mnemonic.phrase,
    'leg steak curious unaware false coffee token amount gossip violin caught foam lunar acquire now cash ability pair summer suit thunder spin describe artwork',
  );
});

test('shared signature-to-mnemonic helper rejects malformed signatures fail-closed', async () => {
  await assert.rejects(
    () => appDeriveWalletSeedMnemonicFromSignature('0x1234', '0x8fd379246834eac74B8419FfdA202CF8051F7A03', 'v2'),
    /Invalid signature length/,
  );
});

test('shared wallet-seed orchestration helper preserves the canonical v1 phrase', async () => {
  const privateKey = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const wallet = new ethers.Wallet(privateKey);
  const mnemonic = await appDeriveWalletSeed(wallet, wallet.address, 'v1');
  assert.equal(
    mnemonic.phrase,
    'balance beef phrase when cute tone excess orbit supreme turtle grant song',
  );
});

test('wallet-derived v1 mnemonic matches the canonical deterministic vector', async () => {
  const derived = await ppDeriveWalletMnemonic(
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'v1',
  );
  assert.equal(derived.address, '0x8fd379246834eac74B8419FfdA202CF8051F7A03');
  assert.equal(
    derived.signature,
    '0x683a71947b08997ecabbdc30e4428bfc667f2a6ddcca5acd54ff263499161b6a2f99442b8fe63f74168b9c884f74244b6d2e0c9c8b527f39ad4fc1978fbcd6b11c',
  );
  assert.equal(
    derived.mnemonic.phrase,
    'balance beef phrase when cute tone excess orbit supreme turtle grant song',
  );
  assert.equal(ppDeriveWalletMasterKeys(derived.mnemonic, 'safe').masterNullifier, 21714767383873811356026703648140636088049773679134530645715666881245477838600n);
  assert.equal(ppDeriveWalletMasterKeys(derived.mnemonic, 'safe').masterSecret, 2313678352674809104289031563479915316695415708264861938079169028508258930244n);
  assert.equal(ppDeriveWalletMasterKeys(derived.mnemonic, 'legacy').masterNullifier, 19395970097533534986192183671933054422198728623554741107491370224706127138834n);
  assert.equal(ppDeriveWalletMasterKeys(derived.mnemonic, 'legacy').masterSecret, 4784437395811465677638853664905111266381218266111922105402673462692425399573n);
});

test('wallet-derived v2 mnemonic matches the canonical deterministic vector', async () => {
  const derived = await ppDeriveWalletMnemonic(
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'v2',
  );
  assert.equal(derived.address, '0x8fd379246834eac74B8419FfdA202CF8051F7A03');
  assert.equal(
    derived.signature,
    '0x7dd8ed1057b460d0a2939725542fa7b3f8942f3e714082435164b6c37afa8f0b3de41b054aec2e1a8e4a518042f489db09a0928d98c8d2d78ea8c9c9b97aa8911b',
  );
  assert.equal(
    derived.mnemonic.phrase,
    'leg steak curious unaware false coffee token amount gossip violin caught foam lunar acquire now cash ability pair summer suit thunder spin describe artwork',
  );
  assert.equal(ppDeriveWalletMasterKeys(derived.mnemonic, 'safe').masterNullifier, 11004014446923394146163674023384271253389186342588884686484403797957068672042n);
  assert.equal(ppDeriveWalletMasterKeys(derived.mnemonic, 'safe').masterSecret, 7519711529599660434665922316666032718700481529342101979711146121903451412460n);
  assert.equal(ppDeriveWalletMasterKeys(derived.mnemonic, 'legacy').masterNullifier, 3889574738913266875051599445031320200644132601634090549411042274149067019911n);
  assert.equal(ppDeriveWalletMasterKeys(derived.mnemonic, 'legacy').masterSecret, 1010789321856576828358212594735301713285780700071983686555955435469722712486n);
});

console.log('\n── Canonical pool scopes ──');

test('mainnet ETH pool scope matches the canonical Privacy Pools value', () => {
  assert.equal(
    ppComputeScope(
      '0xF241d57C6DebAe225c0F2e6eA1529373C9A9C9fB',
      '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    ),
    4916574638117198869413701114161172350986437430914933850166949084132905299523n,
  );
});

test('mainnet BOLD pool scope matches the canonical Privacy Pools value', () => {
  assert.equal(
    ppComputeScope(
      '0xb4b5Fd38Fd4788071d7287e3cB52948e0d10b23E',
      '0x6440f144b7e50D6a8439336510312d2F54beB01D',
    ),
    12594345321156708920712766274402096360984745412708601457862140420990105325804n,
  );
});

test('mainnet wstETH pool scope matches the canonical Privacy Pools value', () => {
  assert.equal(
    ppComputeScope(
      '0x1A604E9DFa0EFDC7FFda378AF16Cb81243b61633',
      '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    ),
    472674026048933344947929992064610492276304547390666782210980269768303717449n,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  7. Full pipeline regression (known-answer from captured values)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── Full pipeline regression ──');

// Hardcoded regression vectors for the full deposit→withdrawal pipeline.
// These vectors are independent of the HD key derivation mode.
// masterKeys = poseidon1([42]), poseidon1([43])
// scope = 0xF241d57C6DebAe225c0F2e6eA1529373C9A9C9fB (ETH pool)
const PIPELINE = {
  deposit0: {
    nullifier:     14812872908495636563659114070895846784692041617165414870066712468037177905680n,
    secret:        19398466175589662031858502141309439441526761231766373612796993695530463445002n,
    precommitment: 7401488295419196436257358403189492305761693180908177863987681050820699998762n,
  },
  deposit1: {
    nullifier:     7766652984107266816972683845346685138570961528738143484531463694009827010109n,
    secret:        19516254295269567444467370098125368809589831928253575195927971054850412648327n,
    precommitment: 9384945721071900139496055362129371607208886629180576200291168050052562800941n,
  },
  withdraw0: { // derived with label = deposit0.precommitment
    nullifier:     11347116685582394720554832776176272332679984211779841839947632487214931866967n,
    secret:        2805761980112443371793201462547446887060435801775259290448709303539202642096n,
    precommitment: 7599896483308647686441771533662550551547897525271558467253814703433210755291n,
  },
};

test('deposit[0] matches hardcoded regression vector', () => {
  const k = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_SCOPE, 0);
  assert.equal(k.nullifier, PIPELINE.deposit0.nullifier);
  assert.equal(k.secret, PIPELINE.deposit0.secret);
  assert.equal(k.precommitment, PIPELINE.deposit0.precommitment);
});

test('deposit[1] matches hardcoded regression vector', () => {
  const k = ppDeriveDepositKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, TEST_SCOPE, 1);
  assert.equal(k.nullifier, PIPELINE.deposit1.nullifier);
  assert.equal(k.secret, PIPELINE.deposit1.secret);
  assert.equal(k.precommitment, PIPELINE.deposit1.precommitment);
});

test('withdrawal from deposit[0] matches hardcoded regression vector', () => {
  const k = ppDeriveWithdrawalKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, PIPELINE.deposit0.precommitment, 0);
  assert.equal(k.nullifier, PIPELINE.withdraw0.nullifier);
  assert.equal(k.secret, PIPELINE.withdraw0.secret);
  assert.equal(k.precommitment, PIPELINE.withdraw0.precommitment);
});

test('withdrawal keys derived from deposit precommitment are unique per deposit', () => {
  const w0 = ppDeriveWithdrawalKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, PIPELINE.deposit0.precommitment, 0);
  const w1 = ppDeriveWithdrawalKeys(TEST_MASTER_NULLIFIER, TEST_MASTER_SECRET, PIPELINE.deposit1.precommitment, 0);
  assert.notEqual(w0.nullifier, w1.nullifier);
  assert.notEqual(w0.precommitment, w1.precommitment);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Summary
// ═══════════════════════════════════════════════════════════════════════════════

await done();
