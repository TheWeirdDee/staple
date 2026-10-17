# Demo script (100 s) and shot list

Record only from the deployed testnet site and real testnet activity. Persistent on-screen caption: **"Testnet ·
recorded <UTC date/time> · controlled taker fills are labelled · no real funds"**.

| Time | Shot | Narration (≈ 2.5 words/s) |
| --- | --- | --- |
| 0–12 s | Landing hero, then the problem section | "Thin token books get a market maker, a private bot, or nothing. Either way, holders can't check the rules." |
| 12–25 s | `/mandate`: header with state, policy v1 terms, owner account link opened on the Hyperliquid testnet explorer | "Staple publishes the rules on Elysium. The capital stays in the team's own Hyperliquid account. Here's that account." |
| 25–50 s | Activation tx in the explorer → decision strip → orders table: contract intents next to "Exchange says: resting, oid …" | "When the mandate is active, the contract computes each order as a public intent. The keeper places it with a trade-only agent. Left side: what the contract intends. Right side: what Hyperliquid reports, fetched straight from the exchange." |
| 50–68 s | A **labelled controlled taker** fill → fills history → inventory and reservation cards update | "A labelled test taker lifts one quote. The fill is reconciled exactly once. Inventory moves, and the reserved capacity shrinks only by what actually filled." |
| 68–85 s | Owner console → Pause → badge shows "Pausing: n orders awaiting confirmed cancellation", then "Paused"; residual inventory notice | "Pause is a request until the exchange confirms every cancel. Then it says paused. The tokens stay with the owner, still exposed to price." |
| 85–100 s | `/proof`: gates table, campaign time-at-target on vs off with actual duration and missing data, trust boundary card | "Here are the measured results, including gaps and failures. The agent key can still trade outside the rules. The watcher catches that afterwards. Next: a design partner pilot." |

## Shot checklist (all from real runs)

1. G1 manifest rows: intent tx, exchange oid, sampler second showing the order, cancel confirmation.
2. A controlled taker fill: `taker.jsonl` entry and the matching `FillApplied` event.
3. Pause → PAUSED transition, with both transaction links.
4. Proof page after the campaign has run for at least the stated duration.

## Disclosures

- Testnet only, recorded footage, controlled taker labelled.
- No guarantee of loss limits. The loss trigger is not a cap.
- Zero customers or partners.

## Manual step

Screen recording with a voice-over needs a person at a desktop. The shot list above is complete; record it once
`/proof` shows the campaign.
