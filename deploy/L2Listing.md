# Listing Base and Robinhood tokens on the canonical TokenList

The token list zSwap shows on Base (8453) and Robinhood Chain (4663) is the
**mainnet** registry at `0x0000006013dF75A31678B786061C2B54bf531524`
(token.list.wei.limo), filtered by chain. The page reads the registry through
its mainnet read path from whatever chain the wallet is on, keeps the rows whose
namespace is `eip155` and whose chain id is the wallet's, and only if that
leaves nothing swappable does it fall back to the built-in list baked into the
page. So the way to change what Base or Robinhood shows is to change the
registry - never the page.

## What the page reads, and how much of it

`loadTokenListRun` asks the conviction lens (`ZorgTokenListLens`, falling back to
`TokenList.rankedIds`) for every listing id, then reads `json(id)` for a bounded
window of them - `LIST_WIN`, currently 64 - and keeps the rows whose namespace is
`eip155` and whose chain id is the wallet's.

**The window is chosen by id shape, not by rank.** That is not cosmetic. A
listing for a token on the registry's own chain HAS that token's address as its
id, below 2^160; every other chain's rows, the native asset and reservations are
hashes with bit 255 set. So:

- off mainnet the address-shaped ids are certain misses and are dropped before
  they cost a read - a Base row is never outranked out of the window by a
  mainnet one;
- on mainnet the address-shaped ids go in first, so a Base or Robinhood row can
  never displace a mainnet listing either.

Ranked order is restored afterwards, because that order is what the dropdown
shows. Without this the L2 dropdowns empty out **silently** the moment mainnet
passes 64 listings: the conviction lens orders by zOrg support and nobody stakes
zOrg on a Base listing, so every foreign row sinks below every mainnet row that
has any support at all. The page would say "registry returned nothing swappable"
and fall back to the list baked into its bytecode. `test/ui/l2-listing.test.mjs`
holds both directions of that.

The practical consequence for the curator: **`rank` orders the dropdown, it does
not decide who gets read.** Rank freely.

## How a foreign listing works

A token that lives on another chain has no on-chain source the registry can
read, so the owner types its name, symbol and decimals with `listForeign`. Two
things follow from that:

- `listForeign` leaves `standard` as UNKNOWN. The page drops any row that is not
  `ERC-20`, `ERC-721` or `Native`, so a listing MUST be followed by
  `setStandard(id, ERC20)` in the same transaction, or it never appears.
- Decimals are an owner-attested claim. The page re-reads `decimals()` from the
  token on the chain it is on and drops a row that disagrees (and says so in the
  list note), so a typo cannot mis-scale amounts. The generator below reads the
  real values from the chain and refuses to guess.

The listing id is `keccak256(abi.encode(Kind.EVM, chainId, bytes32(token))) | 1<<255`,
a hash of the asset rather than a counter, so delisting and re-listing yields
the same id.

## `origin`, and what the curator is actually asserting

`origin` is a reserved extension key (`bytes32("origin")`, an ASCII word, not a
hash). The page finds it in the row's `e` array and appends `"<value> origin"` to
the description shown under the symbol in the dropdown, truncated at 24
characters. That is its whole mechanical effect - it labels a row, it does not
route one.

Two things it is NOT, and both matter:

- **It is not what puts a token in a chain's dropdown.** That is the listing's
  `chainId`, fixed at `listForeign` and baked into the id. `origin` on a mainnet
  listing does not make it appear on Base.
- **It is not provenance.** `synced` is the provenance field, and it is `false`
  for every foreign listing, because nothing on mainnet can read Base. `origin`
  is owner-attested text. The card says OWNER ATTESTED for exactly this reason.

What it is for is telling a swapper what the thing in front of them is a
representation OF, which on an L2 is the common confusion: three tokens on Base
all called "BTC-ish", and nothing in a symbol distinguishes them. The convention:

| value | use for |
|---|---|
| `bitcoin` | an EVM representation of BTC - cbBTC, tBTC, WBTC |
| `ethereum` | a bridged mainnet asset with no `eq` twin listed |
| `solana`, `tron`, … | an EVM representation of another chain's native asset |
| `base`, `robinhood` | native to that L2, issued there, not bridged from anywhere |
| `tacit:<asset_id>` | a Tacit asset, the form already used for TAC |
| `eip155:<chain>:<address>` | the exact foreign contract this one represents |

Prefer the qualified `<namespace>:<ref>` form whenever there IS a single canonical
source contract, because a consumer can verify it; the bare words are for assets
whose origin is a chain rather than a contract. Keep it under 24 characters or
the dropdown truncates it. And use `eq` - which `--like` writes automatically -
whenever the asset is the SAME asset as a listing already on mainnet: `eq` says
"identical", `origin` says "derived from".

## Generating the transaction

```
node script/build-foreign-listing.mjs --chain 8453 \
  --token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --like 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --token 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf --color f7931a --rank 996000 --extra origin=bitcoin \
  --out deploy/BASE-list
```

Per `--token`, in order: `listForeign` → `setStandard(ERC20)` → `setArt` (url,
description) → `setLogoSVG` → `setExtra` per note, all inside one
`multicall(bytes[])` so a listing is never visible half-built. The batch is
simulated from the owner before anything is written.

- `--like <mainnet token>` copies the mainnet listing's logo, colour and rank and
  records the equivalence as extra `eq = eip155:1:<address>`. Use it for every
  asset that is the same thing on both chains (USDC, USDT, WETH, wstETH, rETH,
  DAI …): the L2 list then reads like the mainnet one, art included.
- `--logo file.svg` for an asset with no mainnet twin. The registry stores the
  markup as a data URL (≤ 24,576 B, must carry the svg namespace).
- `--extra origin=bitcoin` (or any `key=value`) is surfaced by the page as
  "bitcoin origin" in the row's description, so a bridged or wrapped asset is
  never mistaken for the native one. That is how TAC's Bitcoin provenance is
  meant to travel to an EVM representation of it. The key is a `bytes32`: pass a
  word (≤ 32 printable ASCII bytes) for the readable keys, or a `0x`-prefixed
  32-byte hash for the keys that ARE hashes - `zfi.v4pool` is one, and passing it
  as a word writes a key the page never looks for. Values are capped at 256
  characters and `setExtra` **truncates** past that rather than reverting, so the
  generator refuses an over-long one.
- `--v4pool v1:other:fee:tickSpacing:hooks` publishes a Uniswap v4 pool key on
  the listing - see the last section.
- `--rank` defaults to the mainnet twin's rank, else 900000. Higher ranks list
  first. The mainnet convention is 1,000 steps: ETH 1,000,000, WETH 999,000,
  wstETH 998,000 … FOLD 987,000.

Two batches are already generated and verified:

| file | chain | lists |
|---|---|---|
| `deploy/BASE-list.calldata.txt` | 8453 | USDC, USDT, WETH, wstETH, rETH, DAI (with mainnet art), cbBTC (`origin=bitcoin`), cbETH, AERO |
| `deploy/ROBINHOOD-list.calldata.txt` | 4663 | WETH (with mainnet art), USDG, NVDA, DEEP, MARIAN |

Verify a batch before sending it - it replays the exact calldata against a
mainnet fork as the owner and reads every listing back:

```
FOREIGN_LISTING=deploy/BASE-list.calldata.txt forge test --match-path test/ForeignListingTx.t.sol -vv
```

## Sending it from the multisig

In the Safe at `0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2` (the registry owner),
"New transaction → Transaction builder" (or any raw-calldata path):

| field | value |
|---|---|
| to | `0x0000006013dF75A31678B786061C2B54bf531524` |
| value | `0` |
| data | the contents of the `.calldata.txt` file, one line, `0x…` |
| operation | CALL (not delegatecall) |

The `.md` beside each calldata file carries the same table plus the listing ids.
Gas is roughly 1M per listing with a logo, 0.3M without; simulate in the Safe and
budget 30% over.

## Iterating

All of these are single owner calls on the same registry, and all take the id
the generator printed:

| want | call |
|---|---|
| reorder | `setRank(id, rank)` |
| new art, link or blurb | `setArt(id, color, rank, "", url, description)` then `setLogoSVG(id, svg)` |
| add or change a note | `setExtra(id, bytes32("origin"), "bitcoin")` |
| remove from the list | `delist(id)` (re-listing later gets the same id) |

zSwap reads the registry on every load, so a change shows on the next page
load with no deployment. The built-in fallback lists in the page (Base: ETH,
WETH, wstETH, rETH, cbETH, cbBTC, USDC, USDT, DAI, AERO; Robinhood: ETH, WETH,
USDG, NVDA, DEEP, MARIAN) exist only for the day the registry is unreachable or
lists nothing for the chain, and carry the mainnet SVG art for the assets that
are the same thing.

## The admin page

`dapp/tokenlist-admin.html` is the same job with a UI: open it, **Load listings**
to see what the registry holds (filterable by chain, in ranked order), queue owner
calls, and it emits ONE `multicall(bytes[])` to paste into the Safe. It does not
send — the owner is a Safe behind a timelock, so there is nothing for a browser
wallet to sign — but it does **simulate the whole batch as the owner** before it
tells you the calldata is good, which is the check a hand-built call has nothing
else standing between it and a signature.

Three things it does for you that are easy to forget by hand:

- **It reads name, symbol and decimals from the token on its own chain.** Foreign
  text is owner-attested and nothing on mainnet can check it, so the page refuses
  to let you type it; the swap page then re-checks decimals against the token
  again and drops a row that disagrees.
- **It appends `setStandard(ERC20)` to every `listForeign` automatically.**
  `listForeign` leaves `standard` as UNKNOWN and the page drops any row that is
  not ERC-20/ERC-721/Native, so a listing without it never appears at all.
- **It knows `v4pool` is a hash.** Type `v4pool` as the extra key and it writes
  `keccak256("zfi.v4pool")`; written as a word the extra stores fine, renders
  fine and is never read.

Every encoder on that page is compared against ethers, call for call, in
`test/ui/tokenlist-admin.test.mjs` — including the shapes most likely to be got
wrong: several dynamic tails in one call, empty strings, and strings that do and
do not land on a word boundary. There is no compiler between that page and the
chain, so an offset one word out would produce a well-formed transaction that
writes something other than what you typed.

Solver lanes have their own page at `dapp/admin/`.

## Hand-rolling a single owner call

The generator is for listings. A one-field correction is one call, and the
multisig can build it directly. Every one takes the listing id, which is a hash
of the asset - derive it without asking anything:

```
TOKEN=0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf   # cbBTC on Base
CHAIN=8453
H=$(cast keccak $(cast abi-encode "f(uint8,uint64,bytes32)" 0 $CHAIN $(cast to-uint256 $TOKEN)))
ID=$(python3 -c "print('0x%064x' % (int('$H',16) | (1<<255)))")
cast call 0x0000006013dF75A31678B786061C2B54bf531524 "isListed(uint256)(bool)" $ID --rpc-url $ETH_RPC_URL
```

`Kind.EVM` is `0`; the `1<<255` is the foreign flag, and it is what tells the page
this row belongs to a chain other than the registry's own. Then:

| want | calldata |
|---|---|
| flag an origin | `cast calldata "setExtra(uint256,bytes32,string)" $ID $(cast format-bytes32-string origin) "bitcoin"` |
| clear one | the same call with `""` - an empty value deletes the key |
| reorder | `cast calldata "setRank(uint256,uint32)" $ID 996000` |
| art, link, blurb | `cast calldata "setArt(uint256,uint24,uint32,string,string,string)" $ID 0xf7931a 996000 "" "https://…" "…"` |
| logo | `cast calldata "setLogoSVG(uint256,string)" $ID "<svg xmlns=…>"` |
| correct typed text | `cast calldata "setForeignText(uint256,string,string,uint8)" $ID "Name" "SYM" 8` |
| remove | `cast calldata "delist(uint256)" $ID` |

Send more than one as `multicall(bytes[])` against the registry so the listing is
never visible half-changed. **Always `cast call` it from the owner first** - the
generator does this automatically and a hand-built call has nothing else standing
between a typo and a signature:

```
cast call 0x0000006013dF75A31678B786061C2B54bf531524 $DATA \
  --from 0x006CD14F36F65eCbB29b2519cCBe63A0DC8549F2 --rpc-url $ETH_RPC_URL
```

Three limits worth knowing before signing, because all three fail QUIETLY:

- `setExtra` **truncates** a value past 256 characters instead of reverting.
- A listing holds at most 32 extension keys; the 33rd reverts (`delist` walks
  them all, so an unbounded set would make a listing unremovable).
- `_clean` drops `"` `'` `\` `<` `>` `&` and anything outside printable ASCII
  from every string the owner writes. What you signed is not always what is
  stored; read it back with `json(id)`.

## v4 hook data on an L2

A Uniswap v4 pool priced by a HOOK cannot be found or quoted by the page's own
math: a hook can replace the curve with a `BeforeSwapDelta`, take an `afterSwap`
delta out of the output, or set the fee per swap, and none of that is in `slot0`
and `liquidity`. So the pool key travels in the token list, exactly as it does
for FWA on mainnet - `setExtra(id, keccak256("zfi.v4pool"), "v1:other:fee:tickSpacing:hooks")` -
and the page prices it by RUNNING the hook through a `V4QuoteLens`.

Two pieces have to be in place per chain, and both now are, on all three:

| chain | V4Port (execution) | V4QuoteLens (pricing) | Uniswap V4Quoter it runs |
|---|---|---|---|
| 1 | `0x000000dfb53Fa7f1c486470034741d5BCBE14BE9` | `0x00000000Dc6f467A7AA88e216a904Cf758453EbC` | `0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203` |
| 8453 | `0x508ad1b0ae31FaF295c5af8C5c2bE9e33E0D19C4` | `0x00000000Dc6f467A7AA88e216a904Cf758453EbC` | `0x0d5e0F971ED27FBfF6c2837bf31316121532048D` |
| 4663 | `0x508ad1b0ae31FaF295c5af8C5c2bE9e33E0D19C4` | `0x00000000Dc6f467A7AA88e216a904Cf758453EbC` | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |

One address on every chain, three different builds behind it - each binding its
own chain's Uniswap V4Quoter as an immutable. That is CreateX CREATE3, which
derives the address from `(deployer, salt)` and never from the initcode. Full
record in [`V4QuoteLensL2.md`](./V4QuoteLensL2.md).

`V4QuoteLensL2` (`src/V4QuoteLensL2.sol`) is `V4QuoteLens` with the quoter bound
at deployment instead of as a constant, because the mainnet one's source is
pinned by a CREATE2 manifest against live bytecode and cannot take an argument.
Its constructor requires the quoter to have code AND its `poolManager()` to be
the singleton it was told to expect - a call to a codeless address SUCCEEDS with
empty returndata, so a wrong-chain quoter would otherwise answer (0, 0) for every
pool forever and "no route" would be indistinguishable from "wrong chain".

### Which pools actually need publishing

`node script/check-v4-coverage.mjs` answers that from the chain rather than from
memory. It does two things per chain: it asks our deployed quoter and Uniswap's
V4Quoter the same question at the SAME BLOCK and asserts they agree (they do, on
all three - the tick math is sound), and then it probes `(fee, tickSpacing)`
pairs the four-tier sweep never asks for and prints the live pools it finds, in
the exact `v1:other:fee:spacing:hooks` form `--v4pool` takes.

The sweep asks for `{1, 5, 30, 100} bps` at spacings `{1, 10, 60, 200}` with no
hook, on EVERY chain including mainnet. Anything else - another spacing, a
dynamic-fee pool, any hook - is invisible to it and always was; the space is
unbounded and cannot be swept. Those are the pools the curator publishes. As of
2026-09-06 the probe finds one across all three chains:

| chain | pool | value |
|---|---|---|
| 8453 | ETH/USDC, fee 3000, spacing 10 | `v1:0:3000:10:0` |

### Publishing a pool

```
node script/build-foreign-listing.mjs --chain 8453 \
  --token 0x… --like 0x… --v4pool "v1:0:0:60:0x2C67…6444"
```

The value is `v1 : other : fee : tickSpacing : hooks`, `;`-separated for up to 8
pools. `other` is the currency paired against the LISTED token (`0` for native
ETH) and the listed token is not repeated - it is already on its own listing; the
page sorts the pair to recover currency0/currency1. `hooks` is `0` for an
unhooked pool. 51 characters for a pool key instead of 141, which is what lets
four fit inside the 256-character cap.

The generator parses the spec **exactly** the way `parseV4Pools` does and refuses
anything the page would drop, because the page has no way to report a malformed
one: it skips what it cannot parse and routes through what is left. It also
checks on the L2 that the hook and the paired currency have code, and refuses the
whole extra on a chain with no lens.

To add a pool to a listing that already exists, it is one call:

```
cast calldata "setExtra(uint256,bytes32,string)" $ID \
  0x95a932c205571d4d1ca72715c642a2eca21dde79ffc28ff11509681f9383385f \
  "v1:0:500:10:0"
```

Note the key is passed as a HASH. `zfi.v4pool` is `keccak256("zfi.v4pool")`, not
`bytes32("zfi.v4pool")`: the renderer prints an all-printable-ASCII key as a word
and anything else as hex, and the page matches the hex. Writing it as a word
stores a key nothing reads, and the pool is silently invisible.
