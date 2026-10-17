import { motion, useReducedMotion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { CTA, ExtLink, Notice, SectionHead, StateBadge, Term } from '../components/ui';
import { LoopDiagram } from '../components/LoopDiagram';
import { loadDeployment, explorerTx, hlAccount } from '../lib/config';
import { loadEvidence } from '../lib/evidence';
import { readMandate } from '../lib/desk';
import { usePoll } from '../lib/usePoll';
import { shortHash } from '../lib/format';

function LiveChip() {
  const { data } = usePoll(async () => {
    const dep = await loadDeployment();
    if (!dep?.featuredMandate) return null;
    const m = await readMandate(dep, BigInt(dep.featuredMandate));
    return { id: dep.featuredMandate, state: m.state, orders: m.orders.length };
  }, 15_000);
  if (data === undefined) return <span className="small">Checking the testnet mandate…</span>;
  if (data === null) return <span className="small">Testnet deployment pending: see the proof page for current status.</span>;
  return (
    <span className="row small" style={{ gap: 10 }}>
      Mandate #{data.id} right now: <StateBadge state={data.state} /> {data.orders} live order{data.orders === 1 ? '' : 's'} on-chain
    </span>
  );
}

function RecordedRun() {
  const { data, loading } = usePoll(loadEvidence, 0);
  if (loading) return null;
  const g1 = data?.g1;
  if (!g1 || g1.status !== 'testnet-verified') {
    return (
      <Notice tone="warn" title="No recorded live loop yet">
        <p className="small" style={{ margin: '4px 0 0' }}>
          The first real testnet run (intent → HyperCore order → independent observation → confirmed cancel) has not been
          published yet. This page will show its transaction hashes and exchange order ids once it has run. Nothing here is
          simulated. <Link to="/proof">Current status</Link>
        </p>
      </Notice>
    );
  }
  return (
    <div className="stack-lg">
      <p className="small">
        Recorded on {data!.network}, market {data!.market}, captured {g1.capturedUtc}. Every row links to the public record.
      </p>
      <div className="table-wrap stackable" tabIndex={0} aria-label="Recorded live loop">
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Where</th>
              <th>Time (UTC)</th>
              <th>Record</th>
            </tr>
          </thead>
          <tbody>
            {g1.steps.map((s, i) => (
              <tr key={i}>
                <td data-label="Step">
                  <strong>{s.label}</strong>
                  {s.detail && <div className="small">{s.detail}</div>}
                </td>
                <td data-label="Where" className="mono">
                  {s.source}
                </td>
                <td data-label="Time" className="mono">
                  {s.time ?? '—'}
                </td>
                <td data-label="Record" className="mono break">
                  {s.tx ? <ExtLink href={explorerTx(s.tx)}>{shortHash(s.tx)}</ExtLink> : s.oid ? `oid ${s.oid}` : '—'}
                  {s.oid && s.tx ? <div className="small">oid {s.oid}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data!.account && (
        <p className="small">
          Owner account on HyperCore testnet: <ExtLink href={hlAccount(data!.account)}>{data!.account}</ExtLink>
        </p>
      )}
    </div>
  );
}

export function Landing() {
  const reduce = useReducedMotion();
  const rise = (d: number) => (reduce ? {} : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, delay: d, ease: [0.2, 0.7, 0.2, 1] } });
  return (
    <>
      <section className="wrap" style={{ padding: 'clamp(56px, 10vw, 128px) var(--gutter) clamp(56px, 8vw, 96px)' }}>
        <div className="stack-lg" style={{ maxWidth: 980 }}>
          <motion.p className="kicker" {...rise(0)}>
            Hyperliquid spot · Policy on Elysium · Testnet
          </motion.p>
          <motion.h1 className="display" {...rise(0.05)}>
            Market making
            <br />
            you can <span className="accent">audit.</span>
          </motion.h1>
          <motion.p className="lede" {...rise(0.15)}>
            Quote from your own Hyperliquid account. Publish your rules. Track how execution follows them.
          </motion.p>
          <motion.div className="row" style={{ gap: 12 }} {...rise(0.25)}>
            <CTA to="/mandate">View the testnet mandate</CTA>
            <CTA to="/console" variant="ghost">
              Draft a mandate
            </CTA>
          </motion.div>
          <motion.div {...rise(0.35)}>
            <LiveChip />
          </motion.div>
        </div>
      </section>

      <section className="section">
        <div className="wrap grid-12">
          <div style={{ gridColumn: 'span 5' }} className="col-wide">
            <SectionHead kicker="The problem" title="Thin books, opaque help." />
          </div>
          <div style={{ gridColumn: 'span 7' }} className="col-wide stack-lg">
            <p className="lede" style={{ maxWidth: '52ch' }}>
              A token team with a thin HyperCore spot book usually has three options: hire a market maker, run a private bot,
              or leave the book thin. Holders can’t see the quoting rules, or check that the trading matched them.
            </p>
            <div className="grid-2">
              <div className="stack">
                <h3 className="h3">Who it’s for</h3>
                <p className="body">
                  Token teams that already hold inventory and want two-sided liquidity under rules anyone can read.
                </p>
              </div>
              <div className="stack">
                <h3 className="h3">What changes</h3>
                <p className="body">
                  The capital stays in your account. The <Term k="spread" />, sizes and shutdown rules are public. Every
                  exchange order is matched to a published <Term k="intent" />, including the ones that don’t match.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <SectionHead kicker="How it works" title="One loop, observed from both ends.">
            The contract decides. The exchange executes. A separate watcher checks the two against each other and publishes
            what it finds.
          </SectionHead>
          <LoopDiagram />
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <SectionHead kicker="Real run" title="A recorded testnet loop, not a mock-up." />
          <RecordedRun />
        </div>
      </section>

      <section className="section" id="trust">
        <div className="wrap">
          <SectionHead kicker="Trust boundary" title="What the contract enforces, and what it can’t." />
          <div className="grid-2">
            <div className="card stack">
              <p className="kicker">Enforced on Elysium</p>
              <ul className="body" style={{ paddingLeft: 18, margin: 0 }}>
                <li>Which orders the contract intends, at which prices and sizes.</li>
                <li>
                  Worst-case inventory and budget <Term k="reservation">reservations</Term> for every order that could still
                  execute.
                </li>
                <li>Shutdown on stale data, volatility, a loss trigger, missing outcomes or a watcher outage.</li>
                <li>Versioned policy: risk-increasing edits wait 60 seconds and are public.</li>
              </ul>
            </div>
            <div className="card stack">
              <p className="kicker">Still trusted</p>
              <ul className="body" style={{ paddingLeft: 18, margin: 0 }}>
                <li>
                  The keeper’s <Term k="agent" /> key can technically trade outside the intents. The watcher detects that
                  afterwards; it cannot undo trades.
                </li>
                <li>Pausing on Elysium does not revoke the agent. Only the owner can revoke it on Hyperliquid.</li>
                <li>Observations and outcome reports are signed by the reporter. A signature proves who sent the data, not that it is true.</li>
                <li>
                  The <Term k="loss trigger" /> stops quoting. It is not a cap: losses can exceed it while orders are cancelled, and
                  remaining inventory keeps moving with the market.
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap spread" style={{ alignItems: 'center' }}>
          <div className="stack" style={{ maxWidth: 640 }}>
            <h2 className="h2">Inspect the live testnet mandate in under five minutes.</h2>
            <p className="body">
              No wallet needed: terms, the contract’s intents, the exchange’s own view of the account, fills, fees and every
              shutdown.
            </p>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <CTA to="/mandate">View the testnet mandate</CTA>
            <CTA to="/proof" variant="ghost">
              See the evidence
            </CTA>
          </div>
        </div>
      </section>
    </>
  );
}
