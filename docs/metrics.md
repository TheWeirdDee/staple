# Frozen campaign metrics (v1)

Frozen on 2026-10-17, before any mandate-on campaign block was run. Any later change creates a v2 definition
and both are published. Computed by `sampler/metrics.py` from the independent sampler files and public Elysium
events only. Keeper logs are never used to reconstruct independent data.

## Market and sampling

| Item | Value |
| --- | --- |
| Network | Hyperliquid testnet (HyperCore) |
| Market | `PURR/USDC` spot (spot index 0, order asset 10000, size decimals 0) |
| Source | Public websocket `l2Book` and `trades` subscriptions, `wss://api.hyperliquid-testnet.xyz/ws` |
| Sampling interval | 1 second (wall-clock, UTC) |
| Depth captured | Top 10 levels per side |

## Primary metric: time at target

A sampled second is **valid** when the sampler connection is demonstrably alive (any message, including pong,
in the previous 45 seconds) and a book snapshot exists. Invalid seconds are excluded from the denominator and
reported separately as missing data with their reasons.

For each valid second, with `mid = (best bid + best ask) / 2`:

- `spread_bps = (best ask − best bid) / mid × 10,000`
- `bid_depth` = total displayed size on bids priced at or above `mid × (1 − 40 bps)`
- `ask_depth` = total displayed size on asks priced at or below `mid × (1 + 40 bps)`
- the second is **at target** when `spread_bps ≤ 40` **and** `bid_depth ≥ 3 PURR` **and** `ask_depth ≥ 3 PURR`

**Time at target** = at-target seconds ÷ valid seconds, reported per arm. All displayed liquidity counts,
including Staple's own orders. The point is to measure the book a trader actually sees.

## Arms

- **Mandate on**: the on-chain mandate state is `ACTIVE`, from `StateChanged` events on the desk contract.
- **Mandate off**: the mandate state is `PAUSED`.
- Seconds in transitional states (`PAUSING`, `TRIPPED`, `RECONCILIATION_REQUIRED`, …) are reported but
  excluded from both arms.
- Blocks are equal length and interleaved, with the on/off order rotated. Block length and order are recorded
  in the run manifest.

## Secondary metrics

| Metric | Source |
| --- | --- |
| Inventory, gross and net PnL, exchange and service fees | Desk `FillApplied`/`Decision` events and `getAccounting` |
| Loss-trigger observations and overshoot | `LossTriggered`, accounting `peakLossE8 − lossTriggerQuoteE8` |
| Cancel request → confirmed removal | `CancelIntent` block time → exchange `statusTimestamp` (keeper log) and sampler disappearance (independent) |
| Accepted → sampled resting | Keeper ack time → first sampler second showing the price level with Staple's size |
| Order-to-intent coverage | Watcher check log: matched ÷ all exchange orders and fills on the account, including unknowns |
| Mismatch count, unknown outcomes | Watcher findings; desk `OutcomeApplied` with `SUBMISSION_UNKNOWN` |
| Reference age | `Decision.refAgeMs` |
| Service uptime | Keeper/watcher health checks and gaps between `Decision` events |
| Controlled taker activity | Taker log (labelled); trades matching the taker account are reported separately from other trades |

Latency results are given as p50/p95/max with sample counts. The clock sources are the host system clock (NTP),
Elysium block timestamps (1 s resolution) and HyperCore timestamps. Results carry ±1 s uncertainty wherever a
block timestamp is involved.

## Interpretation

The hypothesis is that mandate-on improves time at target relative to mandate-off under the sampled testnet
conditions. A 50-percentage-point improvement is an experimental target, not a promise. Smaller or negative
results are published as measured. Testnet results do not establish mainnet profitability, customer demand or
production reliability.
