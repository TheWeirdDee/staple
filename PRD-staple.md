# Staple PRD

**Market making you can audit.**

Public quoting policies, owner-held trading capital and independently monitored execution on Hyperliquid, coordinated through Elysium.

Version 1.1 — 17 October 2026. Supersedes version 1.0 dated 14 October 2026.
Target: Ascend Builder Competition, Builder Grants track.
Status: revised implementation specification. This document does not establish that any feature is built, deployed, tested or production-ready. Working status must be supported by the evidence ledger in section 16.

## 0. Product summary and decision

Staple helps token teams provide liquidity on Hyperliquid from their own accounts, publish their quoting rules and independently verify how those rules were followed.

The capital owner defines a Mandate: market, spread, order sizes, inventory exposure, loss-triggered shutdown and expiry. Contracts on Elysium calculate intended quotes. A keeper executes them using a Hyperliquid agent authorised by the owner. An independent watcher reconciles actual orders and fills against the intent stream. A public page shows the terms, execution, inventory, fees, discrepancies and shutdowns.

The first release proves this loop on **one existing HyperCore testnet spot market**. If no suitable spot market is available, document a deliberate scope revision before substituting a perp; do not silently inherit spot risk assumptions.

### Product promise

- Trading capital remains in the owner's HyperCore account; owner-prepaid service fees are held separately on Elysium.
- Quoting policies and contract decisions are public.
- Actual execution is reconciled independently against those decisions.
- The owner can initiate cancellation and agent revocation, with each step confirmed separately.
- Risk controls reduce exposure and trigger shutdowns; they do not guarantee a maximum loss or instant cancellation.

### Trust boundary

The contract constrains the intents it produces. The keeper's trading key can potentially submit orders outside those intents. Monitoring detects deviations after they occur; pausing the Elysium mandate does not independently revoke that key on HyperCore. Self-hosting changes who controls the key but does not turn policy into exchange-enforced restrictions.

Pre-upgrade book summaries and outcome reports also depend on off-chain reporters. Signatures authenticate the reporter, not the truth of the data. Future native integrations must be evaluated against this same authority boundary before claims change.

### Primary customer

A token team with an existing thin HyperCore spot book and inventory it wants to quote transparently. HIP-3 deployers and Ascend-associated treasuries are later customer hypotheses, not confirmed partners.

## 1. Problem and differentiation

Teams that need two-sided liquidity may hire a market maker, run a private bot or leave a thin book unsupported. Holders and counterparties often cannot inspect the team's quoting policy or connect published promises to actual trading behaviour.

Staple's proposed difference is the combination of:

1. Public, versioned quoting policies.
2. Owner-held trading capital.
3. Contract-generated order intentions.
4. Independently reconciled execution and visible discrepancies.
5. An open-source keeper that an owner can operate.

Do not claim that market-making bots, non-custodial execution or transparency are individually new. Do not claim that no competitor exists without a dated comparison of relevant products. Published policies improve visibility; they do not prove beneficial intent or prevent an owner trading separately.

Version 1.0 included numerical claims about listing economics, market-making disclosure and token-loan arrangements. These are research leads, not submission-ready evidence. Omit the figures until exact sources, dates, definitions and limitations are recorded.

## 2. Users and validation

| User | Job | Evidence required |
| --- | --- | --- |
| Token team with a thin spot book | Quote its inventory under visible rules | Customer conversation; existing workflow; willingness to pilot and pay |
| Token holder or trader | Inspect policy and observed execution | Usability test finding terms, inventory and a discrepancy without help |
| HIP-3 deployer, later | Support a perp market with explicit risk controls | Separate perp requirements and pilot interest |
| Ascend treasury, potential | Evaluate transparent liquidity operations | Direct confirmation of interest; no implied endorsement |

Ask prospective customers about current tooling, market quality, capital budget, acceptable disclosure, key custody and purchase criteria. Record consent before naming anyone. Zero customers or partners is an acceptable status and must be stated honestly.

## 3. Scope and build order

### Required first release

- One named existing HyperCore testnet spot market.
- One dedicated owner account or isolated account supported by the chosen API flow, with no unrelated activity.
- Public, versioned mandate and conservative bounded ladder.
- Live Elysium intent → HyperCore order → reconciled outcome.
- Exposure reservations for all live and potentially live orders.
- Stale-data, volatility, reconciliation and loss-triggered shutdowns.
- Owner cancellation and revocation instructions with confirmed outcomes.
- Public mandate page, owner console and evidence page.
- Independent sampler and watcher; labelled controlled taker only where needed.
- Focused correctness, recovery and failure tests.

### Deferred unless first-release gates pass

Perps, a second market, 24-hour historical simulation, multi-market mandates, packaged SDK, Docker distribution, verified tiers and token-linked fee mechanics. Reusable internal modules are encouraged, but packaging does not take priority over the live loop.

### Build order

1. Prove one intent, one real testnet order, one confirmed cancel and one outcome report.
2. Implement mandate validation and quote calculations with reference vectors.
3. Add reservations, reconciliation and restart recovery.
4. Add autonomous shutdown scheduling and independent emergency cancellation.
5. Implement the public page and owner controls.
6. Execute the proof campaign and publish raw evidence.
7. Produce the submission and 60–120 second demo.

Proceed through these steps autonomously; pause only for genuinely required manual actions or unresolved external dependencies. A completed document is not evidence of a completed component.

## 4. Mandate definition

The implementation schema must define exact integer units, rounding and bounds before deployment. At minimum, a mandate contains:

| Group | Required fields |
| --- | --- |
| Identity | owner, authorised operator, HyperCore account, chain/domain, mandate ID and version |
| Market | asset ID, spot/perp type, base/quote decimals, size and price precision, minimum order notional |
| Quotes | full target spread in bps, bounded levels per side, level spacing, size per level, inventory skew and requote threshold |
| Exposure | baseline inventory, min/max base inventory, reserved buys/sells, available quote budget and maximum outstanding notional |
| Risk | loss-trigger threshold in quote units, volatility threshold/window, maximum reference age, reconciliation timeout, cancellation timeout |
| Lifecycle | expiry, state, policy activation time, active version and resume policy |
| Fees | fee rate, prepaid fee balance and spending cap |

Public edits create a new version and show a diff. Risk-increasing edits have at least a 60-second notice period. Pause and risk-reducing shutdowns act immediately at the policy layer, subject to execution latency. Policy replacement must cancel/reconcile old orders before releasing reservations or enabling new exposure. Never resume automatically into an unresolved account state.

Sensitive signing material is never stored in the mandate, browser bundle, logs or public evidence.

## 5. Quote engine and exposure reservations

### Tick sequence

1. Validate mandate state, version, expiry and tick cadence.
2. Validate market metadata, reference timestamp, monotonic source height and permitted deviation from an independent observation.
3. Require fresh, reconciled balances, fills and outstanding-order state.
4. Evaluate stale-data, volatility, fee, loss and mismatch triggers.
5. Calculate reservation price from reference mid and inventory skew.
6. Generate a bounded ladder, round to valid ticks/lots, enforce minimum notional and post-only behaviour.
7. Apply the configured healthy-book rule: stay out or join without improving when existing external liquidity meets the policy. Specify one behaviour per mandate.
8. Reserve exposure before emitting place intents. Emit cancels for undesired orders and retain their reservations until terminal confirmation.
9. Emit decision inputs, policy version and a reason code for public explanation.

Use an external-book estimate that excludes known Staple orders where possible. If the feed cannot reliably separate them, disclose that limitation and disable claims that require exact exclusion.

### Reservation invariants

For a spot mandate, use conservative worst-case exposure, without assuming opposing orders will fill:

- Current base inventory + all remaining potentially executable buys ≤ maximum inventory.
- Current base inventory − all remaining potentially executable sells ≥ minimum inventory.
- Buy reservations include quote cost and a conservative fee allowance.
- Sell reservations cannot exceed available base balance.

Count placed, acknowledged, resting, partially filled and outcome-unknown orders. A cancel request does not release capacity. On replacement, count both old and new orders until the old orders are confirmed terminal. Partial fills move quantity from reserved to executed exposure exactly once.

The inventory cap is a policy invariant under reconciled inputs and compliant execution. It is not an exchange-enforced account restriction against a compromised key or unrelated account activity.

Use unique client order IDs derived from mandate, version and intent nonce. Retrying an unknown placement first queries its actual status; it must not blindly duplicate exposure.

The Solidity quote library and independent TypeScript reference share frozen test vectors, not a single copied implementation. Cover precision, rounding, skew, bounded loops, insufficient balances and boundary orders.

## 6. Accounting, loss triggers and position exit

Track actual fills, fees, balances, inventory, realised PnL, unrealised PnL, service fees and total equity relative to an activation snapshot. Define treatment of deposits, withdrawals and transfers so they cannot masquerade as trading profit. Unknown external account activity pauses the mandate for reconciliation.

Publish gross trading PnL and net PnL after exchange and Staple fees separately. Identify the marking source and its age. Fee accrual is provisional until reconciled; duplicate reports cannot double-charge. No invented cross-chain USDC availability: verify the supported fee asset, address and funding path before enabling deposits. A testnet fee demonstration must use clearly identified test assets.

### Loss threshold semantics

Use `lossTriggerQuote`, replacing the misleading interpretation of `maxLossQuote` as a hard cap. When measured loss reaches the threshold, stop new quoting and request cancellation. Loss may exceed the threshold before detection, while cancelling, through price gaps or after cancellation while inventory remains exposed.

Report trigger time, measured loss at trigger, cancel request time, confirmed cancellation time, peak observed loss and overshoot. No guarantee of bounded capital loss is permitted.

### Exit policy

First-release spot policy: cancel orders, reconcile the account and retain remaining inventory for the owner to manage. Show residual holdings and price exposure prominently. Do not automatically market-sell inventory unless a separate explicit owner-approved execution policy exists.

A future perp release additionally requires funding accounting, leverage/margin constraints, liquidation risk, reduce-only semantics and a defined close-position policy. A successful spot campaign does not validate those risks.

## 7. Lifecycle, shutdown and recovery

Mandate states: DRAFT, ACTIVE, PAUSING, PAUSED, TRIPPED, REVOKING, REVOKED, EXPIRING, EXPIRED and RECONCILIATION_REQUIRED.

PAUSING/REVOKING/EXPIRING mean cancellation or revocation remains unconfirmed. Terminal labels must reflect confirmed external state. TRIPPED prevents new quoting but may still have pending cancellations; show this explicitly.

Order states: INTENT_EMITTED → SUBMISSION_UNKNOWN or ACKNOWLEDGED → RESTING/PARTIALLY_FILLED → FILLED/CANCELLED/REJECTED. Transport success is not proof that an order rests or a cancel completed.

### Shutdown rules

- Stale data or missing outcomes: stop new placements, issue cancellations and reconcile.
- Volatility trigger: pull quotes; resume only after a configured calm interval, fresh reference and confirmed account state.
- Loss trigger or execution mismatch: manual re-arm after reconciliation.
- Empty fee balance: stop new placements; cancellation remains available without prepaid service fees.
- Expiry: an independently scheduled task requests cancellation even without new ticks.
- Keeper outage: independent emergency worker attempts cancellation using a separately approved capability where supported and tested; otherwise alert the owner and provide direct exchange steps. Do not describe an unimplemented emergency path as protection.

A timer or watchdog must actively initiate stale-data cancellation. Merely checking age inside a tick is insufficient when ticks stop. Where supported, test exchange-side scheduled cancellation as an additional safeguard; document its limits and renewal requirements.

### Owner exit

“Cancel all and revoke” is a multi-step flow:

1. Stop the strategy and request cancellation.
2. Query actual open orders and reconcile fills; retry or surface unresolved orders.
3. Have the owner revoke the agent through the supported owner-authorised action.
4. Confirm authority removal and query remaining orders again.
5. Show residual inventory and any continuing exposure.

If a compromised agent appears active, prioritise owner revocation and then owner-authorised cancellation; the ordinary sequence assumes a cooperative keeper. Never imply revocation itself cancels resting orders. If any step fails, keep the exit visibly incomplete.

### Restart recovery

Persist the last processed source cursor, intent nonces, fills and reservations. On restart, query live balances/orders/fills before emitting new intents. Handle duplicate and out-of-order events, reconnect gaps and chain reorganisation/finality assumptions. An unresolved gap blocks new exposure.

## 8. Architecture and Elysium dependency

| Component | Responsibility |
| --- | --- |
| MandateRegistry | Ownership, policy versions, lifecycle and fee balances |
| QuoteEngine | Bounded deterministic quote calculations and reservation checks |
| StapleDesk | Decisions, risk state, accounting and intent generation |
| IntentGateway | Versioned intent interface and execution acknowledgements |
| BookSource | Authenticated observations with replay protection and freshness checks |
| OutcomeSink | Idempotent outcome ingestion and reconciliation checkpoints |
| Keeper | Execute authorised intents, report outcomes, recover safely |
| Independent watcher | Compare exchange state with expected intents; request shutdown and alert |
| Independent sampler | Record public market conditions for campaign metrics |
| Web | Public mandate, owner controls and evidence |

### Current implementation path

Keeper-posted observations → contract-generated intents on Elysium → agent-signed orders on HyperCore → reported and independently reconciled outcomes.

### Future integration path

Adopt a native market-data precompile and keeper/write integration only after availability, interfaces, permissions and failure reporting are verified on the target network. An upgrade does not automatically make agent permissions mandate-scoped or reports trustworthy.

Elysium is the intended policy and coordination layer. The initial implementation still depends on off-chain reporting and execution. Its comparative benefit must be measured; do not claim the same service is impossible on another chain or as an off-chain bot.

Remove unverified launch dates and promised upgrade intervals from product commitments. Maintain a dependency matrix with official documentation URL, network, observed availability, test transaction and fallback. Do not infer a mainnet launch date from a competition deadline.

## 9. Security and operational requirements

| Risk | Required response and limitation |
| --- | --- |
| Keeper trades outside policy | Independently detect; stop new intents; alert owner; assist revocation. Detection cannot undo trades. |
| False signed observations/outcomes | Independent comparisons, monotonic cursors and reconciliation. Signatures alone do not prove market truth. |
| Watcher outage | Health monitoring and fail-closed placement policy after timeout; disclose common infrastructure dependencies. |
| Order fills during cancel | Keep reservations until confirmation; process late fills exactly once. |
| Bad key handling | Per-owner operational isolation, encrypted key storage, least privilege and rotation. Claim KMS-backed only if deployed and verified. |
| Stale or silent feed | Active independent timeout and cancellation attempt; no automatic resume before reconciliation. |
| Manipulated reference/thin market | Deviation checks, conservative size/spread, visible source limitations and shutdown. |
| Gas/RPC/API exhaustion | Budget monitoring, bounded retries/backoff and reserved cancellation capacity. |
| Owner or external account activity | Detect and reconcile; dedicated first-release account; public mandate does not constrain unrelated trading. |
| Admin change | Public permission matrix, bounded powers and timelock where implemented; existing terms cannot be silently rewritten. |

Test replay/domain separation for signed data, nonce uniqueness, access control, precision, reservation races, duplicate fills, delayed outcomes, fee caps, expiry without ticks, restart recovery, cancel rejection and owner revocation. Keep work per tick and maximum order count bounded. Never log keys or fund mainnet accounts for the submission without separate authorisation.

## 10. Pricing and token plan

Business hypothesis: a transparent fee based on executed notional, paid from a capped prepaid balance. The original proposed 5 bps is unvalidated and must be tested against exchange fees, expected spread capture and customer willingness to pay. Do not present it as final pricing.

Owners retain trading gains and bear trading losses. Service fee capital on Elysium has a distinct custody and withdrawal model from HyperCore trading inventory; document contract access controls and withdrawal conditions.

Competition materials supplied by the organiser say recipients launch through Ascend and payments follow launch. The scope of token-launch obligations, milestone conditions and timing must be confirmed directly before financial commitments. The grant is not assumed to be upfront build funding.

STAPLE is a provisional token name. Supply, allocation, vesting, launch timing and utility remain undetermined. Do not promise buybacks, fee discounts or staking until the operating model, platform mechanics and appropriate review support them. The service must remain understandable and usable independently of speculative token demand.

A future “verified” badge must describe actual completed checks, freshness and limitations. Token staking alone cannot establish execution safety.

## 11. Product surfaces

### Landing

Hero: “Market making you can audit.”

Subheading: “Quote from your own Hyperliquid account. Publish your rules. Track how execution follows them.”

Actions: View a testnet mandate; Draft a mandate when implemented.

Show the customer problem, the execution loop, a real recorded run and trust assumptions. Any replay must be labelled with market, network and capture time. No fabricated live metrics, customers or endorsements.

### Public mandate

Show policy/version, account and market, reference age, live and reserved inventory, actual orders, PnL/fees, shutdown threshold, residual holdings, breaker history, discrepancies and watcher health. Separate intended, observed and unconfirmed state.

Decision strip example: “Reference 1.2034, 140 ms old → inventory 38% → quotes skewed down 11 bps → two levels requested → awaiting exchange confirmation.” Populate from actual decisions, never decorative values.

### Owner console

Draft and validate, explain permissions, approve agent, activate, inspect exposure, edit with diff, pause and execute the confirmed cancel/revoke flow. Show actionable failure states. No claim of “off in one click” unless the UI distinguishes initiated from completed shutdown.

### Simulation

Deferred. If included later, label scenarios SIMULATED, disclose data quality, queue assumptions, fees and fill model. Show sensitivity ranges; do not imply exact historical fills or forecast returns from book snapshots.

## 12. Proof campaign

### Frozen primary metric

Percentage of valid sampled seconds where observed spread is at or below the mandate target and displayed executable depth meets the specified size on both sides. Publish the exact depth band, size units, sampling interval and missing-data treatment before the run.

Secondary metrics: actual inventory and net PnL, loss overshoot, cancellation latency, reference age, order-to-intent reconciliation coverage, mismatch count, unknown outcomes and service uptime.

Hypothesis: enabling Staple improves time-at-target relative to no Staple under the sampled testnet conditions. A 50-percentage-point improvement is an experimental target, not a promised result or a reason to hide a smaller useful result.

### Method

- One named market, one fixed policy and pinned code commit.
- Interleave equal-duration mandate-on and mandate-off blocks; rotate order to reduce timing bias.
- Keep market, observation method and capital constraints fixed where applicable.
- A matched static-ladder arm is optional after the primary comparison works. Describe its actual parameters rather than calling it a faithful HIP-2 implementation.
- Aim for at least 24 hours only if time permits. Publish actual duration and coverage; never label a short run a 24-hour campaign.
- Independent public-book sampler, ideally separate process and implementation from the keeper.
- Label all controlled taker activity. Report controlled and apparently external fills separately; do not claim external fills prove organic demand.
- Publish all failed runs, missing intervals and interruptions with reasons.

### Required cases

| Case | Acceptance evidence |
| --- | --- |
| Live activation | Intent, accepted order and independent observation match |
| Normal fill | Fill updates inventory, reservation and fees exactly once |
| Healthy book | Configured stay-out/join rule behaves as specified |
| Stale feed | Independent watchdog attempts cancel; actual removal time reported |
| Volatility | Trigger and cancellation observed; subsequent resume conditions verified |
| Loss trigger | Shutdown activates; overshoot and residual inventory disclosed |
| Delayed cancel/partial fill | Reservations remain conservative; late fills reconcile |
| Replay/out-of-order outcome | No duplicated accounting or fees |
| Keeper outage/restart | No new exposure before reconciliation; emergency path and limits recorded |
| Mismatched order | Watcher detects, alerts and prevents new intended exposure; key authority limitation remains explicit |
| Owner exit | Revocation and remaining-order checks confirmed separately |

Test compromised-key scenarios through unit/integration fault injection or an explicitly isolated testnet account. Do not intentionally harm shared markets.

### Falsification and interpretation

If a compliant execution path breaches inventory reservations, stop and fix the implementation before claiming that invariant. If market quality fails to improve, publish the result and narrow the product claim. If loss overshoots, report it; overshoot alone does not prove a trigger failed. Distinguish trigger failure, cancellation delay and continuing inventory exposure.

Testnet validates mechanics under observed conditions. It does not establish mainnet profitability, real customer demand or production reliability.

## 13. Latency calibration and reproducibility

Record distributions and sample counts for observation → Elysium decision, intent → accepted order, accepted → sampled resting order, fill → reconciliation and cancel request → confirmed removal. Use p50/p95/max with clock source and timestamp uncertainty. Derive tick rate, reference-age defaults and timeouts from measured end-to-end behaviour, not headline block times.

Respect API limits and account-specific limits. Bound outstanding work; a faster tick must not accumulate overlapping unsafe orders. Note batching and finality assumptions.

Repository structure: contracts/, keeper/, reference/, watcher/, sampler/, web/, runs/ and docs/. Add SDK packaging later.

Offline test command must cover quote vectors and risk/recovery invariants. Testnet campaign command must specify network, account, market and budget explicitly. Fresh-clone verification uses testnet only and requires no committed secrets.

Every run manifest pins commit, network/chain ID, contract addresses, account, asset metadata, policy/version, time window, source cursors or heights, raw file hashes, software versions and calculation method. Record transaction and order links where available. Independent sampler evidence must not be reconstructed from keeper logs.

## 14. Judge path and demo

Wallet-free path under five minutes: landing → public mandate → corresponding Hyperliquid testnet market → proof results → raw evidence and limitations.

If controlled judge interaction is available, clearly label a bounded demo account. Do not publish its private key or invite concurrent unrestricted use. Read-only inspection is the default.

Demo target: 100 seconds, within the organiser's 60–120 second range.

| Time | Content |
| --- | --- |
| 0–12 s | Explain the customer's thin-book and transparency problem |
| 12–25 s | Show actual mandate terms and the owner's account |
| 25–50 s | Activate; show real testnet quotes and matching intents |
| 50–68 s | Show a real fill and reconciled inventory/reservations |
| 68–85 s | Trigger shutdown; show confirmed cancellation and residual inventory |
| 85–100 s | Show measured results, trust limits and the next milestone |

Use actual footage and actual results. No invented customer DMs, founder testimonials, reconstructed results presented as live or unsupported claims of guaranteed loss limits. Disclose testnet, controlled taker activity and recorded footage on screen.

## 15. Delivery schedule and launch roadmap

Previous Oct 15–16 milestones are historical targets with completion unknown. Do not mark them complete without evidence. As of this revision on Oct 17, use the following gates:

| Target | Required outcome |
| --- | --- |
| Oct 17 | Audit actual implementation status; prove live placement/cancel/report; confirm market and organiser deadline timezone |
| Oct 18 | Complete exposure reservations, essential shutdown/recovery tests and public judge path; start campaign as soon as safe |
| Oct 19 | Freeze features; finish available campaign; publish actual results and limitations; record demo and concise submission |
| Oct 20 | Submit before the organiser-confirmed cutoff, preferably with a buffer; do not assume the deadline's timezone or hour |

If safety gates cannot be met, submit an honest prototype with technical evidence and remaining work. The supplied competition rules allow unfinished products and explain when a demo is not applicable. Never rush unverified mainnet trading to manufacture readiness.

### After selection / launch

1. Confirm Ascend obligations, launch prerequisites and grant payment conditions.
2. Obtain a design partner, validate pricing and establish an explicit small-capital pilot agreement.
3. Complete independent security review, operational monitoring and deployment checks before mainnet funds.
4. Launch a capped spot pilot only when target infrastructure is available and verified; publish incidents and performance.
5. Add native integration when tested; reassess trust claims rather than assuming enforcement improves.
6. Package self-hosting and SDK after operational stability and customer demand.
7. Evaluate perps and multi-market support as separate risk milestones.

No fixed mainnet date is promised. The post-token roadmap is continued product operation, pilot learning, reliability and integrations; token launch is not the endpoint.

## 16. Submission structure and claim ledger

The final Discord ticket should be concise and cover all six organiser sections:

1. Project name, X, deployed website and public GitHub/docs links.
2. What Staple builds, who needs it, the problem and why they would use it.
3. A 60–120 second demo if applicable; otherwise exact progress and supporting materials.
4. Working / In Development / Before Launch lists, milestone timeline, provisional token plan and support requested from Ascend.
5. Development after launch.
6. Actual team members, relevant shipped experience, team size and best contact.

Team identity, links and current build status are not established by this PRD. Fill them from verified information; do not invent them. Prior projects can demonstrate shipping ability but are not Staple traction.

Suggested support request: design-partner introductions, confirmation of launch/payment requirements, integration guidance and access to relevant technical documentation. Do not imply Ascend has agreed.

Maintain submission-facts.json: claim, status (planned / implemented-unverified / testnet-verified / mainnet-verified / simulated), evidence path, commit, observation time, network and limitation. README, website, demo and ticket must agree. Measure execution coverage against all relevant exchange activity, including unknown orders; do not silently exclude mismatches from a “100% match” denominator.

## 17. Release gates

- G1: One real testnet place/cancel/outcome loop independently observed.
- G2: Reservation, precision, access-control and idempotency tests pass.
- G3: Stale-data shutdown works without fresh ticks; late fills and cancel failures reconcile.
- G4: Pause/revoke UI distinguishes requested and confirmed external outcomes.
- G5: Public evidence contains failures, unknowns, actual duration and trust limits.
- G6: Submission facts align with what is deployed and demonstrated.

Unmet gates remain visible in “Before Launch.” Defer extra features when a core gate is unresolved. No invented traction, evidence or completion claims.

## 18. Research and open questions

- Confirm exact October 20 cutoff and timezone with Ascend.
- Confirm launch obligations, payment schedule and any required token parameters.
- Establish actual target-network availability, interfaces and supported fee assets.
- Verify agent permissions, owner revocation flow and exchange-side cancellation behaviour experimentally.
- Select an accessible thin spot market and verify precision, balances and API budgets.
- Validate customer demand, acceptable public disclosure and service pricing.
- Check Staple/STAPLE naming collisions before public launch.
- Establish the appropriate operational/legal review before managing mainnet trading for customers.

Reference starting points (not proof that integrations are implemented):

- Hyperliquid API wallets: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
- Hyperliquid exchange actions: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
- Hyperliquid limits: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
- Elysium documentation surfaced during review: https://kinetlq.vercel.app/docs/technical-overview — verify official provenance and current network behaviour before relying on it.
- Competition requirements and rubric: organiser text supplied with this revision. Deadline hour/timezone and detailed funding conditions remain unconfirmed.

## 19. Changes from version 1.0

Retained the public-mandate concept, owner-account trading, Elysium coordination, independent proof and transparent reporting. Replaced implied exchange enforcement with explicit keeper authority limits; changed max-loss language to shutdown-trigger semantics; added reservations for every potentially executable order; defined residual inventory and owner exit; added independent timeouts and restart recovery; narrowed the first release to one spot market; deferred speculative token mechanics and simulation; removed unsupported market statistics, exclusivity and infrastructure dates; replaced invented demo dialogue with real evidence; aligned submission content with all six organiser requirements.
