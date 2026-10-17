import { Link } from 'react-router-dom';
import { Badge, ExtLink, Notice, SectionHead, Skeleton, Stat } from '../components/ui';
import { REPO, explorerTx } from '../lib/config';
import { loadEvidence, type Campaign, type EvidenceIndex } from '../lib/evidence';
import { duration, shortHash } from '../lib/format';
import { usePoll } from '../lib/usePoll';

const STATUS_TONE = {
  met: 'ok',
  partial: 'warn',
  'not-met': 'bad',
  'testnet-verified': 'ok',
  'offline-tested': 'info',
  'not-run': 'warn',
  failed: 'bad',
  pending: 'warn',
} as const;

export function Proof() {
  const ev = usePoll(loadEvidence, 0);
  return (
    <div className="wrap stack-lg" style={{ padding: 'clamp(40px, 6vw, 72px) var(--gutter) 96px' }}>
      <header className="stack">
        <p className="kicker">Evidence · testnet</p>
        <h1 className="h1">What has actually been shown.</h1>
        <p className="lede">
          Release gates, the recorded live loop, the required failure cases and campaign results, with raw files and their limits.
          Testnet results show that the mechanics work under the observed conditions. They say nothing about mainnet profitability or demand.
        </p>
      </header>
      {ev.loading ? (
        <Skeleton h={200} />
      ) : !ev.data ? (
        <Notice tone="warn" title="Evidence index not published yet">
          <p className="small" style={{ margin: '4px 0 0' }}>
            No evidence file is available. Every claim on this site is backed by an entry here, so treat anything else as unverified.
          </p>
        </Notice>
      ) : (
        <ProofBody e={ev.data} />
      )}
    </div>
  );
}

function ProofBody({ e }: { e: EvidenceIndex }) {
  return (
    <>
      <p className="small mono">
        Generated {e.generatedAt} from commit{' '}
        <ExtLink href={`${REPO}/commit/${e.commit}`}>{e.commit.slice(0, 10)}</ExtLink> · {e.network} · {e.market}
      </p>

      <section className="stack">
        <SectionHead kicker="Release gates" title="G1–G6." />
        <div className="table-wrap stackable">
          <table>
            <thead>
              <tr>
                <th>Gate</th>
                <th>Status</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {e.gates.map((g) => (
                <tr key={g.id}>
                  <td data-label="Gate">
                    <strong>{g.id}</strong> {g.title}
                  </td>
                  <td data-label="Status">
                    <Badge tone={STATUS_TONE[g.status]}>{g.status.replace('-', ' ')}</Badge>
                  </td>
                  <td data-label="Evidence" className="small">
                    {g.evidence}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack">
        <SectionHead kicker="G1" title="Live loop: intent → order → observation → cancel." />
        {e.g1.status !== 'testnet-verified' ? (
          <Notice tone="warn" title="Not yet run on testnet">
            <p className="small" style={{ margin: '4px 0 0' }}>Waiting on testnet funding of the dedicated owner account. See the gate table for what remains.</p>
          </Notice>
        ) : (
          <div className="table-wrap stackable">
            <table>
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Source</th>
                  <th>Time (UTC)</th>
                  <th>Record</th>
                </tr>
              </thead>
              <tbody>
                {e.g1.steps.map((s, i) => (
                  <tr key={i}>
                    <td data-label="Step">
                      <strong>{s.label}</strong>
                      {s.detail && <div className="small">{s.detail}</div>}
                    </td>
                    <td data-label="Source" className="mono">{s.source}</td>
                    <td data-label="Time" className="mono">{s.time ?? '—'}</td>
                    <td data-label="Record" className="mono break">
                      {s.tx ? <ExtLink href={explorerTx(s.tx)}>{shortHash(s.tx)}</ExtLink> : s.oid ? `oid ${s.oid}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="stack">
        <SectionHead kicker="Required cases" title="Failure and recovery cases." />
        <div className="table-wrap stackable">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>Status</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {e.cases.map((c) => (
                <tr key={c.id}>
                  <td data-label="Case">{c.name}</td>
                  <td data-label="Status">
                    <Badge tone={STATUS_TONE[c.status]}>{c.status.replace('-', ' ')}</Badge>
                  </td>
                  <td data-label="Evidence" className="small">
                    {c.evidence}
                    {c.note && <div>{c.note}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small">“Offline tested” means real contracts on a local node with an exchange test double for fault injection. It is not exchange integration.</p>
      </section>

      <section className="stack">
        <SectionHead kicker="Campaign" title="Market quality with and without the mandate.">
          Primary metric frozen before the run: share of valid sampled seconds with spread ≤ 40 bps and at least 3 PURR displayed within 40
          bps of mid on both sides. <ExtLink href={`${REPO}/blob/main/docs/metrics.md`}>Definitions</ExtLink>.
        </SectionHead>
        {e.campaigns.length === 0 ? (
          <Notice tone="warn" title="No campaign run yet">
            <p className="small" style={{ margin: '4px 0 0' }}>Nothing to report. No numbers are shown until a run has actually happened.</p>
          </Notice>
        ) : (
          e.campaigns.map((c) => <CampaignCard key={c.id} c={c} />)
        )}
      </section>

      <section className="stack">
        <SectionHead kicker="Offline suites" title="Tests run against the published commit." />
        <div className="table-wrap stackable">
          <table>
            <thead>
              <tr>
                <th>Suite</th>
                <th className="r">Passed</th>
                <th className="r">Failed</th>
                <th>Command</th>
              </tr>
            </thead>
            <tbody>
              {e.offline.map((o) => (
                <tr key={o.suite}>
                  <td data-label="Suite">{o.suite}</td>
                  <td data-label="Passed" className="r mono">{o.passed}</td>
                  <td data-label="Failed" className="r mono">{o.failed}</td>
                  <td data-label="Command">
                    <span className="code">{o.command}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack">
        <SectionHead kicker="Limits" title="What this evidence does not show." />
        <ul className="body" style={{ paddingLeft: 18 }}>
          {e.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
        <p className="small">
          Read the <Link to="/docs#trust">trust boundary</Link> before relying on any of it.
        </p>
      </section>
    </>
  );
}

function CampaignCard({ c }: { c: Campaign }) {
  const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
  return (
    <div className="card stack">
      <div className="spread">
        <h3 className="h3">Campaign {c.id}</h3>
        <Badge tone={c.status === 'complete' ? 'ok' : c.status === 'running' ? 'info' : 'bad'} pending={c.status === 'running'}>
          {c.status}
        </Badge>
      </div>
      <p className="small mono">
        {c.startUtc} → {c.endUtc ?? 'ongoing'} · actual duration {duration(c.durationSec)} · {c.coverage.secondsSampled} s sampled,{' '}
        {c.coverage.missingSeconds} missing, {c.coverage.invalidSeconds} invalid
      </p>
      <div className="grid-3">
        <Stat label="Time at target · mandate on" value={pct(c.arms.on.timeAtTarget)} sub={`${c.arms.on.validSeconds} valid s · median spread ${c.arms.on.spreadBpsP50?.toFixed(1) ?? '—'} bps`} />
        <Stat label="Time at target · mandate off" value={pct(c.arms.off.timeAtTarget)} sub={`${c.arms.off.validSeconds} valid s · median spread ${c.arms.off.spreadBpsP50?.toFixed(1) ?? '—'} bps`} />
        <Stat label="Difference" value={c.improvementPctPoints === null ? '—' : `${c.improvementPctPoints >= 0 ? '+' : ''}${c.improvementPctPoints.toFixed(1)} pp`} sub="percentage points, on minus off" />
      </div>
      {c.pnl && (
        <dl className="kv">
          {Object.entries(c.pnl).map(([k, v]) => (
            <Pair key={k} k={k} v={v} />
          ))}
        </dl>
      )}
      {c.latency && (
        <div className="table-wrap stackable">
          <table>
            <thead>
              <tr>
                <th>Latency</th>
                <th className="r">n</th>
                <th className="r">p50</th>
                <th className="r">p95</th>
                <th className="r">max</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(c.latency).map(([k, l]) => (
                <tr key={k}>
                  <td data-label="Latency">{k}</td>
                  <td data-label="n" className="r mono">{l.n}</td>
                  <td data-label="p50" className="r mono">{l.p50} {l.unit}</td>
                  <td data-label="p95" className="r mono">{l.p95} {l.unit}</td>
                  <td data-label="max" className="r mono">{l.max} {l.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {c.reconciliation && (
        <dl className="kv">
          {Object.entries(c.reconciliation).map(([k, v]) => (
            <Pair key={k} k={k} v={String(v)} />
          ))}
        </dl>
      )}
      {c.interruptions.length > 0 && (
        <div className="stack">
          <p className="kicker">Interruptions and missing intervals</p>
          <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
            {c.interruptions.map((i, k) => (
              <li key={k}>
                {i.start} → {i.end}: {i.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="stack">
        <p className="kicker">Raw files</p>
        <ul className="small mono" style={{ paddingLeft: 18, margin: 0 }}>
          {c.files.map((f) => (
            <li key={f.name} className="break">
              <a href={f.url} download>
                {f.name}
              </a>{' '}
              · {(f.bytes / 1024).toFixed(0)} KB · sha256 {f.sha256.slice(0, 16)}…
            </li>
          ))}
        </ul>
      </div>
      <div className="stack">
        <p className="kicker">Limitations</p>
        <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
          {c.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
