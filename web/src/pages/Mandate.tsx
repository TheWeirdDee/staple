import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { POLICY_FIELDS, diffPolicies, parseScaled, type Policy } from '@staple/reference';
import { Badge, ExtLink, LoadError, Meter, Notice, SectionHead, Skeleton, Stat, StateBadge, Term } from '../components/ui';
import { explorerAddr, explorerTx, hlAccount, loadDeployment, type Deployment } from '../lib/config';
import { blockTime, loadEvents, readMandate, readPolicy, REASONS, decisionReason, type DeskEvent, type MandateView, NotFound } from '../lib/desk';
import { hl, cloidHex, type HlOpenOrder } from '../lib/hl';
import { toRefPolicy } from '../lib/policy';
import { ago, fmtE8, fmtPx, fmtSigned, shortAddr, shortHash, utc } from '../lib/format';
import { useNow, usePoll } from '../lib/usePoll';

const E8 = 100_000_000n;

export function MandateRoute() {
  const { id } = useParams();
  const dep = usePoll(loadDeployment, 0);
  if (dep.loading) return <PageSkeleton />;
  if (!dep.data) return <NotDeployed />;
  const mid = id ?? dep.data.featuredMandate;
  if (!mid || !/^\d+$/.test(mid)) return <NotDeployed />;
  return <MandatePage dep={dep.data} id={BigInt(mid)} />;
}

function PageSkeleton() {
  return (
    <div className="wrap stack-lg" style={{ padding: '64px var(--gutter)' }} aria-busy="true">
      <Skeleton h={22} w={200} />
      <Skeleton h={56} w="60%" />
      <div className="grid-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} h={88} />
        ))}
      </div>
      <Skeleton h={240} />
    </div>
  );
}

function NotDeployed() {
  return (
    <div className="wrap stack-lg" style={{ padding: '80px var(--gutter)' }}>
      <p className="kicker">Testnet mandate</p>
      <h1 className="h1">Not deployed yet.</h1>
      <Notice tone="warn" title="The testnet contracts have not been published">
        <p className="small" style={{ margin: '4px 0 0' }}>
          This page reads the live mandate straight from Elysium testnet and the owner’s account straight from Hyperliquid
          testnet. It shows nothing until the deployment record exists. Current status and remaining steps are on the{' '}
          <Link to="/proof">proof page</Link>.
        </p>
      </Notice>
    </div>
  );
}

function MandatePage({ dep, id }: { dep: Deployment; id: bigint }) {
  const now = useNow(1000);
  const m = usePoll(() => readMandate(dep, id), 6_000, [id]);
  const owner = m.data?.identity.hlAccount;
  const coin = dep.market?.coin ?? 'PURR/USDC';
  const ex = usePoll(
    async () => {
      if (!owner) return null;
      const [open, bal] = await Promise.all([hl.openOrders(owner), hl.balances(owner)]);
      return { open: open.filter((o) => o.coin === coin), bal: bal.balances, at: Date.now() };
    },
    6_000,
    [owner],
  );
  const [events, setEvents] = useState<DeskEvent[]>();
  const [evErr, setEvErr] = useState<string>();
  const [evPct, setEvPct] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () =>
      loadEvents(dep, id, (p) => live && setEvPct(p))
        .then(async (evs) => {
          // Block times for the most recent history only (bounded RPC work).
          const recent = evs.slice(-120);
          await Promise.all(recent.map(async (e) => (e.time = await blockTime(e.block))));
          if (live) setEvents([...evs]);
        })
        .catch((e) => live && setEvErr(String(e.message ?? e)));
    load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [dep, id]);

  if (m.error && !m.data) {
    if (m.error.includes('does not exist')) {
      return (
        <div className="wrap stack-lg" style={{ padding: '80px var(--gutter)' }}>
          <h1 className="h1">Mandate #{id.toString()} not found.</h1>
          <p className="body">No mandate with this id exists on the deployed registry.</p>
          <Link to="/mandate" className="btn ghost">
            Go to the featured mandate
          </Link>
        </div>
      );
    }
    return (
      <div className="wrap" style={{ padding: '64px var(--gutter)' }}>
        <LoadError what="the mandate from Elysium" error={m.error} retry={m.refresh} />
      </div>
    );
  }
  if (!m.data) return <PageSkeleton />;
  const v = m.data;
  void NotFound;
  return (
    <div className="wrap stack-lg" style={{ padding: 'clamp(40px, 6vw, 72px) var(--gutter) 96px' }}>
      <Header v={v} dep={dep} coin={coin} updatedAt={m.updatedAt} stale={!!m.error} now={now} />
      <DecisionStrip v={v} events={events} now={now} />
      <OrdersSection v={v} open={ex.data?.open} exErr={ex.error} exAt={ex.data?.at} />
      <ExposureSection v={v} bal={ex.data?.bal} />
      <PnlSection v={v} />
      <ThresholdSection v={v} now={now} />
      <HistorySection events={events} error={evErr} pct={evPct} />
      <PolicySection dep={dep} v={v} />
    </div>
  );
}

function Header({ v, dep, coin, updatedAt, stale, now }: { v: MandateView; dep: Deployment; coin: string; updatedAt?: number; stale: boolean; now: number }) {
  return (
    <header className="stack">
      <div className="row" style={{ gap: 10 }}>
        <p className="kicker">Public mandate · Hyperliquid testnet · Elysium testnet</p>
      </div>
      <div className="spread" style={{ alignItems: 'flex-end' }}>
        <h1 className="h1">
          {coin} <span style={{ color: 'var(--muted)' }}>#{v.id.toString()}</span>
        </h1>
        <span className="small mono" aria-live="polite">
          {stale ? 'Connection problem, showing last data · ' : ''}
          Updated {updatedAt ? ago(updatedAt / 1000, now / 1000) : '—'} · block {v.block.toString()}
        </span>
      </div>
      <StateBadge state={v.state} withText />
      {v.halt !== 'NONE' && v.state === 'ACTIVE' && (
        <Notice tone="warn" title={`Quoting paused by a safety rule: ${v.halt.toLowerCase().replace('_', ' ')}`}>
          <p className="small" style={{ margin: '4px 0 0' }}>{HALT_TEXT[v.halt]}</p>
        </Notice>
      )}
      <dl className="kv" style={{ maxWidth: 720, marginTop: 8 }}>
        <dt>Owner’s HyperCore account (holds the capital)</dt>
        <dd>
          <ExtLink href={hlAccount(v.identity.hlAccount)}>{shortAddr(v.identity.hlAccount)}</ExtLink>
        </dd>
        <dt>Policy version in force</dt>
        <dd>
          v{v.activeVersion}
          {v.identity.pendingVersion ? ` · v${v.identity.pendingVersion} pending` : ''}
        </dd>
        <dt>Desk contract</dt>
        <dd>
          <ExtLink href={explorerAddr(dep.desk)}>{shortAddr(dep.desk)}</ExtLink>
        </dd>
        <dt>Keeper reporter · watcher</dt>
        <dd>
          {shortAddr(v.identity.operator)} · {shortAddr(v.identity.guardian)}
        </dd>
      </dl>
    </header>
  );
}

const HALT_TEXT: Record<string, string> = {
  STALE: 'The reference was too old, or the external book was empty or disagreed with the independent mark. Cancellations were requested; quoting resumes only after a fresh, reconciled observation with no unresolved orders.',
  VOLATILITY: 'Price moved more than the policy allows within its window. Quotes were pulled; they resume only after the calm period, with fresh data and a confirmed account state.',
  FEES: 'Prepaid service fees are exhausted or owed. No new placements. Cancellation never needs prepaid fees.',
  WATCHER: 'The independent watcher has not checked in within its timeout, so quoting fails closed until it does.',
  UNRECONCILED: 'Balances moved in a way not yet explained by reported fills. Waiting for reports; unresolved past the timeout means reconciliation is required.',
  VERSION_SWITCH: 'A new policy version is due. Orders placed under the old version are being cancelled before the switch.',
};

function DecisionStrip({ v, events, now }: { v: MandateView; events?: DeskEvent[]; now: number }) {
  const last = events?.filter((e) => e.name === 'Decision').at(-1);
  if (!events) return <Skeleton h={56} />;
  if (!last) {
    return (
      <Notice tone="info" title="No decisions yet">
        <p className="small" style={{ margin: '4px 0 0' }}>The contract has not processed an observation for this mandate.</p>
      </Notice>
    );
  }
  const a = last.args;
  const r = decisionReason(a, v.orders.length);
  const p = toRefPolicy(v.policy);
  const inv = BigInt(a.inventoryE8);
  const invPct = p.exposure.maxBaseE8 > p.exposure.minBaseE8 ? Number(((inv - p.exposure.minBaseE8) * 100n) / (p.exposure.maxBaseE8 - p.exposure.minBaseE8)) : 0;
  const unconfirmed = v.orders.filter((o) => o.state === 'INTENT_EMITTED' || o.state === 'SUBMISSION_UNKNOWN' || o.cancelRequestedAt > 0n).length;
  const skew = Number(a.skewBps);
  return (
    <section aria-labelledby="why" className="stack">
      <h2 id="why" className="kicker">
        Latest decision · why the book looks like this
      </h2>
      <div className="strip" role="group" aria-label="Latest decision">
        <span>
          Reference <span className="hl">{fmtPx(BigInt(a.midE8))}</span>, {(Number(a.refAgeMs) / 1000).toFixed(1)} s old
        </span>
        <span className="sep">→</span>
        <span>
          inventory {fmtE8(inv, 0)} ({invPct}% of range)
        </span>
        <span className="sep">→</span>
        <span>{skew === 0 ? 'no skew' : `quotes skewed ${skew > 0 ? 'down' : 'up'} ${Math.abs(skew)} bps`}</span>
        <span className="sep">→</span>
        <span>
          {Number(a.placed)} placed · {Number(a.cancelled)} cancel{Number(a.cancelled) === 1 ? '' : 's'} requested
        </span>
        <span className="sep">→</span>
        <span className="hl">{unconfirmed ? `${unconfirmed} awaiting exchange confirmation` : 'exchange state confirmed'}</span>
      </div>
      <p className="small" style={{ margin: 0 }}>
        <strong style={{ color: 'var(--ink)' }}>{r.code}</strong>: {r.text}. Observation #{a.seq.toString()} under policy v
        {a.policyVersion}, {last.time ? ago(last.time, now / 1000) : `block ${last.block}`} ·{' '}
        <ExtLink href={explorerTx(last.tx)}>{shortHash(last.tx)}</ExtLink>
      </p>
    </section>
  );
}

function OrdersSection({ v, open, exErr, exAt }: { v: MandateView; open?: HlOpenOrder[]; exErr?: string; exAt?: number }) {
  const [tab, setTab] = useState<'all' | 'unconfirmed' | 'unmatched'>('all');
  const byCloid = new Map((open ?? []).filter((o) => o.cloid).map((o) => [BigInt(o.cloid!).toString(), o]));
  const intentIds = new Set(v.orders.map((o) => o.cloid.toString()));
  const unmatched = (open ?? []).filter((o) => !o.cloid || !intentIds.has(BigInt(o.cloid).toString()));
  const rows = v.orders
    .slice()
    .sort((a, b) => (a.isBuy === b.isBuy ? a.level - b.level : a.isBuy ? -1 : 1))
    .filter((o) => tab !== 'unconfirmed' || o.state === 'INTENT_EMITTED' || o.state === 'SUBMISSION_UNKNOWN' || o.cancelRequestedAt > 0n);
  return (
    <section className="stack">
      <SectionHead kicker="Orders" title="Intended vs observed.">
        The left side is what the contract intends (Elysium). The right side is what Hyperliquid reports for the owner’s account,
        fetched by your browser directly from the exchange. Anything unconfirmed is labelled as such.
      </SectionHead>
      <div className="tabs" role="tablist" aria-label="Order views">
        {(
          [
            ['all', `All live intents (${v.orders.length})`],
            ['unconfirmed', 'Unconfirmed'],
            ['unmatched', `Exchange orders with no intent (${open ? unmatched.length : '…'})`],
          ] as const
        ).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {exErr && <LoadError what="the owner’s orders from Hyperliquid" error={exErr} />}
      {tab !== 'unmatched' ? (
        rows.length === 0 ? (
          <Notice tone="info" title={tab === 'all' ? 'No live intents' : 'Nothing unconfirmed'}>
            <p className="small" style={{ margin: '4px 0 0' }}>
              {tab === 'all'
                ? 'Every order the contract ever intended is confirmed filled, cancelled or rejected.'
                : 'Every live intent has a confirmed exchange outcome.'}
            </p>
          </Notice>
        ) : (
          <div className="table-wrap stackable" tabIndex={0} aria-label="Live intents">
            <table>
              <thead>
                <tr>
                  <th>Side</th>
                  <th className="r">Price</th>
                  <th className="r">Size (filled)</th>
                  <th>Contract says</th>
                  <th>Exchange says</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const x = byCloid.get(o.cloid.toString());
                  return (
                    <tr key={o.cloid.toString()}>
                      <td data-label="Side">
                        <Badge tone={o.isBuy ? 'ok' : 'bad'}>{o.isBuy ? 'Bid' : 'Ask'}</Badge> <span className="small">L{o.level + 1}</span>
                      </td>
                      <td data-label="Price" className="r mono">
                        {fmtPx(o.pxE8)}
                      </td>
                      <td data-label="Size" className="r mono">
                        {o.szLots.toString()} ({o.filledLots.toString()})
                      </td>
                      <td data-label="Contract">
                        <span className="mono small">{o.state.replace('_', ' ').toLowerCase()}</span>
                        {o.cancelRequestedAt > 0n && <div className="small">cancel requested, not yet confirmed</div>}
                      </td>
                      <td data-label="Exchange">
                        {!open ? (
                          <span className="small">loading…</span>
                        ) : x ? (
                          <span className="small">
                            <Badge tone="ok">resting</Badge> oid {x.oid} · {x.sz} left
                          </span>
                        ) : o.state === 'INTENT_EMITTED' || o.state === 'SUBMISSION_UNKNOWN' ? (
                          <span className="small">not seen yet (outcome pending)</span>
                        ) : (
                          <span className="small">not on the book now: awaiting reported outcome</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : !open ? (
        <Skeleton h={80} />
      ) : unmatched.length === 0 ? (
        <Notice tone="ok" title="No unexplained orders">
          <p className="small" style={{ margin: '4px 0 0' }}>
            Every open {v.orders.length || open.length ? '' : '(none) '}order on the owner’s account matches a live contract intent,
            as of {exAt ? new Date(exAt).toLocaleTimeString() : '—'}.
          </p>
        </Notice>
      ) : (
        <Notice tone="bad" title={`${unmatched.length} open order(s) on the account match no live intent`}>
          <ul className="small mono" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {unmatched.map((o) => (
              <li key={o.oid}>
                oid {o.oid} {o.side === 'B' ? 'bid' : 'ask'} {o.sz} @ {o.limitPx} {o.cloid ? `cloid ${o.cloid.slice(0, 12)}…` : '(no client id)'}
              </li>
            ))}
          </ul>
          <p className="small" style={{ margin: '6px 0 0' }}>
            The watcher reports this on-chain, which stops new exposure. It cannot undo trades. If the keeper key is suspected, the
            owner should revoke the agent first.
          </p>
        </Notice>
      )}
      <p className="small">
        Cancelled orders keep their <Term k="reservation" /> until the exchange confirms them. A cancel request alone never frees
        capacity. Client order ids are <span className="code">{v.orders[0] ? cloidHex(v.orders[0].cloid).slice(0, 14) + '…' : '0x…'}</span>{' '}
        style hashes of mandate, version and intent nonce.
      </p>
    </section>
  );
}

function ExposureSection({ v, bal }: { v: MandateView; bal?: { coin: string; total: string }[] }) {
  const p = toRefPolicy(v.policy);
  const base = bal ? parseScaled(bal.find((b) => b.coin === 'PURR')?.total ?? '0', 8) : undefined;
  const quote = bal ? parseScaled(bal.find((b) => b.coin === 'USDC')?.total ?? '0', 8) : undefined;
  const r = v.reservations;
  const lot = 10n ** BigInt(8 - p.market.szDecimals);
  const worstLong = base !== undefined ? base + BigInt(r.buyLots) * lot : undefined;
  const worstShort = base !== undefined ? base - BigInt(r.sellLots) * lot : undefined;
  return (
    <section className="stack">
      <SectionHead kicker="Exposure" title="Inventory and reserved exposure.">
        Worst case assumes every potentially executable order fills. Buys and sells never offset each other.
      </SectionHead>
      <div className="grid-4">
        <div className="card">
          <Stat label={<>Base <Term k="inventory" /> (observed)</>} value={base !== undefined ? fmtE8(base, 2) : '…'} sub={`baseline ${fmtE8(p.exposure.baselineBaseE8, 0)} · bounds ${fmtE8(p.exposure.minBaseE8, 0)}–${fmtE8(p.exposure.maxBaseE8, 0)}`} />
        </div>
        <div className="card">
          <Stat label="Worst case if all bids fill" value={worstLong !== undefined ? fmtE8(worstLong, 2) : '…'} sub={`${r.buyLots.toString()} lots reserved to buy · cap ${fmtE8(p.exposure.maxBaseE8, 0)}`} />
        </div>
        <div className="card">
          <Stat label="Worst case if all asks fill" value={worstShort !== undefined ? fmtE8(worstShort, 2) : '…'} sub={`${r.sellLots.toString()} lots reserved to sell · floor ${fmtE8(p.exposure.minBaseE8, 0)}`} />
        </div>
        <div className="card">
          <Stat label="Quote reserved for bids" value={fmtE8(BigInt(r.buyQuoteE8), 2)} sub={`budget ${fmtE8(p.exposure.quoteBudgetE8, 0)} · balance ${quote !== undefined ? fmtE8(quote, 2) : '…'} USDC`} />
        </div>
      </div>
      <div className="card stack">
        <div className="spread">
          <span className="small">Outstanding order value vs cap (includes orders awaiting cancellation)</span>
          <span className="mono small">
            {fmtE8(BigInt(r.notionalE8), 2)} / {fmtE8(p.exposure.maxOutstandingNotionalE8, 0)} USDC
          </span>
        </div>
        <Meter value={Number(BigInt(r.notionalE8) / 1_000_000n)} max={Number(p.exposure.maxOutstandingNotionalE8 / 1_000_000n)} label="Outstanding notional" />
        <p className="small" style={{ margin: 0 }}>
          The inventory bounds are a policy invariant under reconciled inputs and compliant execution. They are not an exchange-level
          restriction against a compromised key or unrelated trading on the account.
        </p>
      </div>
    </section>
  );
}

function PnlSection({ v }: { v: MandateView }) {
  const a = v.accounting;
  if (!a.snapshotTaken) {
    return (
      <section className="stack">
        <SectionHead kicker="Results" title="PnL and fees." />
        <Notice tone="info" title="No activation snapshot yet">
          <p className="small" style={{ margin: '4px 0 0' }}>PnL is measured from the first reconciled observation after activation.</p>
        </Notice>
      </section>
    );
  }
  const equityChange = -BigInt(a.lastLossE8);
  const exFees = BigInt(a.exchangeFeesQuoteEqE8);
  const svc = BigInt(a.serviceFeesCharged) * 100n; // tFEE has 6 decimals -> E8, treated 1:1 with USD (test asset)
  const gross = equityChange + exFees;
  const net = equityChange - svc;
  const unreal = (BigInt(a.posBaseE8) * BigInt(a.lastMarkE8)) / E8 - BigInt(a.costBasisE8);
  return (
    <section className="stack">
      <SectionHead kicker="Results" title="PnL and fees, measured.">
        Relative to the snapshot at activation, marked at the external-book mid of the last observation. Deposits and withdrawals
        cannot count as profit: unexplained balance changes pause the mandate instead.
      </SectionHead>
      <div className="grid-4">
        <div className="card">
          <Stat label="Gross trading PnL" value={`${fmtSigned(gross)}`} sub="before exchange and service fees, USDC" />
        </div>
        <div className="card">
          <Stat label="Exchange fees" value={fmtE8(exFees)} sub="USDC equivalent, from reported fills" />
        </div>
        <div className="card">
          <Stat label="Staple service fees" value={fmtE8(svc)} sub="test fee token, no value" />
        </div>
        <div className="card">
          <Stat label="Net PnL after all fees" value={fmtSigned(net)} sub={`${a.fillCount} fills · ${fmtE8(BigInt(a.executedNotionalE8))} executed`} />
        </div>
      </div>
      <dl className="kv card">
        <dt>Realised (average cost, after exchange fees)</dt>
        <dd>{fmtSigned(BigInt(a.realisedE8))}</dd>
        <dt>Unrealised on remaining position</dt>
        <dd>{fmtSigned(unreal)}</dd>
        <dt>Marking price · source</dt>
        <dd>{fmtPx(BigInt(a.lastMarkE8))} · external book mid at last observation</dd>
        <dt>Accounting epoch (activations so far)</dt>
        <dd>{a.epoch.toString()}</dd>
      </dl>
      <p className="small">Fee accrual is provisional until the next reconciled observation confirms the balances. Duplicate fill reports cannot charge twice.</p>
    </section>
  );
}

function ThresholdSection({ v, now }: { v: MandateView; now: number }) {
  const p = toRefPolicy(v.policy);
  const a = v.accounting;
  const loss = BigInt(a.lastLossE8 ?? 0n);
  const trig = p.risk.lossTriggerQuoteE8;
  const nowS = now / 1000;
  const beatAge = v.runtime.lastWatcherBeat ? nowS - Number(v.runtime.lastWatcherBeat) : Infinity;
  const refAge = v.runtime.lastSourceTimeMs ? nowS - Number(v.runtime.lastSourceTimeMs) / 1000 : Infinity;
  const tripped = BigInt(a.lossTriggeredAt ?? 0n) > 0n;
  return (
    <section className="stack">
      <SectionHead kicker="Safety" title="Shutdown thresholds and health." />
      <div className="grid-3">
        <div className="card stack">
          <Stat label={<Term k="loss trigger" />} value={`${fmtE8(loss > 0n ? loss : 0n)} / ${fmtE8(trig)}`} sub="measured loss vs trigger, USDC" />
          <Meter value={Number(loss > 0n ? loss : 0n)} max={Number(trig)} tone={loss * 2n > trig ? (loss >= trig ? 'bad' : 'warn') : undefined} label="Loss vs trigger" />
          {tripped && (
            <dl className="kv">
              <dt>Triggered</dt>
              <dd>{utc(a.lossTriggeredAt)}</dd>
              <dt>Loss at trigger</dt>
              <dd>{fmtE8(BigInt(a.lossAtTriggerE8))}</dd>
              <dt>Peak observed loss</dt>
              <dd>{fmtE8(BigInt(a.peakLossE8))}</dd>
              <dt>Overshoot beyond trigger</dt>
              <dd>{fmtE8(BigInt(a.peakLossE8) - trig)}</dd>
              <dt>Cancellations confirmed</dt>
              <dd>{BigInt(a.tripCancelConfirmedAt) > 0n ? utc(a.tripCancelConfirmedAt) : 'not yet'}</dd>
            </dl>
          )}
          <p className="small" style={{ margin: 0 }}>A trigger, not a cap. Loss can exceed it before detection, while cancelling, or afterwards on remaining inventory.</p>
        </div>
        <div className="card stack">
          <Stat
            label="Watcher health"
            value={Number.isFinite(beatAge) ? `${Math.round(beatAge)} s` : 'never'}
            sub={`since last on-chain check-in · timeout ${p.risk.watcherTimeoutSec} s`}
          />
          {beatAge > p.risk.watcherTimeoutSec ? <Badge tone="bad">stale: quoting fails closed</Badge> : <Badge tone="ok">checking in</Badge>}
          <Stat label="Reference age" value={Number.isFinite(refAge) ? `${refAge.toFixed(1)} s` : '—'} sub={`limit ${(p.risk.maxRefAgeMs / 1000).toFixed(0)} s, enforced by an independent timer`} />
        </div>
        <div className="card stack">
          <Stat label={<Term k="volatility" />} value={`${p.risk.volBps} bps / ${p.risk.volWindowSec} s`} sub={`calm period ${p.risk.calmSec} s before resuming`} />
          <Stat label="Expiry" value={utc(p.expiry).slice(0, 16)} sub={Number(p.expiry) > nowS ? `in ${Math.round((Number(p.expiry) - nowS) / 3600)} h` : 'reached'} />
          <Stat label="Prepaid service fees" value={`${fmtE8(BigInt(v.fees.balance) * 100n)}`} sub={`spent ${fmtE8(BigInt(v.fees.spent) * 100n)} · owed ${fmtE8(BigInt(v.fees.owed) * 100n)} (test token)`} />
        </div>
      </div>
      {(v.state !== 'ACTIVE' || v.halt !== 'NONE') && (
        <Notice tone="warn" title="Residual inventory keeps its market risk">
          <p className="small" style={{ margin: '4px 0 0' }}>
            Shutdown cancels orders. It does not sell inventory. Whatever the account holds after shutdown stays with the owner and
            keeps moving with the price until the owner acts.
          </p>
        </Notice>
      )}
    </section>
  );
}

const EVENT_TEXT: Record<string, (a: any) => string> = {
  StateChanged: (a) => `State ${STATE_NAMES[a.from]} → ${STATE_NAMES[a.to]} (${REASONS[a.reason]?.code ?? a.reason})`,
  HaltChanged: (a) => (HALT_NAMES[a.halt] === 'NONE' ? `Quoting resumed (${REASONS[a.reason]?.code ?? ''})` : `Quoting halted: ${HALT_NAMES[a.halt]}`),
  LossTriggered: (a) => `Loss trigger fired at ${fmtE8(BigInt(a.lossE8))} (threshold ${fmtE8(BigInt(a.thresholdE8))})`,
  MismatchReported: (a) => `Watcher reported a mismatch: ${a.detail}`,
  CancelOverdue: () => 'A cancellation was not confirmed in time and was requested again',
  LateFill: (a) => `Late fill ${a.fillId} applied after cancellation`,
  DuplicateIgnored: (a) => `Duplicate ${OUTCOME_NAMES[a.kind]} report ignored`,
  VersionActivated: (a) => `Policy v${a.version} took effect`,
  PolicyProposed: (a) => `Policy v${a.version} published (${a.riskIncreasing ? 'risk-increasing, 60 s notice' : 'immediate'})`,
  AgentRevocationObserved: () => 'Agent removal observed on HyperCore',
  FillApplied: (a) => `${a.isBuy ? 'Bought' : 'Sold'} ${a.szLots} @ ${fmtPx(BigInt(a.pxE8))} (fill ${a.fillId})`,
};
const STATE_NAMES = ['DRAFT', 'ACTIVE', 'PAUSING', 'PAUSED', 'TRIPPED', 'REVOKING', 'REVOKED', 'EXPIRING', 'EXPIRED', 'RECONCILIATION_REQUIRED'];
const HALT_NAMES = ['NONE', 'STALE', 'VOLATILITY', 'FEES', 'WATCHER', 'UNRECONCILED', 'VERSION_SWITCH'];
const OUTCOME_NAMES = ['NONE', 'ACK', 'UNKNOWN', 'REJECTED', 'FILL', 'CANCEL CONFIRMED', 'CANCEL REJECTED'];

function HistorySection({ events, error, pct }: { events?: DeskEvent[]; error?: string; pct: number }) {
  const [filter, setFilter] = useState<'safety' | 'fills' | 'decisions'>('safety');
  const list = useMemo(() => {
    if (!events) return [];
    const pick =
      filter === 'safety'
        ? (e: DeskEvent) => ['StateChanged', 'HaltChanged', 'LossTriggered', 'MismatchReported', 'CancelOverdue', 'LateFill', 'DuplicateIgnored', 'VersionActivated', 'PolicyProposed', 'AgentRevocationObserved'].includes(e.name)
        : filter === 'fills'
          ? (e: DeskEvent) => e.name === 'FillApplied'
          : (e: DeskEvent) => e.name === 'Decision';
    return events.filter(pick).slice(-60).reverse();
  }, [events, filter]);
  return (
    <section className="stack">
      <SectionHead kicker="History" title="Breakers, discrepancies and decisions.">
        Read from public contract events. Each entry links to its transaction.
      </SectionHead>
      <div className="tabs" role="tablist" aria-label="History filter">
        {(
          [
            ['safety', 'Safety and state'],
            ['fills', 'Fills'],
            ['decisions', 'Decisions'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>
            {l}
          </button>
        ))}
      </div>
      {error && <LoadError what="contract history" error={error} />}
      {!events && !error && <p className="small">Loading history… {pct}%</p>}
      {events && list.length === 0 && <p className="small">Nothing in this category yet.</p>}
      <ul className="timeline">
        {list.map((e) => (
          <li key={`${e.tx}-${e.logIndex}`}>
            <span className="mono small">{e.time ? utc(e.time) : `block ${e.block}`}</span>
            <span>
              {e.name === 'Decision' ? (
                <>
                  <strong>{decisionReason(e.args).code}</strong>: {decisionReason(e.args).text}. Mid {fmtPx(BigInt(e.args.midE8))}, ref age{' '}
                  {(Number(e.args.refAgeMs) / 1000).toFixed(1)} s, skew {Number(e.args.skewBps)} bps, {Number(e.args.placed)} placed / {Number(e.args.cancelled)} cancelled.
                </>
              ) : (
                (EVENT_TEXT[e.name]?.(e.args) ?? e.name)
              )}{' '}
              <ExtLink href={explorerTx(e.tx)} className="small">
                tx
              </ExtLink>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PolicySection({ dep, v }: { dep: Deployment; v: MandateView }) {
  const latest = Number(v.identity.latestVersion);
  const { data } = usePoll(
    async () => {
      const out = [] as { version: number; policy: Policy; createdAt: bigint; effectiveAt: bigint }[];
      for (let i = 1; i <= latest; i++) {
        const r = await readPolicy(dep, v.id, i);
        out.push({ version: i, policy: toRefPolicy(r.policy), createdAt: r.createdAt, effectiveAt: r.effectiveAt });
      }
      return out;
    },
    0,
    [latest, v.id],
  );
  const current = toRefPolicy(v.policy);
  return (
    <section className="stack">
      <SectionHead kicker="Terms" title={`Published policy v${v.activeVersion}.`}>
        Every edit creates a new public version. Risk-increasing edits wait at least 60 seconds, and the switch only happens after
        every order from the old version is confirmed terminal.
      </SectionHead>
      <div className="grid-2">
        {(['Quotes', 'Exposure', 'Risk', 'Fees'] as const).map((g) => (
          <div className="card" key={g}>
            <p className="kicker" style={{ marginBottom: 12 }}>
              {g}
            </p>
            <dl className="kv">
              {POLICY_FIELDS.filter((f) => f.group === g).map((f) => (
                <FragmentKV key={f.key} k={f.label} v={f.get(current)} />
              ))}
            </dl>
          </div>
        ))}
      </div>
      {data && data.length > 1 && (
        <div className="stack">
          <h3 className="h3">Version history</h3>
          {data
            .slice(1)
            .reverse()
            .map((ver) => {
              const prev = data[ver.version - 2];
              const d = diffPolicies(prev.policy, ver.policy);
              return (
                <div className="card stack" key={ver.version}>
                  <div className="spread">
                    <strong>
                      v{ver.version - 1} → v{ver.version}
                    </strong>
                    <span className="small mono">
                      published {utc(ver.createdAt)} · effective from {utc(ver.effectiveAt)}
                    </span>
                  </div>
                  {d.length === 0 ? (
                    <p className="small">No field changes.</p>
                  ) : (
                    <div className="table-wrap stackable">
                      <table>
                        <thead>
                          <tr>
                            <th>Field</th>
                            <th className="r">Before</th>
                            <th className="r">After</th>
                            <th>Risk</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.map((x) => (
                            <tr key={x.key}>
                              <td data-label="Field">{x.label}</td>
                              <td data-label="Before" className="r mono">
                                {x.from}
                              </td>
                              <td data-label="After" className="r mono">
                                {x.to}
                              </td>
                              <td data-label="Risk">{x.riskIncreasing ? <Badge tone="warn">increases risk</Badge> : <Badge tone="info">reduces or neutral</Badge>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </section>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
