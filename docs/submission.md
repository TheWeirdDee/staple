# Ascend Builder Competition: submission draft (Builder Grants track)

> Draft only. Do not submit until the bracketed fields are filled with verified information and the
> Working/In Development lists match `submission-facts.json` and `/proof` at that moment. Nothing here has been
> sent to anyone.

## 1. Project and links

- **Project:** Staple: market making you can audit.
- **X:** [TO FILL: official handle, if any]
- **Website (testnet):** https://theweirddee.github.io/staple/ (live once GitHub Pages is enabled)
- **GitHub and docs:** https://github.com/TheWeirdDee/staple · `docs/`

## 2. What we build, for whom, and why

Token teams with a thin HyperCore spot book have three options: hire a market maker, run a private bot, or leave
the book thin. In all three, holders can't see the quoting rules or check that trading followed them. With Staple
the team quotes from **its own Hyperliquid account** under a **public, versioned policy on Elysium**: spread,
sizes, inventory bounds, shutdown triggers and expiry. The contract computes every order as a public intent
and reserves worst-case exposure first. An open-source keeper executes it through a trade-only agent the owner
approves. An **independent watcher** matches every exchange order and fill to an intent and reports mismatches
on-chain. The public page shows the terms, the intents, the exchange's own view of the account, PnL and fees,
every shutdown, and the remaining risk.

What we do not claim: the contract cannot stop the agent key trading outside its intents (the watcher detects it
afterwards). The loss trigger is not a cap. We are not the first market-making bot or transparency tool.

## 3. Demo

[60–120 s video link: TO RECORD from the live testnet run. Script: `docs/demo-script.md`.] Until it exists,
the wallet-free path takes under five minutes: landing → `/mandate` → Hyperliquid testnet account link → `/proof`.

## 4. Status, timeline, token plan, support requested

**Working** (only items with evidence; see `/proof`):
- [From `submission-facts.json` at submission time. As of this draft: contracts, keeper, watcher and sampler pass 95
  offline tests; the live testnet loop is pending funding.]

**In development:** [testnet campaign results; demo footage]

**Before launch:** independent security review; KMS-backed key storage; design-partner pilot with explicit
capital limits; Elysium native HyperCore integration once available and tested; operational monitoring
separated from shared infrastructure.

**Timeline:** Oct 17: audit and live loop · Oct 18: reservations, shutdown/recovery tests, judge path,
campaign start · Oct 19: feature freeze, results, demo · Oct 20: submission before the organiser-confirmed cutoff
[confirm the exact hour and timezone with Ascend].

**Token plan:** provisional only (`docs/token-plan.md`). Supply, allocation, vesting, timing and utility are
undetermined. No buybacks, discounts or staking are promised.

**Support requested from Ascend:** introductions to design partners, confirmation of launch and payment
requirements, Elysium integration guidance, and access to relevant technical documentation. This does not imply
Ascend has agreed to anything.

## 5. After launch

Confirm obligations → design partner and a capped spot pilot with published incidents → security review before
any mainnet funds → native Elysium read/write integration once tested → self-hosting and SDK packaging →
perps and multi-market support as separate risk milestones. No fixed mainnet date.

## 6. Team

[TO FILL by the team: actual members, relevant shipped experience (prior projects are not Staple traction),
team size, best contact.] Customers and partners today: **none**.
