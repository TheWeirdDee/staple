# Units, rounding and bounds

Every on-chain amount is an integer. The TypeScript reference (`reference/src/quote.ts`) and the Solidity engine
(`contracts/src/QuoteEngine.sol`) use the same conventions, and both are checked against
`reference/vectors/quote-vectors.json`.

| Name | Meaning | Example (PURR/USDC) |
| --- | --- | --- |
| `pxE8` | Quote per one whole base token × 10⁸ | 4.5477 USDC → `454770000` |
| `lots` | Order size in units of 10^−szDecimals base tokens (HyperCore lot) | szDecimals 0 → 1 lot = 1 PURR |
| `baseE8` | Base token amount × 10⁸ | 30 PURR → `3000000000` |
| `quoteE8` | Quote (USDC) amount × 10⁸ | 10 USDC → `1000000000` |
| `bps` | 1/10,000 | 38 bps = 0.38 % |
| fee token | tFEE, 6 decimals (test asset, no value) | 20 tFEE → `20000000` |

## Conversions

- `baseE8 = lots × 10^(8 − szDecimals)`
- Notional for reservations and limits rounds **up**: `ceil(pxE8 × baseE8 / 10⁸)`
- Credited proceeds and the minimum-notional check round **down**: `floor(pxE8 × baseE8 / 10⁸)`
- Exchange decimals are parsed exactly. Fees with more than 8 decimals round **up**, which is conservative.

## Price validity (HyperCore spot)

Prices may have at most 5 significant figures and at most `8 − szDecimals` decimals. Integer prices are always
valid. The allowed decimals are `min(8 − szDecimals, 13 − digits(pxE8))`, and the tick is `10^(8 − decimals)`.

- Bid prices round **down** to the tick; ask prices round **up**. A level is never moved inward.
- Rounding widens the spread slightly. With a 40 bps target, quotes around 4.55 can land at 40.2 bps. The campaign
  policy therefore uses a 38 bps spread so the rounded quotes meet the frozen 40 bps metric.

## Ladder

`reservation = mid × (10,000 − skewBps) / 10,000`, where
`skewBps = clamp((inventory − baseline) × 10,000 / ((max − min) / 2), ±10,000) × policy.skewBps / 10,000`,
truncated toward zero. Level *i* (0-based) uses the offset `spreadBps + 2·i·levelSpacingBps`, measured in half
basis points, so odd spreads stay exact. The bid is `reservation × (20,000 − off) / 20,000` and the ask is
`reservation × (20,000 + off) / 20,000`, rounded up before tick rounding.

## Bounds

| Bound | Value |
| --- | --- |
| Levels per side | 1–5 (`MAX_LEVELS`) |
| Potentially executable orders per mandate | 24 (`MAX_LIVE_ORDERS`), including orders awaiting cancellation |
| Spread | 1–5000 bps; the outermost level must stay above zero |
| Requote threshold | < spread |
| Max reference age | 1–600 s |
| Balance reconciliation tolerance | 10 units of 10⁻⁸ |
| Outcome batch size (keeper) | 16 outcomes per transaction |

Every loop in a tick is bounded by these constants.
