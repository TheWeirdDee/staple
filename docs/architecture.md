# Architecture and trust boundaries

```
           Elysium testnet (99801)                          Hyperliquid testnet (HyperCore)
 ┌──────────────────────────────────────────┐        ┌──────────────────────────────────────┐
 │ MandateRegistry  owner, roles, versions,  │        │ Owner's spot account (capital)        │
 │                  60 s notice, tFEE fees   │        │  ▲ orders/cancels signed by the        │
 │ StapleDesk       lifecycle, reservations, │ intents│  │ owner-approved agent (trade-only)  │
 │  + DeskOrders    decisions, intents,      ├───────►│ Keeper ──────────────────────────────┤
 │  + QuoteEngine   signed observations,     │◄───────┤  │ fills, statuses, balances, book    │
 │  + DeskAccounting outcomes, accounting,   │outcomes│  │                                    │
 │                  watchdog poke            │        │ scheduleCancel (dead man's switch)    │
 └──────────▲─────────────────▲──────────────┘        └───────────▲──────────────▲───────────┘
            │ heartbeat, poke,│ mismatch                          │ reads        │ public WS
            │ revocation obs. │                                   │              │
        ┌───┴─────────────────┴───┐                        ┌──────┴─────┐  ┌─────┴──────┐
        │ Watcher (Python, own    │── guard agent cancel ──►│  account   │  │  Sampler   │
        │ keys, independent code) │                        └────────────┘  │ (Python)   │
        └─────────────────────────┘                                        └────────────┘
                     Web (static): reads Elysium RPC and HyperCore info API directly in the browser
```

## Components (PRD §8)

| Component | Implementation |
| --- | --- |
| MandateRegistry | `contracts/src/MandateRegistry.sol`: ownership, roles, versioned policies, notice period, prepaid fees |
| QuoteEngine | `contracts/src/QuoteEngine.sol` (linked library): ticks, ladder, health rule, reservation check |
| StapleDesk | `contracts/src/StapleDesk.sol`: lifecycle, risk state, decisions, watchdog |
| IntentGateway | `PlaceIntent` / `CancelIntent` events, intent version 1 (`contracts/src/DeskOrders.sol`) |
| BookSource | `StapleDesk.tick` with EIP-712 `Observation` (monotonic `seq` and `sourceTimeMs`) |
| OutcomeSink | `StapleDesk.reportOutcomes` with EIP-712 `OutcomeBatch`, idempotent by trade id |
| Accounting | `contracts/src/DeskAccounting.sol` (linked library) |
| Keeper | `keeper/` (TypeScript) |
| Independent watcher | `watcher/` (Python, separate implementation and keys) |
| Independent sampler | `sampler/` (Python, public websocket only) |
| Web | `web/` (React, static) |

The desk is split into linked libraries because Elysium enforces the standard 24,576-byte contract size limit.
This was verified with `eth_estimateGas` against the testnet RPC.

## Lifecycle

`DRAFT → ACTIVE ⇄ (halts: STALE, VOLATILITY, FEES, WATCHER, UNRECONCILED, VERSION_SWITCH)`

- `ACTIVE → PAUSING → PAUSED` once every order is confirmed terminal.
- `ACTIVE → TRIPPED` (loss) or `RECONCILIATION_REQUIRED` (missing outcome, unexplained balance, mismatch). The
  owner re-arms these to `PAUSED`; nothing resumes automatically.
- `* → REVOKING → REVOKED` once orders are terminal **and** agent removal has been observed.
- `ACTIVE → EXPIRING → EXPIRED` via the watchdog, even with no new ticks.

Order states: `INTENT_EMITTED → SUBMISSION_UNKNOWN | RESTING → PARTIALLY_FILLED → FILLED | CANCELLED | REJECTED`.
Transport success is never treated as a resting order or a completed cancel.

## Authority boundary

- The contract constrains **its intents** only. HyperCore agent permissions are account-wide: the keeper's agent
  key can place any order on the account. The watcher detects deviations afterwards (order with no intent, wrong
  price, side or size, overfill, open order whose intent is terminal), reports them on-chain (which stops new
  exposure) and tries to cancel through a separately approved guard agent. It cannot undo fills.
- Pausing on Elysium does not revoke the agent. Only the owner can revoke it on HyperCore, and revocation does
  not cancel resting orders.
- Observations and outcomes are signed by the keeper reporter. Signatures authenticate the sender, not the truth
  of the data. The watcher and the public web page re-read HyperCore independently.
- Sequencer timestamps on Elysium are trusted for all timeouts.
- Hosted mode runs the keeper, watcher and sampler on one GitHub Actions runner. Their independence is in code,
  keys and data sources, not in infrastructure.

## Recovery

The keeper persists only what it sent (a write-ahead record of submissions and cancels). Intents, reservations
and ingested fills live on-chain. Every placement carries an exchange `expiresAfter` (8 s), so an unknown outcome
becomes decidable by status query after expiry. On restart the keeper queries every live intent (including
ones with no write-ahead record), ingests unseen fills, and only then executes new intents. While any placement
is unresolved the contract emits no new placements.

## Native Elysium integration (future)

Per the official Elysium docs, the HyperCore market-data precompile and the ElysiumCoreWriter keeper lane arrive in
an ArbOS upgrade after mainnet. Neither is available on testnet today, so this release uses keeper-posted
observations. Adopting them later would remove the reporter trust for book data. It would not make agent
permissions mandate-scoped.
