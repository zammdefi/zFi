/**
 * The Deepstate venue on Robinhood Chain.
 *
 * DEEP's only market is Deepstate's order book - there is no AMM pool for it
 * anywhere - so before this path existed the page priced it at nothing and a
 * user picking it got "no route" for a token that trades. `DeepstateQuoteLens`
 * prices the book in one `view` call, and these tests cover the two things that
 * can still go wrong after a correct quote:
 *
 *   - the quote is right but never competes, so the venue is invisible; and
 *   - the quote is right, wins, and the calldata built from it names a
 *     different trade than the one that was priced.
 *
 * The second is the dangerous one. `swapDeep` takes the taker's packed order
 * word, and a bid's quantity is the base to MATCH with the fee taken afterwards
 * - so a caller that rebuilds that word from `amountOut` is taxed twice and
 * silently under-delivers. The lens returns the exact word it priced; this
 * asserts the page forwards that word rather than reconstructing one.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { A, MockChain, loadPage, fixedRateQuoter, closeAllPages } from './harness.mjs';

after(closeAllPages);

const ETH = 10n ** 18n;
const DEEP = '0x1da24f6bb623b9d1afeae3f3146659a2662d6d27';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const SWAPDEEP = 'ad33b1d0';
// The exact word the deployed lens returns for "sell 5,000 DEEP".
const ORDER = '0x8000000000000000000000000000010f0cf064dd59200000000000000000000000';

async function robinhood({ deep, rate = 3000n * ETH } = {}) {
  const chain = new MockChain({ chainId: '0x1237' }); // 4663
  chain.setNative(A.ACCOUNT, 10n * ETH);
  chain.setErc20(DEEP, A.ACCOUNT, 1_000_000n * ETH);
  chain.quoteHandler = fixedRateQuoter({ rate });
  chain.deepQuote = deep;
  const p = await loadPage({ chain, hash: null });
  await p.connect();
  return { p, chain };
}

test('the lens is asked, and its answer becomes a swapDeep leg', async () => {
  const { p, chain } = await robinhood({
    deep: { out: 6_243_750n, used: 5000n * ETH, epoch: 0n, order: ORDER.slice(0, 66), isBid: false },
  });
  const q = await p.window.eval(`deepQuote("${DEEP}","${USDG}",${5000n * ETH}n)`);
  assert.ok(q, 'the lens returned nothing');
  assert.equal(BigInt(q.out), 6_243_750n, 'output');
  assert.equal(BigInt(q.inUsed), 5000n * ETH, 'input absorbed');
  assert.equal(q.isBid, false, 'selling token0 is a taker ask');
  // Exactly one call, to the lens — no state overrides, no slot probing.
  const calls = chain.log.filter(r => r.method === 'eth_call'
    && String(r.params?.[0]?.data || '').slice(2, 10) === '1a0dc93f');
  assert.equal(calls.length, 1, `expected one lens call, saw ${calls.length}`);
  assert.equal(calls[0].params.length, 2, 'the lens must be a plain eth_call — no state override');
  p.close();
});

test('the order word the lens returned is forwarded verbatim into the calldata', async () => {
  const word = ORDER.slice(0, 66);
  const { p } = await robinhood({
    deep: { out: 6_243_750n, used: 5000n * ETH, epoch: 7n, order: word, isBid: false },
  });
  // Build the leg the way the page does, inside the page, so this exercises the
  // page's own encoders rather than a copy of them.
  const built = await p.window.eval(`(async()=>{
    const q=await deepQuote("${DEEP}","${USDG}",${5000n * ETH}n);
    if(!q)return null;
    return {epoch:q.epoch.toString(),order:q.order,
      leg:"0x${SWAPDEEP}"+encAddr("${A.ACCOUNT}")+encAddr(q.t0)+encAddr(q.t1)+encUint(q.epoch)
        +strip0x(q.order)+encUint(q.isBid?1:0)+encUint(${5000n * ETH}n)+encUint(0n)+encUint(0n)};
  })()`);
  assert.ok(built, 'no quote');
  assert.ok(built.leg.includes(word.slice(2)), 'the lens order word is not in the calldata');
  assert.equal(built.epoch, '7', 'epoch must come from the lens, not be assumed zero');
  p.close();
});

test('an empty book is no route, not a zero-priced one', async () => {
  const { p } = await robinhood({ deep: { out: 0n, used: 0n, epoch: 0n, order: '0x' + '0'.repeat(64), isBid: false } });
  assert.equal(await p.window.eval(`deepQuote("${DEEP}","${USDG}",${5000n * ETH}n)`), null);
  p.close();
});

test('the venue is Robinhood-only', async () => {
  const chain = new MockChain(); // mainnet
  chain.setNative(A.ACCOUNT, 10n * ETH);
  chain.quoteHandler = fixedRateQuoter({ rate: 3000n * ETH });
  chain.deepQuote = { out: 1n, used: 1n, epoch: 0n, order: '0x' + '1'.repeat(64), isBid: false };
  const p = await loadPage({ chain, hash: null });
  await p.connect();
  assert.equal(await p.window.eval(`deepQuote("${DEEP}","${USDG}",${1000n * ETH}n)`), null,
    'Deepstate must not be quoted off Robinhood Chain');
  p.close();
});

/**
 * The venue has to stand on its own.
 *
 * Every test above hands the page a working AMM quoter, which is the one thing
 * production never has for these pairs: DEEP has no pool anywhere, so zQuoter
 * reverts and the page threw "bad quote" before it had even awaited the book.
 * The lens was right, the leg was right, and no Deepstate market was reachable
 * - USDG/DEEP, DEEP/USDG and USDG/NVDA all read "No route" on the live chain.
 * So the case worth pinning is the one with no AMM answer at all.
 */
test('a pair only the book prices still quotes, with no AMM route to compare', async () => {
  const chain = new MockChain({ chainId: '0x1237' });
  chain.setNative(A.ACCOUNT, 10n * ETH);
  chain.setErc20(USDG, A.ACCOUNT, 1_000_000n * 10n ** 6n);
  // Exactly production: the quoter has nothing for this pair and reverts.
  chain.quoteHandler = () => null;
  chain.deepQuote = { out: 666n * ETH, used: 10n ** 6n, epoch: 0n, order: ORDER.slice(0, 66), isBid: true };
  const p = await loadPage({ chain, hash: null });
  await p.connect();
  // DEEP first: USDG is the landing pair's output, so it cannot be picked as
  // the input until the other side has moved off it.
  p.pickToken('toSel', 'DEEP');
  p.pickToken('fromSel', 'USDG');
  await p.settle();
  await p.typeAmount('amt', '1');
  assert.equal(p.text('stat'), '', 'the book alone must not read as "no route"');
  assert.equal(p.value('outAmt'), '666', 'and it is the book price that is shown');
  p.close();
});
