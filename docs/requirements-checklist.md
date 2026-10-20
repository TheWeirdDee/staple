# Requirements → evidence checklist (PRD v1.1)

Status values: **testnet-verified**, **offline-tested** (real contracts on a local node, plus the exchange test
double where needed), **implemented** (built, not yet exercised end to end), **pending** (blocked by the named
dependency), **deferred** (out of first-release scope per the PRD). Last updated with each evidence publication.

## Release gates

| Gate | Status | Evidence | Remaining |
| --- | --- | --- | --- |
| G1 live place/cancel/outcome loop, independently observed | pending | `runs/g1/` once run | HyperCore testnet USDC for the owner account (contracts are deployed) |
| G2 reservation, precision, access-control, idempotency tests | met (offline) | `runs/offline-tests.json`: 96 passed, 0 failed | — |
| G3 stale shutdown without ticks; late fills and cancel failures reconcile | partial | Offline: `test_staleShutdownWithoutAnyNewTick`, keeper outage, delayed/rejected cancel tests. Elysium testnet: watcher poke halted a stale test mandate with no new tick (`runs/elysium-cases/`) | Late fills and cancel failures on testnet need resting orders (funding) |
| G4 pause/revoke UI separates requested from confirmed | offline-tested | `web/src/pages/Manage.tsx`, `runs/e2e-local.json` (browser, local node) | Exercise against the testnet deployment once the mandate can be activated |
| G5 public evidence with failures, unknowns, duration, limits | partial | `/proof`, `web/public/evidence/index.json` | Campaign results |
| G6 submission facts align with what is deployed and demonstrated | partial | `submission-facts.json` (deployment and hosted services recorded) | Final re-audit after the live loop and campaign |

## PRD sections

| § | Requirement | Location | Status | Verification |
| --- | --- | --- | --- | --- |
| 0, 3 | One existing HyperCore testnet spot market | PURR/USDC, `runs/market-purr-usdc-testnet.json` | implemented | `spotMetaAndAssetCtxs` |
| 3 | Dedicated owner account | `0x7C7e…6550` (demo owner) | pending | Elysium gas funded; HyperCore testnet USDC pending |
| 4 | Mandate schema: identity, market, quotes, exposure, risk, lifecycle, fees | `contracts/src/StapleTypes.sol`, `MandateRegistry.sol` | offline-tested | forge |
| 4 | Exact units, rounding, bounds | `docs/units.md`, frozen vectors | offline-tested | vectors replayed in TS and Solidity |
| 4 | Versioned edits with diff; ≥ 60 s notice for risk-increasing edits; switch only after old orders are terminal | `proposePolicy`, `_maybeSwitchVersion`, web diff | offline-tested | `test_riskIncreasingEditWaitsNoticeAndOldOrdersFirst` |
| 4 | Pause and risk-reducing edits immediate at the policy layer | `pause`, notice 0 s | offline-tested | forge |
| 4 | Never auto-resume into an unresolved state | halts clear only on a fresh reconciled observation with no live orders; TRIPPED/RECON need re-arm | offline-tested | forge, keeper outage test |
| 4, 9 | Signing material never in mandate, bundle, logs or evidence | keystore, redactor, web has no keys | implemented | `signing.test.ts` redaction; manual review |
| 5 | Tick sequence 1–9 (validation, freshness, deviation, reconciliation, triggers, skew, ladder, healthy-book rule, reserve-before-emit, reason codes) | `StapleDesk.tick`, `DeskOrders.quote` | offline-tested | forge |
| 5 | External book excluding Staple orders | `keeper.observe` | offline-tested | `excludes its own resting orders…`; the unknown-order exclusion fix |
| 5 | Worst-case reservations: no netting; cancels keep capacity; replacements counted twice; partial fills exactly once | `QuoteEngine.reservationFits`, `DeskOrders.totals` | offline-tested | vectors, fuzz, integration |
| 5 | Unique cloids from mandate, version and nonce; unknown placements queried, never blindly retried | `cloidFor`, keeper | offline-tested | forge, integration |
| 5 | Solidity and TS share frozen vectors, not copied code | `reference/`, `QuoteVectors.t.sol` | offline-tested | CI |
| 6 | Fills, fees, balances, inventory, realised/unrealised, service fees, equity vs activation snapshot | `DeskAccounting.sol`, public page | offline-tested | forge |
| 6 | Deposits and withdrawals cannot become profit; unknown activity pauses | balance reconciliation, epoch snapshots | offline-tested | `test_unrelatedAccountActivityRequiresReconciliation` |
| 6 | Gross and net PnL separate; marking source and age shown | `Mandate.tsx` PnL section | implemented | — |
| 6 | Fee asset verified before deposits; test asset labelled | `TestFeeToken` (tFEE), docs | implemented | `docs/dependencies.md` |
| 6 | `lossTriggerQuote` semantics; trigger/peak/overshoot reporting | `LossTriggered`, accounting fields | offline-tested | forge |
| 6 | Exit: cancel, reconcile, keep inventory; no automatic selling | lifecycle | offline-tested | — |
| 7 | All 10 mandate states and the order state machine | `StapleTypes.sol` | offline-tested | forge |
| 7 | Shutdown rules (stale, volatility, loss/mismatch, fees, expiry, keeper outage) | desk, watcher, keeper | offline-tested | cases table |
| 7 | Timer-driven stale cancellation; exchange-side scheduled cancel | `poke`, `renewScheduleCancel` | testnet-verified (Elysium side) / offline-tested (exchange side) | `runs/elysium-cases/`; outage test |
| 7 | Five-step owner exit, each step confirmed | `Manage.tsx`, `requestRevoke`/`reportAgentRevoked` | offline-tested (contract) | revocation via zero address to verify on testnet |
| 7 | Restart recovery before new intents; duplicate and out-of-order events; finality assumption | `Keeper.recover`, outcome idempotency | offline-tested | integration |
| 8 | Component architecture; dependency matrix | `docs/architecture.md`, `docs/dependencies.md` | implemented | — |
| 8 | Contracts deployed on Elysium testnet; services hosted | `runs/deployment-testnet.json`, `.github/workflows/services.yml` | testnet-verified | registry `0x5acc…e220`, desk `0xb040…fd3b`; watcher heartbeat tx `0xa17f9e4e…a795` from the hosted runner |
| 9 | Security table responses (watcher, fail-closed, encrypted keys, bounded work, no admin) | various | offline-tested / implemented; watcher fail-closed testnet-verified | `runs/elysium-cases/`: activation halted until the first heartbeat; watcher outage halted quoting after 45 s |
| 10 | Pricing and token plan without commitments | `docs/token-plan.md` | implemented | — |
| 11 | Landing, public mandate, owner console; simulation deferred | `web/` | implemented | screenshots; browser e2e on a local node; public pages checked in a browser against the testnet deployment |
| 12 | Frozen metric, ABBA method, independent sampler, labelled taker, published failures | `docs/metrics.md`, `sampler/`, `keeper/src/campaign.ts` | implemented | campaign pending funding |
| 13 | Latency distributions, reproducibility manifests, fresh-clone offline tests | keeper/watcher logs, `scripts/` | implemented | — |
| 14 | Wallet-free judge path; 100 s demo | `/`, `/mandate`, `/proof`; `docs/demo-script.md` | implemented | demo footage needs the live run |
| 16 | Six-section submission and claim ledger | `docs/submission.md`, `submission-facts.json` | implemented | — |
| 3 | Perps, second market, simulation, multi-market, SDK, Docker, verified tiers, token mechanics | — | deferred | — |
