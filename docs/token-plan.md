# Pricing hypothesis and provisional token plan

## Pricing (hypothesis, not final)

- The working hypothesis is a transparent service fee charged on executed notional and paid from a capped,
  prepaid balance held on Elysium, separate from trading capital on HyperCore.
- The 5 bps used in the testnet policy is a placeholder to exercise the mechanism. It has not been validated
  against exchange fees, spread capture or any customer's willingness to pay.
- Owners keep trading gains and bear trading losses. Unspent prepaid fees can be withdrawn by the owner at any
  time. The fee recipient can claim only fees already charged against executed fills.
- On testnet the fee asset is `tFEE`, a valueless test token, because no verified USDC funding path to Elysium
  testnet was found.

## STAPLE token (provisional)

- "STAPLE" is a provisional name. A naming-collision check has not been done.
- Supply, allocation, vesting, launch timing and utility are **undetermined**.
- No buybacks, fee discounts or staking are promised. None will be offered unless the operating model, platform
  mechanics and an appropriate review support them.
- The service has to make sense on its own. Nothing in the product depends on demand for a token.
- The competition materials say grant recipients launch through Ascend, with payments after launch. The scope
  of the token-launch obligations, milestones and timing must be confirmed directly with Ascend before any
  commitment is made. The grant is not treated as upfront build funding.
- A future "verified" badge would describe the actual checks completed, how fresh they are and their limits.
  Staking a token cannot establish execution safety.

## After selection or launch

1. Confirm Ascend obligations, launch prerequisites and payment conditions.
2. Find a design partner, validate pricing and agree an explicit small-capital pilot.
3. Complete an independent security review, production monitoring and deployment checks before any mainnet funds.
4. Run a capped spot pilot only once the target infrastructure is available and verified. Publish incidents and
   performance.
5. Adopt Elysium's native HyperCore read/write integration once tested, and reassess trust claims rather than
   assuming enforcement improved.
6. Package self-hosting and an SDK once operations are stable and there is demand.
7. Treat perps and multi-market support as separate risk milestones.

No mainnet date is promised. After any token launch, the work continues: operating the product, learning from
pilots, reliability and integrations.
