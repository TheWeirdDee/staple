import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Hex } from 'viem';
import { MandateRegistryAbi, StapleDeskAbi, TestFeeTokenAbi } from '@staple/reference/abi';
import { diffPolicies, validatePolicy, type Policy } from '@staple/reference';
import { Arrow, Badge, ExtLink, LoadError, Notice, SectionHead, Skeleton, StateBadge, Term } from '../components/ui';
import { WalletGate } from './Console';
import { HL_APP, explorerTx, hlAccount, type Deployment } from '../lib/config';
import { pub, readMandate, type MandateView } from '../lib/desk';
import { hl } from '../lib/hl';
import { ZERO, ownerApproveAgent } from '../lib/hlWrite';
import { toChainArgs, toRefPolicy } from '../lib/policy';
import { fmtE8, shortAddr, shortHash } from '../lib/format';
import { usePoll } from '../lib/usePoll';
import { friendly, sendTx, useWallet } from '../lib/wallet';

type Phase = { phase: 'idle' | 'signing' | 'submitted' | 'confirmed' | 'failed'; hash?: string; error?: string };

/** One consequential action: guarded against double submission, with submitted vs confirmed shown separately. */
function useAction() {
  const [s, setS] = useState<Phase>({ phase: 'idle' });
  const busy = s.phase === 'signing' || s.phase === 'submitted';
  async function run(fn: (onSubmitted: (h: string) => void) => Promise<string | void>) {
    if (busy) return;
    setS({ phase: 'signing' });
    try {
      const h = await fn((hash) => setS({ phase: 'submitted', hash }));
      setS({ phase: 'confirmed', hash: h || undefined });
    } catch (e) {
      setS({ phase: 'failed', error: friendly(e) });
    }
  }
  return { s, busy, run, reset: () => setS({ phase: 'idle' }) };
}

function ActionStatus({ s, confirmedText }: { s: Phase; confirmedText: string }) {
  if (s.phase === 'idle') return null;
  if (s.phase === 'failed')
    return (
      <Notice tone="bad" title="Not completed">
        <p className="small" style={{ margin: '4px 0 0' }}>{s.error}</p>
      </Notice>
    );
  if (s.phase === 'signing') return <p className="small" aria-live="polite">Waiting for your wallet…</p>;
  return (
    <p className="small" aria-live="polite">
      {s.phase === 'submitted' ? 'Submitted, waiting for confirmation… ' : `${confirmedText} `}
      {s.hash && s.hash.startsWith('0x') && s.hash.length === 66 && <ExtLink href={explorerTx(s.hash)}>{shortHash(s.hash)}</ExtLink>}
    </p>
  );
}

export function Manage() {
  const { id } = useParams();
  return (
    <div className="wrap stack-lg" style={{ padding: 'clamp(40px, 6vw, 72px) var(--gutter) 96px' }}>
      <p className="kicker">
        <Link to="/console">Owner console</Link> / Mandate #{id}
      </p>
      <WalletGate>{(addr, dep) => <ManageInner addr={addr} dep={dep} id={BigInt(id ?? '0')} />}</WalletGate>
    </div>
  );
}

function ManageInner({ addr, dep, id }: { addr: Hex; dep: Deployment; id: bigint }) {
  const m = usePoll(() => readMandate(dep, id), 5_000, [id]);
  const account = m.data?.identity.hlAccount;
  const coin = dep.market?.coin ?? 'PURR/USDC';
  const ex = usePoll(
    async () => {
      if (!account) return null;
      const [agents, open, bal] = await Promise.all([hl.agents(account), hl.openOrders(account), hl.balances(account)]);
      return { agents, open: open.filter((o) => o.coin === coin), bal: bal.balances };
    },
    6_000,
    [account],
  );
  if (m.error && !m.data) return <LoadError what={`mandate #${id}`} error={m.error} retry={m.refresh} />;
  if (!m.data) return <Skeleton h={200} />;
  const v = m.data;
  const isOwner = v.identity.owner.toLowerCase() === addr.toLowerCase();
  const name = `staple-${id}`;
  const keeperAgent = dep.keeperAgent?.toLowerCase();
  const agentListed = !!ex.data?.agents.some((a) => a.address.toLowerCase() === keeperAgent);
  const refresh = () => {
    m.refresh();
    ex.refresh();
  };

  return (
    <div className="stack-lg">
      <header className="stack">
        <div className="spread">
          <h1 className="h1">Mandate #{id.toString()}</h1>
          <Link to={`/mandate/${id}`} className="btn ghost sm">
            Public page <Arrow />
          </Link>
        </div>
        <StateBadge state={v.state} withText />
        {!isOwner && (
          <Notice tone="warn" title="You are not the owner of this mandate">
            <p className="small" style={{ margin: '4px 0 0' }}>
              Connected {shortAddr(addr)}; owner is {shortAddr(v.identity.owner)}. Actions will be rejected by the contract.
            </p>
          </Notice>
        )}
      </header>

      {(v.state === 'DRAFT' || v.state === 'PAUSED') && (
        <Setup v={v} dep={dep} addr={addr} name={name} agentListed={agentListed} agentsKnown={!!ex.data} onDone={refresh} />
      )}
      {['ACTIVE', 'PAUSING', 'TRIPPED', 'RECONCILIATION_REQUIRED', 'EXPIRING'].includes(v.state) && <Pause v={v} dep={dep} addr={addr} onDone={refresh} />}
      {(v.state === 'TRIPPED' || v.state === 'RECONCILIATION_REQUIRED') && <Rearm v={v} dep={dep} addr={addr} onDone={refresh} />}
      <Revoke v={v} dep={dep} addr={addr} name={name} ex={ex.data ?? undefined} agentListed={agentListed} onDone={refresh} />
      {v.state !== 'REVOKED' && v.state !== 'EXPIRED' && <EditPolicy v={v} dep={dep} addr={addr} onDone={refresh} />}
      <Fees v={v} dep={dep} addr={addr} onDone={refresh} />
    </div>
  );
}

// ---------------------------------------------------------------- setup

function Setup({ v, dep, addr, name, agentListed, agentsKnown, onDone }: { v: MandateView; dep: Deployment; addr: Hex; name: string; agentListed: boolean; agentsKnown: boolean; onDone: () => void }) {
  const w = useWallet();
  const approve = useAction();
  const activate = useAction();
  const [understood, setUnderstood] = useState(false);
  const feesReady = Number(v.policy.fees.feeBps) === 0 || BigInt(v.fees.balance) > 0n;
  const validUntil = Math.min(Number(v.policy.expiry) * 1000 + 86_400_000, Date.now() + 179 * 86_400_000);
  return (
    <section className="stack">
      <SectionHead kicker="Go live" title="Three steps before anything trades." />
      <ol className="steps">
        <li data-state={feesReady ? 'done' : 'active'}>
          <h3 className="h3">Prepay service fees</h3>
          <p className="body">
            Balance {fmtE8(BigInt(v.fees.balance) * 100n)} tFEE. Fees are held on Elysium, separate from your trading capital on
            Hyperliquid. Use the fee panel below.
          </p>
        </li>
        <li data-state={agentListed ? 'done' : feesReady ? 'active' : undefined}>
          <h3 className="h3">Approve the trading agent on Hyperliquid</h3>
          <div className="card stack" style={{ marginTop: 8 }}>
            <p className="kicker">What you are approving</p>
            <ul className="body" style={{ paddingLeft: 18, margin: 0 }}>
              <li>
                Agent <span className="code">{dep.keeperAgent ?? 'not configured'}</span>, named <span className="code">{name}</span>, may{' '}
                <strong>place and cancel orders</strong> on your HyperCore account <span className="code">{shortAddr(v.identity.hlAccount)}</span>.
              </li>
              <li>
                Hyperliquid enforces that an agent <strong>cannot withdraw or transfer</strong> your funds out of the account.
              </li>
              <li>
                It <strong>can technically trade outside Staple’s intents</strong>. The contract cannot stop that. The watcher detects it
                afterwards and stops new exposure; it cannot undo trades.
              </li>
              <li>
                Approval expires {new Date(validUntil).toUTCString()}. You can revoke it at any time from this page or from the Hyperliquid
                app with your own wallet.
              </li>
            </ul>
            <label className="row small" style={{ gap: 10, alignItems: 'flex-start' }}>
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} style={{ width: 20, height: 20 }} />
              I understand the agent can trade on this account and that pausing on Elysium does not revoke it.
            </label>
            <div className="row">
              <button
                className="btn primary"
                disabled={!understood || approve.busy || !dep.keeperAgent || !w.chainId}
                onClick={() =>
                  approve.run(async () => {
                    await ownerApproveAgent(addr, w.chainId!, dep.keeperAgent!, `${name} valid_until ${validUntil}`);
                    onDone();
                    return 'approved';
                  })
                }
              >
                {approve.busy ? 'Waiting for signature…' : agentListed ? 'Approve again' : 'Sign approval'} <Arrow />
              </button>
              <span className="small">
                {agentsKnown ? (agentListed ? <Badge tone="ok">Confirmed on Hyperliquid</Badge> : <Badge tone="info">Not approved yet</Badge>) : 'Checking Hyperliquid…'}
              </span>
            </div>
            <ActionStatus s={approve.s} confirmedText="Hyperliquid accepted the approval. Confirmation appears once it shows in the account’s agent list." />
            {addr.toLowerCase() !== v.identity.hlAccount.toLowerCase() && (
              <Notice tone="warn">The connected wallet is not the mandate’s HyperCore account; only that account can approve its agent.</Notice>
            )}
          </div>
        </li>
        <li data-state={v.state === 'ACTIVE' ? 'done' : agentListed && feesReady ? 'active' : undefined}>
          <h3 className="h3">Activate</h3>
          <p className="body">
            Activation snapshots your balances and starts quoting once the watcher checks in. You can pause at any time; pausing is
            confirmed only when the exchange confirms every cancellation.
          </p>
          {!agentListed && agentsKnown && <Notice tone="warn">The agent is not yet visible on Hyperliquid, so the keeper could not place orders.</Notice>}
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn primary"
              disabled={activate.busy || !feesReady}
              onClick={() =>
                activate.run(async (sub) => {
                  const h = await sendTx(addr, { address: dep.desk, abi: StapleDeskAbi, functionName: 'activate', args: [v.id] }, sub);
                  onDone();
                  return h;
                })
              }
            >
              {activate.busy ? 'Activating…' : 'Activate mandate'} <Arrow />
            </button>
          </div>
          <ActionStatus s={activate.s} confirmedText="Activated on Elysium." />
        </li>
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- pause

function Pause({ v, dep, addr, onDone }: { v: MandateView; dep: Deployment; addr: Hex; onDone: () => void }) {
  const a = useAction();
  const pending = v.orders.filter((o) => o.cancelRequestedAt > 0n).length;
  return (
    <section className="card stack">
      <div className="spread">
        <h2 className="h3">Pause quoting</h2>
        {v.state === 'PAUSING' && <Badge tone="warn" pending long>{`${v.orders.length} orders awaiting confirmed cancellation`}</Badge>}
      </div>
      <p className="body">
        Pausing stops new quotes immediately at the policy layer and requests cancellation of every order. The mandate shows PAUSED
        only after the exchange confirms each one. Orders can still fill until then. Pausing does <strong>not</strong> revoke the agent.
      </p>
      {v.state !== 'PAUSING' && (
        <div className="row">
          <button
            className="btn"
            disabled={a.busy}
            onClick={() =>
              a.run(async (sub) => {
                const h = await sendTx(addr, { address: dep.desk, abi: StapleDeskAbi, functionName: 'pause', args: [v.id] }, sub);
                onDone();
                return h;
              })
            }
          >
            {a.busy ? 'Pausing…' : 'Pause and cancel orders'}
          </button>
        </div>
      )}
      <ActionStatus s={a.s} confirmedText={`Pause recorded on Elysium. ${pending || v.orders.length} cancellation(s) now wait for exchange confirmation.`} />
    </section>
  );
}

function Rearm({ v, dep, addr, onDone }: { v: MandateView; dep: Deployment; addr: Hex; onDone: () => void }) {
  const a = useAction();
  return (
    <section className="card stack">
      <h2 className="h3">Re-arm after reconciliation</h2>
      <p className="body">
        A {v.state === 'TRIPPED' ? 'loss trigger' : 'reconciliation failure'} stopped this mandate. Re-arming never resumes trading by
        itself: it moves the mandate to PAUSED, and a later activation takes a fresh balance snapshot. Check the public page’s history
        and the account on Hyperliquid first.
      </p>
      {v.orders.length > 0 && <Notice tone="warn">{v.orders.length} order(s) are not yet confirmed terminal. Re-arm becomes available once they are.</Notice>}
      <div className="row">
        <button
          className="btn ghost"
          disabled={a.busy || v.orders.length > 0}
          onClick={() =>
            a.run(async (sub) => {
              const h = await sendTx(addr, { address: dep.desk, abi: StapleDeskAbi, functionName: 'rearm', args: [v.id] }, sub);
              onDone();
              return h;
            })
          }
        >
          Re-arm to paused
        </button>
      </div>
      <ActionStatus s={a.s} confirmedText="Re-armed: mandate is PAUSED." />
    </section>
  );
}

// ------------------------------------------------------- cancel and revoke

function Revoke({
  v,
  dep,
  addr,
  name,
  ex,
  agentListed,
  onDone,
}: {
  v: MandateView;
  dep: Deployment;
  addr: Hex;
  name: string;
  ex?: { open: { oid: number }[]; bal: { coin: string; total: string }[] };
  agentListed: boolean;
  onDone: () => void;
}) {
  const w = useWallet();
  const s1 = useAction();
  const s3 = useAction();
  const s4 = useAction();
  const started = v.state === 'REVOKING' || v.state === 'REVOKED';
  const ordersGone = v.orders.length === 0 && (ex?.open.length ?? 1) === 0;
  const st = (done: boolean, active: boolean) => (done ? 'done' : active ? 'active' : undefined);
  const base = ex ? (ex.bal.find((b) => b.coin === (dep.market?.baseToken ?? 'PURR'))?.total ?? '0') : undefined;
  const quote = ex ? (ex.bal.find((b) => b.coin === (dep.market?.quoteToken ?? 'USDC'))?.total ?? '0') : undefined;
  return (
    <section className="stack" id="exit">
      <SectionHead kicker="Exit" title="Cancel all and revoke.">
        Five separate steps, each confirmed on its own. The exit stays visibly incomplete until every one is confirmed.
      </SectionHead>
      <Notice tone="warn" title="If you think the agent key is compromised">
        <p className="small" style={{ margin: '4px 0 0' }}>
          Do step 3 first: revoke the agent on Hyperliquid, then cancel any remaining orders yourself in the{' '}
          <ExtLink href={`${HL_APP}/trade`}>Hyperliquid app</ExtLink>. The usual order assumes a cooperative keeper. Revoking does not
          cancel resting orders.
        </p>
      </Notice>
      <ol className="steps">
        <li data-state={st(started, !started)}>
          <h3 className="h3">Stop the strategy and request cancellation</h3>
          <p className="small">An Elysium transaction. Requested, not yet confirmed by the exchange.</p>
          {!started && (
            <button
              className="btn danger sm"
              disabled={s1.busy}
              onClick={() =>
                s1.run(async (sub) => {
                  const h = await sendTx(addr, { address: dep.desk, abi: StapleDeskAbi, functionName: 'requestRevoke', args: [v.id] }, sub);
                  onDone();
                  return h;
                })
              }
            >
              Start cancel-and-revoke
            </button>
          )}
          <ActionStatus s={s1.s} confirmedText="Recorded. The keeper is now cancelling every order." />
        </li>
        <li data-state={st(started && ordersGone, started && !ordersGone)}>
          <h3 className="h3">Exchange confirms every order is gone</h3>
          <p className="small">
            Contract: {v.orders.length} live intent(s). Hyperliquid: {ex ? ex.open.length : '…'} open order(s) on the account. Fills during
            cancellation are reconciled before an order counts as terminal.
          </p>
          {started && !ordersGone && (
            <p className="small">If this does not clear within a minute, the keeper may be down. The watcher attempts emergency cancellation; you can also cancel directly on Hyperliquid.</p>
          )}
        </li>
        <li data-state={st(started && !agentListed && !!ex, started && ordersGone && agentListed)}>
          <h3 className="h3">Revoke the agent on Hyperliquid</h3>
          <p className="small">
            Signed with your wallet. Replaces the named agent <span className="code">{name}</span> with no address.{' '}
            {ex ? agentListed ? <Badge tone="warn">agent still approved</Badge> : <Badge tone="ok">agent not approved</Badge> : null}
          </p>
          {agentListed && (
            <button
              className="btn danger sm"
              disabled={s3.busy || !w.chainId}
              onClick={() =>
                s3.run(async () => {
                  await ownerApproveAgent(addr, w.chainId!, ZERO, name);
                  onDone();
                  return 'revoked';
                })
              }
            >
              Sign revocation
            </button>
          )}
          <ActionStatus s={s3.s} confirmedText="Hyperliquid accepted the request. Removal is confirmed when the agent disappears from the account’s list." />
        </li>
        <li data-state={st(v.state === 'REVOKED', started && !agentListed && !!ex)}>
          <h3 className="h3">Confirm authority removal on-chain</h3>
          <p className="small">The watcher reports this automatically once it sees the agent gone; you can also confirm it yourself.</p>
          {v.state === 'REVOKING' && !agentListed && ex && (
            <button
              className="btn sm"
              disabled={s4.busy}
              onClick={() =>
                s4.run(async (sub) => {
                  const h = await sendTx(addr, { address: dep.desk, abi: StapleDeskAbi, functionName: 'reportAgentRevoked', args: [v.id] }, sub);
                  onDone();
                  return h;
                })
              }
            >
              Record removal
            </button>
          )}
          <ActionStatus s={s4.s} confirmedText="Recorded on Elysium." />
        </li>
        <li data-state={st(v.state === 'REVOKED' && ordersGone, v.state === 'REVOKED')}>
          <h3 className="h3">Check what remains</h3>
          <p className="small">
            Open orders now: {ex ? ex.open.length : '…'}. <Term k="residual inventory">Residual inventory</Term>: {base ?? '…'}{' '}
            {dep.market?.baseToken ?? 'PURR'} and {quote ?? '…'} {dep.market?.quoteToken ?? 'USDC'} in{' '}
            <ExtLink href={hlAccount(v.identity.hlAccount)}>your account</ExtLink>. Staple does not sell inventory; it keeps its market risk until
            you act.
          </p>
        </li>
      </ol>
    </section>
  );
}

// ------------------------------------------------------------- edit policy

function EditPolicy({ v, dep, addr, onDone }: { v: MandateView; dep: Deployment; addr: Hex; onDone: () => void }) {
  const current = useMemo(() => toRefPolicy(v.policy), [v.policy]);
  const [spread, setSpread] = useState(String(current.quotes.spreadBps));
  const [size, setSize] = useState(String(current.quotes.sizeLots));
  const [levels, setLevels] = useState(String(current.quotes.levels));
  const [loss, setLoss] = useState(fmtE8(current.risk.lossTriggerQuoteE8, 2).replace(/,/g, ''));
  const [hours, setHours] = useState('');
  const a = useAction();
  const next: Policy | null = useMemo(() => {
    if (![spread, size, levels].every((x) => /^\d+$/.test(x)) || !/^\d+(\.\d{1,8})?$/.test(loss) || (hours && !/^\d+$/.test(hours))) return null;
    const [w, f = ''] = loss.split('.');
    return {
      ...current,
      quotes: { ...current.quotes, spreadBps: Number(spread), sizeLots: BigInt(size), levels: Number(levels) },
      risk: { ...current.risk, lossTriggerQuoteE8: BigInt(w) * 100_000_000n + BigInt(f.padEnd(8, '0') || '0') },
      expiry: hours ? BigInt(Math.floor(Date.now() / 1000) + Number(hours) * 3600) : current.expiry,
    };
  }, [spread, size, levels, loss, hours, current]);
  const invalid = next ? validatePolicy(next, BigInt(Math.floor(Date.now() / 1000))) : 'input';
  const diff = next ? diffPolicies(current, next) : [];
  const risky = diff.some((d) => d.riskIncreasing);
  return (
    <section className="stack">
      <SectionHead kicker="Edit" title="Publish a new policy version.">
        Edits are public and versioned. Risk-reducing changes apply at once; risk-increasing ones wait at least 60 seconds. Either way
        the switch happens only after every order from the old version is confirmed terminal.
      </SectionHead>
      <div className="grid-4">
        {(
          [
            ['Target spread (bps)', spread, setSpread],
            ['Size per level', size, setSize],
            ['Levels per side', levels, setLevels],
            ['Loss trigger (USDC)', loss, setLoss],
          ] as const
        ).map(([label, val, set]) => (
          <div className="field" key={label}>
            <label htmlFor={`e-${label}`}>{label}</label>
            <input id={`e-${label}`} value={val} inputMode="decimal" onChange={(e) => set(e.target.value)} />
          </div>
        ))}
      </div>
      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="e-exp">New expiry, hours from now (optional)</label>
        <input id="e-exp" value={hours} inputMode="numeric" onChange={(e) => setHours(e.target.value)} />
      </div>
      {diff.length > 0 && (
        <div className="table-wrap stackable" aria-label="Changes">
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th className="r">Now</th>
                <th className="r">New</th>
                <th>Effect</th>
              </tr>
            </thead>
            <tbody>
              {diff.map((d) => (
                <tr key={d.key}>
                  <td data-label="Field">{d.label}</td>
                  <td data-label="Now" className="r mono">{d.from}</td>
                  <td data-label="New" className="r mono">{d.to}</td>
                  <td data-label="Effect">{d.riskIncreasing ? <Badge tone="warn">increases risk: 60 s notice</Badge> : <Badge tone="info">immediate</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {invalid && invalid !== 'input' && <Notice tone="bad">The new version would be rejected: {invalid}.</Notice>}
      <div className="row">
        <button
          className="btn"
          disabled={a.busy || !next || !!invalid || diff.length === 0}
          onClick={() =>
            a.run(async (sub) => {
              const h = await sendTx(addr, { address: dep.registry, abi: MandateRegistryAbi, functionName: 'proposePolicy', args: [v.id, toChainArgs(next!)] }, sub);
              onDone();
              return h;
            })
          }
        >
          {risky ? 'Publish with 60 s notice' : 'Publish version'}
        </button>
      </div>
      <ActionStatus s={a.s} confirmedText="New version published." />
    </section>
  );
}

// ------------------------------------------------------------------- fees

function Fees({ v, dep, addr, onDone }: { v: MandateView; dep: Deployment; addr: Hex; onDone: () => void }) {
  const a = useAction();
  const bal = usePoll(() => pub.readContract({ address: dep.feeToken, abi: TestFeeTokenAbi as any, functionName: 'balanceOf', args: [addr] }) as Promise<bigint>, 10_000, [addr]);
  const amount = 20_000_000n; // 20 tFEE (6 decimals)
  return (
    <section className="card stack">
      <h2 className="h3">Prepaid service fees</h2>
      <p className="body">
        Balance on this mandate: {fmtE8(BigInt(v.fees.balance) * 100n)} · spent {fmtE8(BigInt(v.fees.spent) * 100n)} · owed{' '}
        {fmtE8(BigInt(v.fees.owed) * 100n)} tFEE. Your wallet holds {bal.data !== undefined ? fmtE8(bal.data * 100n) : '…'} tFEE.
      </p>
      <p className="small">
        tFEE is a freely mintable testnet token with no value, used because no verified USDC funding path to Elysium testnet was available.
        Unspent balance can be withdrawn by the owner at any time.
      </p>
      <div className="row">
        <button
          className="btn ghost sm"
          disabled={a.busy}
          onClick={() =>
            a.run(async (sub) => {
              const h = await sendTx(addr, { address: dep.feeToken, abi: TestFeeTokenAbi, functionName: 'faucet', args: [] }, sub);
              bal.refresh();
              return h;
            })
          }
        >
          Get 100 test tFEE
        </button>
        <button
          className="btn sm"
          disabled={a.busy || (bal.data ?? 0n) < amount}
          onClick={() =>
            a.run(async (sub) => {
              await sendTx(addr, { address: dep.feeToken, abi: TestFeeTokenAbi, functionName: 'approve', args: [dep.registry, amount] }, sub);
              const h = await sendTx(addr, { address: dep.registry, abi: MandateRegistryAbi, functionName: 'depositFees', args: [v.id, amount] }, sub);
              onDone();
              bal.refresh();
              return h;
            })
          }
        >
          Deposit 20 tFEE
        </button>
        <button
          className="btn link sm"
          disabled={a.busy || BigInt(v.fees.balance) === 0n}
          onClick={() =>
            a.run(async (sub) => {
              const h = await sendTx(addr, { address: dep.registry, abi: MandateRegistryAbi, functionName: 'withdrawFees', args: [v.id, BigInt(v.fees.balance)] }, sub);
              onDone();
              return h;
            })
          }
        >
          Withdraw unspent
        </button>
      </div>
      <ActionStatus s={a.s} confirmedText="Done." />
    </section>
  );
}
