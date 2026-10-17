import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ExtLink, SectionHead } from '../components/ui';
import { GLOSSARY } from '../lib/glossary';
import { REPO } from '../lib/config';

const PERMISSIONS: [string, string, string][] = [
  ['Owner (your wallet)', 'Create a mandate, publish policy versions, deposit/withdraw unspent fees, activate, pause, start cancel-and-revoke, re-arm, change roles while quiescent', 'Approve or revoke the trading agent on Hyperliquid; trade the account directly'],
  ['Keeper reporter', 'Sign observations (book, balances) and outcome reports (acks, fills, cancels)', 'Nothing on Hyperliquid by itself. The agent key it runs with can place and cancel orders'],
  ['Trading agent', '—', 'Place and cancel orders on the owner’s account (Hyperliquid enforces: no withdrawals or transfers out)'],
  ['Watcher', 'Check in (heartbeat), report mismatches, report observed agent removal', 'Read the account; with a separately approved guard agent, cancel orders in an emergency'],
  ['Anyone', 'Call the watchdog (poke): enforces expiry, staleness, watcher timeout and missing outcomes', 'Read public data'],
  ['Deployer', 'Bind the desk to the registry exactly once. No admin, pause or upgrade powers afterwards', '—'],
];

const LIMITS: [string, string][] = [
  ['Markets', 'One HyperCore spot market per mandate (first release: PURR/USDC on testnet). Perps are out of scope.'],
  ['Orders', 'At most 5 levels per side and 24 potentially executable orders per mandate, including orders awaiting cancellation.'],
  ['Order type', 'Post-only (ALO) limit orders. Prices follow HyperCore rules: 5 significant figures, at most 8 − size-decimals decimals.'],
  ['Cadence', 'The keeper observes every ~5 s. Elysium blocks are 100–200 ms. Reference age limit is a policy field (campaign: 15 s).'],
  ['Exchange limits', 'Hyperliquid allows 1,200 REST weight per minute per IP and an address budget of 10,000 requests plus 1 per USDC traded. The keeper stops new placements before the budget runs out so cancels always remain possible.'],
  ['Dead man’s switch', 'The keeper renews Hyperliquid’s scheduled cancel (90 s ahead) while orders may rest. Hyperliquid allows at most 10 triggers per day.'],
  ['Unknown outcomes', 'Every placement carries an exchange expiry (8 s). An unknown outcome is resolved by querying after that expiry, never by blind retry.'],
  ['Elysium integrations', 'The native HyperCore read precompile and keeper write lane are documented as shipping after Elysium mainnet. Until then observations and outcomes are reported off-chain and signed.'],
];

const DEPS: [string, string, string, string][] = [
  ['Elysium testnet', 'Chain 99801 · testnet-rpc.elysium.kinetiq.xyz', 'Live; contracts deployed via standard EVM tooling', 'elysium.kinetiq.xyz/docs/building-on-elysium'],
  ['HyperCore market-data precompile', 'Post-mainnet ArbOS upgrade (per docs)', 'Not available: keeper-posted observations used', 'elysium.kinetiq.xyz/docs/hypercore-market-data'],
  ['ElysiumCoreWriter keeper lane', 'Post-mainnet ArbOS upgrade (per docs)', 'Not available: open-source keeper executes intents', 'elysium.kinetiq.xyz/docs/trading-on-hypercore-from-elysium'],
  ['Hyperliquid testnet API', 'api.hyperliquid-testnet.xyz', 'Live; signing verified against the official Python SDK', 'hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api'],
  ['Fee asset on Elysium', 'USDC 0x7D29…47b2 listed in docs', 'No verified testnet funding path: labelled test token (tFEE) used', 'elysium.kinetiq.xyz/docs/building-on-elysium'],
];

export function Docs() {
  const loc = useLocation();
  useEffect(() => {
    if (loc.hash) document.getElementById(loc.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [loc.hash]);
  return (
    <div className="wrap stack-lg" style={{ padding: 'clamp(40px, 6vw, 72px) var(--gutter) 96px' }}>
      <header className="stack">
        <p className="kicker">Documentation</p>
        <h1 className="h1">How Staple works, and where it stops.</h1>
        <p className="lede">Integration, permissions, operating limits, the trust boundary and plain-English help.</p>
        <nav aria-label="On this page" className="row small" style={{ gap: 4 }}>
          {[
            ['integration', 'Integration'],
            ['permissions', 'Permissions'],
            ['limits', 'Limits'],
            ['trust', 'Trust boundary'],
            ['dependencies', 'Dependencies'],
            ['help', 'Help'],
            ['glossary', 'Glossary'],
          ].map(([id, label]) => (
            <Link key={id} to={{ pathname: '/docs', hash: id }} className="btn link sm" style={{ minHeight: 36 }}>
              {label}
            </Link>
          ))}
        </nav>
      </header>

      <section id="integration" className="stack">
        <SectionHead kicker="Integration" title="From draft to live quotes." />
        <ol className="steps">
          <li>
            <h3 className="h3">Use a dedicated HyperCore account</h3>
            <p className="body">Fund it with the base token and USDC you are willing to quote. Any other activity on it pauses the mandate for reconciliation.</p>
          </li>
          <li>
            <h3 className="h3">Publish a mandate</h3>
            <p className="body">In the owner console, set spread, sizes, inventory bounds, shutdown triggers and expiry. Version 1 is public immediately.</p>
          </li>
          <li>
            <h3 className="h3">Prepay fees and approve the agent</h3>
            <p className="body">Deposit test fee tokens on Elysium. Sign a Hyperliquid approval for the keeper’s agent with your own wallet. The console explains exactly what it allows before you sign.</p>
          </li>
          <li>
            <h3 className="h3">Activate and monitor</h3>
            <p className="body">The contract snapshots balances and quotes only once the independent watcher checks in. Share the public mandate page with holders.</p>
          </li>
          <li>
            <h3 className="h3">Self-host if you prefer</h3>
            <p className="body">
              The keeper and watcher are open source. Running your own changes who holds the agent key; it does not make the policy
              exchange-enforced. See the <ExtLink href={`${REPO}/blob/main/docs/runbook.md`}>runbook</ExtLink>.
            </p>
          </li>
        </ol>
      </section>

      <section id="permissions" className="stack">
        <SectionHead kicker="Permissions" title="Who can do what." />
        <div className="table-wrap stackable">
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>On Elysium</th>
                <th>On Hyperliquid</th>
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS.map(([r, e, h]) => (
                <tr key={r}>
                  <td data-label="Role">
                    <strong>{r}</strong>
                  </td>
                  <td data-label="Elysium">{e}</td>
                  <td data-label="Hyperliquid">{h}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="limits" className="stack">
        <SectionHead kicker="Operational limits" title="Bounds you can rely on." />
        <dl className="kv card">
          {LIMITS.map(([k, v]) => (
            <Pair key={k} k={k} v={v} />
          ))}
        </dl>
      </section>

      <section id="trust" className="stack">
        <SectionHead kicker="Trust boundary" title="What is enforced, and what is not." />
        <div className="grid-2">
          <div className="card stack">
            <h3 className="h3">The contract constrains its intents</h3>
            <p className="body">
              Prices, sizes, inventory bounds, reservations and shutdown rules apply to every order the contract emits. Policy changes
              are public and versioned. There is no admin key.
            </p>
          </div>
          <div className="card stack">
            <h3 className="h3">The agent key can trade outside them</h3>
            <p className="body">
              Hyperliquid permissions are account-wide. The watcher detects trades that match no intent and stops new exposure, but it
              cannot undo them. Pausing on Elysium does not revoke the agent; only the owner can, on Hyperliquid.
            </p>
          </div>
          <div className="card stack">
            <h3 className="h3">Reports are signed, not proven</h3>
            <p className="body">
              Book observations and outcomes are signed by the keeper reporter. A signature authenticates who sent the data, not that it
              is true. The watcher and the public page re-read the exchange independently to check.
            </p>
          </div>
          <div className="card stack">
            <h3 className="h3">Triggers are not guarantees</h3>
            <p className="body">
              The loss trigger and other shutdowns stop quoting and request cancellation. Losses can exceed the trigger through price
              gaps, cancellation latency or the inventory left afterwards. Staple never sells inventory automatically.
            </p>
          </div>
        </div>
        <p className="small">
          Shared infrastructure: the keeper and watcher currently run on the same host (see the runbook). The watcher’s independence is
          in code and keys, not hardware. Sequencer timestamps on Elysium are trusted for timeouts.
        </p>
      </section>

      <section id="dependencies" className="stack">
        <SectionHead kicker="Dependencies" title="Verified availability." />
        <div className="table-wrap stackable">
          <table>
            <thead>
              <tr>
                <th>Dependency</th>
                <th>Network / interface</th>
                <th>Observed status</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {DEPS.map(([a, b, c, d]) => (
                <tr key={a}>
                  <td data-label="Dependency"><strong>{a}</strong></td>
                  <td data-label="Network">{b}</td>
                  <td data-label="Status">{c}</td>
                  <td data-label="Source" className="break">
                    <ExtLink href={`https://${d}`}>{d.split('/')[0]}</ExtLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="help" className="stack">
        <SectionHead kicker="Help" title="Common questions." />
        {[
          ['A pause shows “Pausing” for a while. Is something wrong?', 'Pausing is only confirmed once the exchange confirms every cancellation. Orders can still fill until then, and fills are reconciled first. If it does not clear within a minute, the keeper may be down. The watcher attempts emergency cancellation, and you can cancel directly in the Hyperliquid app.'],
          ['Why did quoting stop on its own?', 'Open the public mandate page. The latest decision explains which rule fired (stale data, volatility, loss trigger, fees, watcher or reconciliation) and links the transaction.'],
          ['What happens to my tokens after a shutdown?', 'They stay in your account. Staple cancels orders but never sells inventory for you. The residual position keeps its market risk.'],
          ['My wallet says “wrong network”.', 'Contract actions happen on Elysium testnet (chain 99801). The console offers a one-click switch. Hyperliquid approvals are signed messages, not transactions.'],
          ['Can I edit the policy while live?', 'Yes. Risk-reducing edits apply immediately; risk-increasing ones wait 60 seconds. The switch happens only after every order from the old version is confirmed terminal.'],
        ].map(([q, a]) => (
          <details key={q} className="card">
            <summary style={{ cursor: 'pointer', fontWeight: 600, minHeight: 28 }}>{q}</summary>
            <p className="body" style={{ marginTop: 10 }}>{a}</p>
          </details>
        ))}
      </section>

      <section id="glossary" className="stack">
        <SectionHead kicker="Glossary" title="Trading terms in plain English." />
        <dl className="grid-2" style={{ margin: 0 }}>
          {Object.entries(GLOSSARY).map(([k, v]) => (
            <div key={k} className="stack" style={{ gap: 4 }}>
              <dt style={{ fontWeight: 600, textTransform: 'capitalize' }}>{k}</dt>
              <dd className="body" style={{ margin: 0 }}>{v}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt style={{ color: 'var(--ink)', fontWeight: 600 }}>{k}</dt>
      <dd style={{ textAlign: 'left', fontFamily: 'var(--font-ui)' }}>{v}</dd>
    </>
  );
}
