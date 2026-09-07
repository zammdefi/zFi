# V4QuoteLensL2 — deployment record

Status: **LIVE ON ETHEREUM, BASE AND ROBINHOOD CHAIN, 2026-09-06, at one address.**

| | value |
| --- | --- |
| address | `0x00000000Dc6f467A7AA88e216a904Cf758453EbC` (all three chains) |
| factory | CreateX `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`, `deployCreate3(bytes32,bytes)` |
| salt | `0x68575b073de49a94e3e3acf6f3a0d6e3b66267c70051c7d8651cda8dccb3f8a3` |
| guarded salt | `0x46a9553e1ebd115acbe2472dbf389d20c7750767d9bfd9dcdb2c8d75c08ef0cb` |
| deployer | `0x68575B073DE49a94e3E3ACf6F3A0d6E3b66267C7` |
| runtime | 3,279 B (creation 3,745 B), ~819k gas per chain |
| manifest | `deploy/l2/manifest.json` → `create3.V4QuoteLensL2` (`chains: [1, 8453, 4663]`) |

| chain | tx | block | V4Quoter bound | PoolManager | verified |
|---|---|---|---|---|---|
| 1 | `0x6d635a2e…b25c182d` | 25,917,640 | `0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203` | `0x000000000004444c5dc75cB358380D2e3dE08A90` | Etherscan |
| 8453 | `0xedda7345…0ad0716e` | 50,950,187 | `0x0d5e0F971ED27FBfF6c2837bf31316121532048D` | `0x498581fF718922c3f8e6A244956aF099B2652b2b` | Basescan |
| 4663 | `0xaf732805…dc815125` | 55,898,590 | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | Sourcify (`exact_match`) |

## Why one address, and why CREATE3

The three builds are NOT the same bytecode — each binds its own chain's Uniswap
V4Quoter as an immutable. Under CREATE2 that is three different addresses, and
zSwap's chain table would carry three constants that have to be kept in step by
hand. CreateX CREATE3 derives the address from `(deployer, salt)` and never from
the initcode, so one salt puts all three at one address. The salt is
sender-prefixed, so nobody else can take that address on a chain we have not
reached; byte 20 is `0x00`, which keeps `block.chainid` out of the derivation —
`0x01` would ask CreateX for redeploy protection and give a different address per
chain, the opposite of the point.

The vanity search (four leading zero bytes, ~4.3 x 10^9 attempts expected) ran on
two 64-vCPU RunPod boxes via `script/mine-create3-fast.mjs`; the salt was checked
against `script/create3-derive.mjs` and against CreateX's own
`computeCreate3Address` before anything was sent.

## Why the contract exists

`V4QuoteLens` (mainnet, `0x000000c3aE1692983941495162A4AAB40660E65F`) binds
Uniswap's mainnet V4Quoter as a `constant`. The same bytecode elsewhere
staticcalls an address with no code — and a call to a codeless address
**succeeds** with empty returndata, so the `try` around it does not catch and the
lens answers `(0, 0)` for every pool. "No route" and "wrong chain" become
indistinguishable, silently, forever. Its source is pinned by a CREATE2 manifest
against live bytecode, so the quoter cannot be made a constructor argument there.

Hence a second contract, and hence the constructor check: it requires the quoter
to have code AND its `poolManager()` to be the singleton it was told to expect.

What the lens is FOR: zSwap reads a pool key from a token listing's `zfi.v4pool`
extra and prices it here. The local tick math in `zQuoterV4`, `zQuoterBase` and
`zQuoterRobinhood` reads pool STATE, which is exact for an ordinary pool and
structurally unable to price a hooked one — a hook may replace the curve with a
`BeforeSwapDelta`, take an `afterSwap` delta out of the output, or set the fee per
swap, and none of that is in `slot0` and `liquidity`. It is also the only way to
reach a pool at a `(fee, tickSpacing)` pair the four-tier sweep never asks for.

## Verification performed

- CreateX's `computeCreate3Address` was checked against the manifest address on
  each chain before sending (the deployer refuses to send otherwise).
- Runtime read back from all three chains is the local
  `forge build src/V4QuoteLensL2.sol` output byte-for-byte apart from 60 bytes,
  all inside the three immutable spans the compiler reports for `V4_QUOTER`
  (20 address bytes x 3).
- `V4_QUOTER()` returns that chain's quoter on each.
- A live pool quoted through each: ETH→USDC 0.05% on mainnet and Base, ETH→USDG
  0.05% on Robinhood, all ~24.99 USD for 0.01 ETH.
- `forge test --match-path test/V4QuoteLensL2.t.sol` — 18 tests, six per chain,
  including both constructor refusals and batch-vs-single agreement.

## Where it is wired

- `CHAINS[1|8453|4663].v4lens` and the `V4LENS` initial value in `zSwap.html`.
  While this is zero the page drops every pool a listing publishes.
- `V4LENS` in `script/build-foreign-listing.mjs`, which refuses to write a
  `zfi.v4pool` extra for a chain with no lens.

## Superseded

`0x00000004135c3EF16E8987e3c54090f943C2E3AA` on Base — the same source deployed
through SafeSummoner CREATE2 earlier the same day, before the decision to put all
three chains at one CREATE3 address. It still works and is still bound to Base's
quoter; nothing points at it. Its CREATE2 artifacts were removed from `deploy/`
so the CREATE3 manifest is the only build path for this contract.

## Not deployed: `src/V4QuoteLensPM.sol`

A lens that performs the `unlock`-swap-revert itself against the PoolManager,
needing no Uniswap periphery at all. Written when Robinhood's V4Quoter had not
been found, kept because it is the answer for any chain where Uniswap has not
deployed one. It is checked against Uniswap's own quoter on Base across sixteen
exact-in combinations and every live exact-out tier, and agrees exactly
(`test/V4QuoteLensPM.t.sol`). Deploy it only where `V4QuoteLensL2` has nothing to
bind.
