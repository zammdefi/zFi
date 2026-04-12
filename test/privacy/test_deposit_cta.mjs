#!/usr/bin/env node
//
// Privacy deposit CTA journey tests.
//
// Exercises the live deposit CTA helpers exposed through the gated PP test API:
// context building, CTA state computation, balance refresh orchestration, and
// the supported asset/zap/input trigger seams.
//
// Usage: node test/privacy/test_deposit_cta.mjs
//
import { strict as assert } from 'node:assert';
import { createElement, createHarness as createPrivacyHarness, createTestRunner, flushMicrotasks } from './_app_source_utils.mjs';

const TEST_CONSOLE = { log() {}, warn() {}, error() {} };
const CONNECTED_ADDRESS = '0x1111111111111111111111111111111111111111';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const WSTETH_ADDRESS = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0';
const BOLD_ADDRESS = '0x6440f144b7e50d6a8439336510312d2f54beb01d';
const ZROUTER_ADDRESS = '0x8888888888888888888888888888888888888888';

const { test, done } = createTestRunner();

function createConfig(poolSuffix, minimumDepositAmount) {
  return {
    pool: `0x${poolSuffix}`.padEnd(42, '0'),
    minimumDepositAmount,
    vettingFeeBPS: 0n,
    maxRelayFeeBPS: 50n,
  };
}

function createHarness({
  globals = {},
  statePatch = null,
  extraElements = {},
} = {}) {
  return createPrivacyHarness({
    globals: {
      console: TEST_CONSOLE,
      tokens: {
        ETH: { decimals: 18 },
        BOLD: { decimals: 18 },
        wstETH: { decimals: 18 },
      },
      ZERO_ADDRESS,
      WSTETH_ADDRESS,
      BOLD_ADDRESS,
      ICONS: {},
      _activeTab: 'privacy',
      _connectedAddress: CONNECTED_ADDRESS,
      _signer: { getAddress: async () => CONNECTED_ADDRESS },
      _ppSelectedAsset: 'ETH',
      _ppZapMode: false,
      _ppConfig: createConfig('eth', 1_000000000000000000n),
      _ppConfigBold: createConfig('bold', 100_000000000000000000n),
      _ppConfigWstETH: createConfig('wsteth', 2_000000000000000000n),
      _ppDepositBalanceRefreshState: { key: null, promise: null, lastFailedKey: null, lastFailedAt: 0 },
      _ppDepositEthBalanceRefreshState: { key: null, promise: null, lastFailedKey: null, lastFailedAt: 0 },
      fromToken: 'USDC',
      ZROUTER_ADDRESS,
      _walletProvider: null,
      loadPPConfig() {},
      syncPrivacyURL() {},
      updateTokenDisplay() {},
      handleAmountChange() {},
      switchTab() {},
      ppwSetMode() {},
      ppwUpdatePreview() {},
      ppwOnRecipientInput() {},
      ppRenderDepositRoundedSuggestions() {},
      ppRefreshWalletCompatibility() {},
      ppGetWalletCompatibilitySnapshot() {
        return { status: 'ready', result: { supported: true, kind: 'eoa', message: '' } };
      },
      ppRequestZapEstimate() {},
      ppReadWithRpc: async (reader) => reader({ getBalance: async () => 0n }),
      ...globals,
    },
    statePatch,
    baseElements: {
      privacyTab: createElement({ style: { display: '' } }),
      ppDepositBtn: createElement(),
      ppDepositValidationHint: createElement(),
      ppBalance: createElement(),
      ppAmount: createElement({ value: '' }, { trackListeners: true }),
      ppZapEstimate: createElement(),
      ppZapEstAmt: createElement(),
      ppAmountLabel: createElement(),
      ppMinUnit: createElement(),
      ppAssetETH: createElement(),
      ppAssetBOLD: createElement(),
      ppAssetWSTETH: createElement(),
      ppSwapAssetETH: createElement(),
      ppSwapAssetBOLD: createElement(),
      ppSwapAssetWSTETH: createElement(),
      ppZapBtn: createElement(),
      ppwWithdrawAmt: createElement(),
      ppwRecipient: createElement(),
    },
    extraElements,
  });
}

console.log('\n-- Deposit CTA states --');

test('disconnected wallet keeps the deposit CTA on connect state', () => {
  const harness = createHarness({
    globals: {
      _connectedAddress: null,
      _signer: null,
    },
  });

  harness.api.deposit.ppUpdateDepositCta();

  assert.equal(harness.elements.ppDepositBtn.textContent, 'Connect Wallet');
  assert.equal(harness.elements.ppDepositBtn.disabled, false);
  assert.equal(harness.elements.ppBalance.textContent, 'Balance: --');
  assert.equal(harness.elements.ppDepositValidationHint.style.display, 'none');
});

test('wallet compatibility checking blocks the deposit CTA fail-closed', () => {
  const harness = createHarness();
  harness.context.ppGetWalletCompatibilitySnapshot = () => ({ status: 'checking', result: null });
  harness.elements.ppAmount.value = '1';

  harness.api.deposit.ppUpdateDepositCta();

  assert.equal(harness.elements.ppDepositBtn.textContent, 'Checking wallet...');
  assert.equal(harness.elements.ppDepositBtn.disabled, true);
});

test('unsupported wallet and recovery backup gates use the live access policy', () => {
  const unsupported = createHarness();
  unsupported.context.ppGetWalletCompatibilitySnapshot = () => ({
    status: 'ready',
    result: { supported: false, kind: 'safe_wallet', message: 'blocked' },
  });
  unsupported.elements.ppAmount.value = '1';
  unsupported.api.deposit.ppUpdateDepositCta();
  assert.equal(unsupported.elements.ppDepositBtn.textContent, 'Wallet not supported');

  const pendingKey = `${CONNECTED_ADDRESS.toLowerCase()}:v2`;
  const backup = createHarness({
    statePatch: {
      _ppPendingWalletSeedBackups: {
        [pendingKey]: {
          address: CONNECTED_ADDRESS,
          version: 'v2',
          phrase: 'seed',
          derivedKeys: { safe: { masterNullifier: 1n, masterSecret: 2n } },
          downloaded: false,
          acknowledged: false,
        },
      },
      _ppActiveWalletSeedBackupKey: pendingKey,
    },
  });
  backup.elements.ppAmount.value = '1';
  backup.api.deposit.ppUpdateDepositCta();
  assert.equal(backup.elements.ppDepositBtn.textContent, 'Save recovery phrase to continue');
});

test('empty and invalid amounts stay blocked with the expected copy', () => {
  const emptyHarness = createHarness();
  emptyHarness.api.deposit.ppUpdateDepositCta();
  assert.equal(emptyHarness.elements.ppDepositBtn.textContent, 'Enter an amount');

  const invalidHarness = createHarness();
  invalidHarness.elements.ppAmount.value = 'abc';
  invalidHarness.api.deposit.ppUpdateDepositCta();
  assert.equal(invalidHarness.elements.ppDepositBtn.textContent, 'Invalid amount');
});

test('minimum checks stay intact for direct deposits and zap deposits', () => {
  const directHarness = createHarness({
    statePatch: {
      _ppConfig: createConfig('eth', 2_000000000000000000n),
    },
  });
  directHarness.elements.ppAmount.value = '1';
  directHarness.api.deposit.ppUpdateDepositCta();
  assert.match(directHarness.elements.ppDepositBtn.textContent, /^Min 2(\.0+)? ETH$/);

  const zapHarness = createHarness({
    statePatch: {
      _ppSelectedAsset: 'wstETH',
      _ppZapMode: true,
      _ppConfigWstETH: createConfig('wsteth', 2_000000000000000000n),
      _ppZapEstimate: 1_000000000000000000n,
    },
  });
  zapHarness.elements.ppAmount.value = '1';
  zapHarness.api.deposit.ppUpdateDepositCta();
  assert.match(zapHarness.elements.ppDepositBtn.textContent, /^Est\. below min 2(\.0+)? wstETH$/);
});

test('unknown balances trigger one refresh, show checking state, and rerender once on settle', async () => {
  let readCalls = 0;
  let resolveBalance;
  const pendingBalance = new Promise((resolve) => {
    resolveBalance = resolve;
  });
  const harness = createHarness({
    globals: {
      ppReadWithRpc: async (reader) => reader({
        getBalance: async () => {
          readCalls += 1;
          return pendingBalance;
        },
      }),
    },
  });
  harness.elements.ppAmount.value = '1';
  let renderCalls = 0;
  const originalRender = harness.context.ppRenderDepositCtaState;
  harness.context.ppRenderDepositCtaState = (state) => {
    renderCalls += 1;
    return originalRender(state);
  };

  harness.api.deposit.ppUpdateDepositCta();
  harness.api.deposit.ppUpdateDepositCta();

  assert.equal(readCalls, 1);
  assert.equal(harness.elements.ppDepositBtn.textContent, 'Checking balance...');
  assert.equal(harness.elements.ppDepositBtn.disabled, true);
  assert.equal(harness.elements.ppDepositValidationHint.textContent, 'Checking balance...');

  const renderCallsBeforeSettle = renderCalls;
  resolveBalance(5_000000000000000000n);
  await flushMicrotasks();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(renderCallsBeforeSettle, 2, 'expected one render per explicit CTA update');
  assert.equal(renderCalls, renderCallsBeforeSettle + 1, 'expected exactly one settle rerender');
  assert.equal(harness.elements.ppDepositBtn.textContent, 'Deposit');
  assert.equal(harness.elements.ppDepositBtn.disabled, false);
  assert.match(harness.elements.ppDepositValidationHint.textContent, /^Available: 5(\.0+)? ETH$/);
});

test('recent refresh failure backoff does not fake a spinner or hard-block the CTA', () => {
  let readCalls = 0;
  const harness = createHarness({
    globals: {
      ppReadWithRpc: async () => {
        readCalls += 1;
        return 0n;
      },
    },
    statePatch: {
      _ppDepositBalanceRefreshState: {
        key: null,
        promise: null,
        lastFailedKey: `${CONNECTED_ADDRESS.toLowerCase()}:ETH`,
        lastFailedAt: Date.now(),
      },
    },
  });
  harness.elements.ppAmount.value = '1';

  harness.api.deposit.ppUpdateDepositCta();

  assert.equal(readCalls, 0);
  assert.equal(harness.elements.ppDepositBtn.textContent, 'Deposit');
  assert.equal(harness.elements.ppDepositBtn.disabled, false);
  assert.equal(harness.elements.ppDepositValidationHint.style.display, 'none');
});

test('cached balances drive insufficient and sufficient CTA states', () => {
  const insufficient = createHarness();
  insufficient.setCachedBalance(ZERO_ADDRESS, 1_000000000000000000n);
  insufficient.elements.ppAmount.value = '2';
  insufficient.api.deposit.ppUpdateDepositCta();
  assert.equal(insufficient.elements.ppDepositBtn.textContent, 'Insufficient ETH balance');
  assert.equal(insufficient.elements.ppDepositBtn.disabled, true);
  assert.match(insufficient.elements.ppDepositValidationHint.textContent, /^Insufficient ETH balance/);

  const sufficient = createHarness();
  sufficient.setCachedBalance(ZERO_ADDRESS, 3_000000000000000000n);
  sufficient.elements.ppAmount.value = '2';
  sufficient.api.deposit.ppUpdateDepositCta();
  assert.equal(sufficient.elements.ppDepositBtn.textContent, 'Deposit');
  assert.equal(sufficient.elements.ppDepositBtn.disabled, false);
  assert.match(sufficient.elements.ppDepositValidationHint.textContent, /^Available: 3(\.0+)? ETH$/);
});

test('native deposits keep an ETH gas reserve in the CTA state', () => {
  const harness = createHarness();
  harness.setCachedBalance(ZERO_ADDRESS, 1_000000000000000000n);
  harness.elements.ppAmount.value = '0.99';

  harness.api.deposit.ppUpdateDepositCta();

  assert.equal(harness.elements.ppDepositBtn.textContent, 'Keep ETH for gas');
  assert.equal(harness.elements.ppDepositBtn.disabled, true);
  assert.match(harness.elements.ppDepositValidationHint.textContent, /Keep about/);
});

test('erc20 deposits require a separate cached ETH balance for gas', () => {
  const harness = createHarness({
    statePatch: {
      _ppSelectedAsset: 'BOLD',
    },
  });
  const { bold } = harness.api.constants.addresses;
  harness.setCachedBalance(bold, 10_000000000000000000n);
  harness.setCachedBalance(ZERO_ADDRESS, 1_000000000000000n);
  harness.elements.ppAmount.value = '1';

  harness.api.deposit.ppUpdateDepositCta();

  assert.equal(harness.elements.ppDepositBtn.textContent, 'Insufficient ETH for gas');
  assert.equal(harness.elements.ppDepositBtn.disabled, true);
  assert.match(harness.elements.ppDepositValidationHint.textContent, /approval and deposit/);
});

console.log('\n-- Deposit CTA triggers --');

test('asset changes and zap toggles reroute through the renamed deposit CTA seam', () => {
  const calls = [];
  const harness = createHarness({
    globals: {
      loadPPConfig() { calls.push('config'); },
      syncPrivacyURL() { calls.push('sync-url'); },
    },
  });
  harness.context.ppUpdateDepositCta = () => { calls.push('deposit-cta'); };
  harness.context.ppRequestZapEstimate = () => { calls.push('zap-estimate'); };

  harness.api.deposit.ppSelectAsset('BOLD');
  assert.deepEqual(calls, ['config', 'deposit-cta', 'sync-url']);

  calls.length = 0;
  harness.api.deposit.ppSetZap(true);
  assert.deepEqual(calls, ['config', 'zap-estimate', 'deposit-cta', 'sync-url']);
});

test('amount input wiring still routes through ppUpdateDepositCta', () => {
  const calls = [];
  const harness = createHarness({
    globals: {
      syncPrivacyURL() { calls.push('sync-url'); },
    },
  });
  harness.context.ppUpdateDepositCta = () => { calls.push('deposit-cta'); };
  harness.context.ppRequestZapEstimate = () => { calls.push('zap-estimate'); };

  assert.equal(typeof harness.domReadyHandler, 'function');
  harness.domReadyHandler();

  const inputHandler = harness.elements.ppAmount.getListener('input');
  assert.equal(typeof inputHandler, 'function');
  inputHandler({ type: 'input' });

  assert.deepEqual(calls, ['deposit-cta', 'sync-url', 'zap-estimate']);
});

console.log('\n-- Deposit execution safety --');

test('deposit blocks submission when the target pool is wound down', async () => {
  const harness = createHarness({
    globals: {
      ppReadWithRpc: async () => true,
    },
  });
  let submitCalls = 0;
  harness.context.ppEnsureDepositWalletAccess = async () => true;
  harness.context.ppGetDepositMinimumError = () => null;
  harness.context.ppGetDepositBalanceError = async () => null;
  harness.context.ppSubmitStandardDeposit = async () => {
    submitCalls += 1;
    return null;
  };
  harness.elements.ppAmount.value = '1';

  await harness.api.deposit.ppDeposit();

  assert.equal(submitCalls, 0);
  assert.equal(
    harness.lastStatus?.message,
    'This Privacy Pool has been wound down and is no longer accepting deposits.',
  );
});

test('deposit blocks submission when pool status cannot be verified over RPC', async () => {
  const warnings = [];
  const harness = createHarness({
    globals: {
      console: {
        log() {},
        warn(...args) {
          warnings.push(args);
        },
        error() {},
      },
      ppReadWithRpc: async () => {
        throw new Error('rpc unavailable');
      },
    },
  });
  let submitCalls = 0;
  harness.context.ppEnsureDepositWalletAccess = async () => true;
  harness.context.ppGetDepositMinimumError = () => null;
  harness.context.ppGetDepositBalanceError = async () => null;
  harness.context.ppSubmitStandardDeposit = async () => {
    submitCalls += 1;
    return null;
  };
  harness.elements.ppAmount.value = '1';

  await harness.api.deposit.ppDeposit();

  assert.equal(submitCalls, 0);
  assert.equal(
    harness.lastStatus?.message,
    'Could not verify whether this Privacy Pool is accepting deposits. Retry when RPC connectivity is stable.',
  );
  assert.equal(warnings.length > 0, true);
});

test('submit-time balance checks use the conservative gas fallback when estimation is unavailable', async () => {
  const harness = createHarness({
    globals: {
      ppReadWithRpc: async (reader) => reader({
        getBalance: async () => 1_000000000000000000n,
        getFeeData: async () => { throw new Error('fee unavailable'); },
      }),
    },
  });
  const intent = harness.context.ppParseDepositIntent('0.99');
  const error = await harness.api.deposit.ppGetDepositBalanceError(intent, {
    connectedAddress: CONNECTED_ADDRESS,
    provider: null,
    readWithRpc: harness.context.ppReadWithRpc,
  });

  assert.match(error, /Keep about/);
});

test('submit-time balance checks fail closed when balances cannot be verified', async () => {
  const harness = createHarness({
    globals: {
      ppReadWithRpc: async () => { throw new Error('rpc unavailable'); },
    },
  });
  const intent = harness.context.ppParseDepositIntent('0.99');
  const error = await harness.api.deposit.ppGetDepositBalanceError(intent, {
    connectedAddress: CONNECTED_ADDRESS,
    provider: null,
    readWithRpc: harness.context.ppReadWithRpc,
  });

  assert.equal(error, 'Could not verify your balance or gas reserve. Retry when RPC connectivity is stable.');
});

test('erc20 deposits approve the entrypoint and deposit directly from the wallet', async () => {
  const calls = [];
  const seenAddresses = [];
  const harness = createHarness({
    globals: {
      wcTransaction: async (txPromise) => txPromise,
      waitForTx: async (tx) => ({ status: 1, transactionHash: tx.hash }),
    },
  });
  const { entrypoint, bold } = harness.api.constants.addresses;
  const originalEthers = harness.context.ethers;
  harness.context.ethers = Object.create(originalEthers);
  harness.context.ethers.Contract = function Contract(address) {
    seenAddresses.push(String(address).toLowerCase());
    if (String(address).toLowerCase() === bold.toLowerCase()) {
      return {
        approve: async (spender, amount) => {
          calls.push(['approve', spender, amount]);
          return { hash: '0xapprove-bold', wait: async () => ({ status: 1 }) };
        },
      };
    }
    if (String(address).toLowerCase() === String(entrypoint).toLowerCase()) {
      return {
        'deposit(address,uint256,uint256)': async (asset, amount, precommitment) => {
          calls.push(['deposit', asset, amount, precommitment]);
          return { hash: '0xdeposit-bold', wait: async () => ({ status: 1 }) };
        },
      };
    }
    return {};
  };
  harness.context.ppReadDepositTokenAllowance = async () => 0n;
  harness.context.ppLoadDepositKeys = async (state) => {
    state.depositScope = 77n;
    state.depositIdx = 3;
    state.hasPendingDepositReservation = true;
    return { precommitment: 123456n };
  };

  const state = harness.context.ppCreateDepositExecutionState({
    selectedAsset: 'BOLD',
    amount: 5n,
    isWSTETH: false,
    isERC20PP: true,
  }, harness.elements.ppDepositBtn);
  let submission;
  try {
    submission = await harness.api.deposit.ppSubmitErc20Deposit(state);
  } finally {
    harness.context.ethers = originalEthers;
  }

  assert.deepEqual(calls, [
    ['approve', entrypoint, 5n],
    ['deposit', bold, 5n, 123456n],
  ]);
  assert.deepEqual(new Set(seenAddresses), new Set([bold.toLowerCase(), String(entrypoint).toLowerCase()]));
  assert.equal(submission?.tx?.hash, '0xdeposit-bold');
});

test('zap deposits convert first, then deposit directly into the entrypoint', async () => {
  const sendCalls = [];
  const contractCalls = [];
  const harness = createHarness({
    statePatch: {
      _ppSelectedAsset: 'wstETH',
      _ppZapMode: true,
      _ppConfigWstETH: createConfig('wsteth', 2n),
    },
    globals: {
      _signer: {
        getAddress: async () => CONNECTED_ADDRESS,
        sendTransaction: async (tx) => {
          sendCalls.push(tx);
          return { hash: '0xswap-zap', wait: async () => ({ status: 1 }) };
        },
      },
      wcTransaction: async (txPromise) => txPromise,
      waitForTx: async (tx) => ({ status: 1, transactionHash: tx.hash }),
    },
  });
  const { entrypoint, router, wstETH } = harness.api.constants.addresses;
  const originalEthers = harness.context.ethers;
  harness.context.ethers = Object.create(originalEthers);
  harness.context.ethers.Contract = function Contract(address) {
    if (String(address).toLowerCase() === wstETH.toLowerCase()) {
      return {
        approve: async (spender, amount) => {
          contractCalls.push(['approve', spender, amount]);
          return { hash: '0xapprove-zap', wait: async () => ({ status: 1 }) };
        },
      };
    }
    if (String(address).toLowerCase() === String(entrypoint).toLowerCase()) {
      return {
        'deposit(address,uint256,uint256)': async (asset, amount, precommitment) => {
          contractCalls.push(['deposit', asset, amount, precommitment]);
          return { hash: '0xdeposit-zap', wait: async () => ({ status: 1 }) };
        },
      };
    }
    throw new Error('Unexpected contract address: ' + address);
  };
  harness.context.ppBuildZapDepositPlan = async () => ({
    depositAmount: 7n,
    routeLabel: 'Lido',
    zapSwapCalls: ['0xabc123'],
    txValue: 3n,
  });
  const balances = [1n, 9n];
  harness.context.ppReadDepositTokenBalance = async () => balances.shift();
  harness.context.ppReadDepositTokenAllowance = async () => 0n;
  harness.context.ppLoadDepositKeys = async (state) => {
    state.depositScope = 88n;
    state.depositIdx = 4;
    state.hasPendingDepositReservation = true;
    return { precommitment: 654321n };
  };

  const state = harness.context.ppCreateDepositExecutionState({
    selectedAsset: 'wstETH',
    amount: 3n,
    isZap: true,
    isWSTETH: true,
    isERC20PP: true,
  }, harness.elements.ppDepositBtn);
  let submission;
  try {
    submission = await harness.api.deposit.ppSubmitZapDeposit(state);
  } finally {
    harness.context.ethers = originalEthers;
  }

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].to, router);
  assert.equal(sendCalls[0].value, 3n);
  const routerIface = new harness.context.ethers.Interface(['function multicall(bytes[])']);
  const decoded = routerIface.decodeFunctionData('multicall', sendCalls[0].data);
  assert.deepEqual(Array.from(decoded[0]), ['0xabc123']);
  assert.deepEqual(contractCalls, [
    ['approve', entrypoint, 8n],
    ['deposit', wstETH, 8n, 654321n],
  ]);
  assert.equal(submission?.tx?.hash, '0xdeposit-zap');
});

await done();
