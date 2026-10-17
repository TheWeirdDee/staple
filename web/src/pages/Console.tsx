import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Hex } from 'viem';
import { MandateRegistryAbi } from '@staple/reference/abi';
import { MAX_LEVELS, VALIDATION_HELP, campaignPolicy, validatePolicy, type Policy } from '@staple/reference';
import { Arrow, ExtLink, LoadError, Notice, SectionHead, Skeleton, StateBadge, Term } from '../components/ui';
import { elysiumTestnet, explorerTx, loadDeployment, type Deployment } from '../lib/config';
import { mandatesOf, readMandate } from '../lib/desk';
import { fmtE8, parseDec, shortAddr, shortHash } from '../lib/format';
import { toChainArgs } from '../lib/policy';
import { usePoll } from '../lib/usePoll';
import { friendly, sendTx, useWallet } from '../lib/wallet';

export function WalletGate({ children }: { children: (addr: Hex, dep: Deployment) => React.ReactNode }) {
  const w = useWallet();
  const dep = usePoll(loadDeployment, 0);
  if (dep.loading) return <Skeleton h={120} />;
  if (!dep.data)
    return (
      <Notice tone="warn" title="Contracts not deployed yet">
        <p className="small" style={{ margin: '4px 0 0' }}>
          The owner console needs the Elysium testnet deployment record. See the <Link to="/proof">proof page</Link> for status.
        </p>
      </Notice>
    );
  if (!w.address)
    return (
      <div className="card stack" style={{ maxWidth: 640 }}>
        <h2 className="h3">Connect the owner wallet</h2>
        <p className="body">
          The console signs two kinds of things with your wallet: Elysium transactions (create, fund, activate, pause, edit) and,
          separately, the Hyperliquid approval for the trading <Term k="agent" />. Nothing is signed without a wallet prompt you
          can read first.
        </p>
        {w.error && <Notice tone="bad">{w.error}</Notice>}
        {!w.available && (
          <Notice tone="info" title="No browser wallet detected">
            <p className="small" style={{ margin: '4px 0 0' }}>
              Install a wallet extension, or keep browsing read-only: the <Link to="/mandate">public mandate</Link> needs no wallet.
            </p>
          </Notice>
        )}
        <div className="row">
          <button className="btn primary" onClick={w.connect} disabled={w.connecting || !w.available}>
            {w.connecting ? 'Waiting for wallet…' : 'Connect wallet'} <Arrow />
          </button>
        </div>
      </div>
    );
  if (!w.onRightChain)
    return (
      <div className="card stack" style={{ maxWidth: 640 }}>
        <h2 className="h3">Switch to Elysium testnet</h2>
        <p className="body">
          Your wallet is on chain {w.chainId ?? 'unknown'}. Staple’s contracts are on {elysiumTestnet.name} (chain id {elysiumTestnet.id}). Switching
          only changes the network your wallet talks to; it does not move funds.
        </p>
        {w.error && <Notice tone="bad">{w.error}</Notice>}
        <div className="row">
          <button className="btn primary" onClick={w.switchToElysium}>
            Switch network <Arrow />
          </button>
        </div>
      </div>
    );
  return <>{children(w.address, dep.data)}</>;
}

export function Console() {
  return (
    <div className="wrap stack-lg" style={{ padding: 'clamp(40px, 6vw, 72px) var(--gutter) 96px' }}>
      <header className="stack">
        <p className="kicker">Owner console · Elysium testnet</p>
        <h1 className="h1">Run a mandate from your own account.</h1>
        <p className="lede">Draft the rules, approve a trade-only agent, activate, and stop with confirmed outcomes.</p>
      </header>
      <WalletGate>{(addr, dep) => <ConsoleHome addr={addr} dep={dep} />}</WalletGate>
    </div>
  );
}

function ConsoleHome({ addr, dep }: { addr: Hex; dep: Deployment }) {
  const list = usePoll(async () => {
    const ids = await mandatesOf(dep, addr);
    return Promise.all(ids.map((id) => readMandate(dep, id)));
  }, 20_000, [addr]);
  return (
    <div className="stack-lg">
      <section className="stack">
        <SectionHead kicker="Your mandates" title="Mandates you own." />
        {list.error && <LoadError what="your mandates" error={list.error} retry={list.refresh} />}
        {list.loading && !list.data && <Skeleton h={64} />}
        {list.data?.length === 0 && <p className="body">You don’t own any mandates on this deployment yet. Draft one below.</p>}
        <div className="grid-2">
          {list.data?.map((m) => (
            <Link key={m.id.toString()} to={`/console/${m.id}`} className="card stack" style={{ textDecoration: 'none' }}>
              <div className="spread">
                <strong className="h3">Mandate #{m.id.toString()}</strong>
                <StateBadge state={m.state} />
              </div>
              <span className="small">
                v{m.activeVersion} · {m.orders.length} live intents · account {shortAddr(m.identity.hlAccount)}
              </span>
              <span className="small" style={{ color: 'var(--accent)' }}>
                Manage <Arrow />
              </span>
            </Link>
          ))}
        </div>
      </section>
      <NewMandate addr={addr} dep={dep} />
    </div>
  );
}

// --------------------------------------------------------------- draft form

interface Draft {
  spreadBps: string;
  levels: string;
  levelSpacingBps: string;
  sizeLots: string;
  skewBps: string;
  requoteBps: string;
  bookRule: 'JOIN' | 'STAY_OUT';
  baseline: string;
  minBase: string;
  maxBase: string;
  quoteBudget: string;
  maxOutstanding: string;
  feeAllowanceBps: string;
  lossTrigger: string;
  volBps: string;
  volWindowSec: string;
  calmSec: string;
  maxRefAgeSec: string;
  maxDeviationBps: string;
  reconTimeoutSec: string;
  cancelTimeoutSec: string;
  watcherTimeoutSec: string;
  feeBps: string;
  spendCap: string;
  expiryHours: string;
  operator: string;
  guardian: string;
  hlAccount: string;
}

const DRAFT_KEY = 'staple.draft.v1';

function defaultDraft(addr: Hex, dep: Deployment): Draft {
  const p = campaignPolicy(0n);
  const e = (v: bigint) => fmtE8(v, 8).replace(/,/g, '').replace(/\.?0+$/, '');
  return {
    spreadBps: `${p.quotes.spreadBps}`,
    levels: `${p.quotes.levels}`,
    levelSpacingBps: `${p.quotes.levelSpacingBps}`,
    sizeLots: `${p.quotes.sizeLots}`,
    skewBps: `${p.quotes.skewBps}`,
    requoteBps: `${p.quotes.requoteBps}`,
    bookRule: p.quotes.bookRule,
    baseline: e(p.exposure.baselineBaseE8),
    minBase: e(p.exposure.minBaseE8),
    maxBase: e(p.exposure.maxBaseE8),
    quoteBudget: e(p.exposure.quoteBudgetE8),
    maxOutstanding: e(p.exposure.maxOutstandingNotionalE8),
    feeAllowanceBps: `${p.exposure.feeAllowanceBps}`,
    lossTrigger: e(p.risk.lossTriggerQuoteE8),
    volBps: `${p.risk.volBps}`,
    volWindowSec: `${p.risk.volWindowSec}`,
    calmSec: `${p.risk.calmSec}`,
    maxRefAgeSec: `${p.risk.maxRefAgeMs / 1000}`,
    maxDeviationBps: `${p.risk.maxDeviationBps}`,
    reconTimeoutSec: `${p.risk.reconTimeoutSec}`,
    cancelTimeoutSec: `${p.risk.cancelTimeoutSec}`,
    watcherTimeoutSec: `${p.risk.watcherTimeoutSec}`,
    feeBps: `${p.fees.feeBps}`,
    spendCap: '20',
    expiryHours: '48',
    operator: dep.keeperOperator ?? '',
    guardian: dep.watcherGuardian ?? '',
    hlAccount: addr,
  };
}

export function draftToPolicy(d: Draft, dep: Deployment, nowSec: bigint): { policy?: Policy; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const int = (k: keyof Draft, min = 0, max = 1_000_000) => {
    const v = Number(d[k]);
    if (!/^\d+$/.test(String(d[k])) || v < min || v > max) errors[k] = `Whole number between ${min} and ${max}.`;
    return v;
  };
  const dec = (k: keyof Draft) => {
    const v = parseDec(String(d[k]), 8);
    if (v === null) errors[k] = 'Enter a number with at most 8 decimals.';
    return v ?? 0n;
  };
  const m = dep.market ?? { asset: 10000, szDecimals: 0 };
  const policy: Policy = {
    market: { asset: m.asset, szDecimals: m.szDecimals, isSpot: true, minNotionalE8: 10_00000000n },
    quotes: {
      spreadBps: int('spreadBps', 1, 5000),
      levels: int('levels', 1, MAX_LEVELS),
      levelSpacingBps: int('levelSpacingBps', 0, 5000),
      sizeLots: BigInt(int('sizeLots', 1, 10_000_000)),
      skewBps: int('skewBps', 0, 1000),
      requoteBps: int('requoteBps', 0, 5000),
      bookRule: d.bookRule,
    },
    exposure: {
      baselineBaseE8: dec('baseline'),
      minBaseE8: dec('minBase'),
      maxBaseE8: dec('maxBase'),
      quoteBudgetE8: dec('quoteBudget'),
      maxOutstandingNotionalE8: dec('maxOutstanding'),
      feeAllowanceBps: int('feeAllowanceBps', 0, 100),
    },
    risk: {
      lossTriggerQuoteE8: dec('lossTrigger'),
      volBps: int('volBps', 1, 10000),
      volWindowSec: int('volWindowSec', 1, 86400),
      calmSec: int('calmSec', 0, 86400),
      maxRefAgeMs: int('maxRefAgeSec', 1, 600) * 1000,
      maxDeviationBps: int('maxDeviationBps', 1, 10000),
      reconTimeoutSec: int('reconTimeoutSec', 1, 86400),
      cancelTimeoutSec: int('cancelTimeoutSec', 1, 86400),
      watcherTimeoutSec: int('watcherTimeoutSec', 1, 86400),
    },
    fees: { feeBps: int('feeBps', 0, 100), spendCap: (parseDec(d.spendCap, 6) ?? ((errors.spendCap = 'Enter a number.'), 0n)) as bigint },
    expiry: nowSec + BigInt(int('expiryHours', 1, 24 * 180)) * 3600n,
  };
  for (const k of ['operator', 'guardian', 'hlAccount'] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(d[k])) errors[k] = 'Enter a 0x… address.';
  }
  if (Object.keys(errors).length) return { errors };
  const v = validatePolicy(policy, nowSec);
  if (v) {
    const map: Record<string, keyof Draft> = {
      'quotes.levels': 'levels',
      'quotes.spreadBps': 'spreadBps',
      'quotes.levelSpacingBps': 'levelSpacingBps',
      'quotes.ladderWidth': 'levelSpacingBps',
      'quotes.sizeLots': 'sizeLots',
      'quotes.skewBps': 'skewBps',
      'quotes.requoteBps': 'requoteBps',
      'exposure.inventoryBounds': 'baseline',
      'exposure.maxOutstandingNotionalE8': 'maxOutstanding',
      'exposure.feeAllowanceBps': 'feeAllowanceBps',
      'risk.lossTriggerQuoteE8': 'lossTrigger',
      'risk.volatility': 'volBps',
      'risk.maxRefAgeMs': 'maxRefAgeSec',
      'risk.maxDeviationBps': 'maxDeviationBps',
      'risk.timeouts': 'reconTimeoutSec',
      'fees.feeBps': 'feeBps',
      expiry: 'expiryHours',
    };
    errors[map[v] ?? 'spreadBps'] = VALIDATION_HELP[v] ?? v;
    return { errors };
  }
  if (policy.quotes.sizeLots * 4n < 1n) errors.sizeLots = 'Too small.';
  return { policy, errors };
}

const FIELDS: { group: string; help: React.ReactNode; items: { k: keyof Draft; label: string; hint: string; unit?: string }[] }[] = [
  {
    group: 'Quotes',
    help: (
      <>
        How the <Term k="ladder" /> is built around the <Term k="reference" /> price.
      </>
    ),
    items: [
      { k: 'spreadBps', label: 'Target spread', hint: 'Full gap between your best bid and best ask. Prices round outward to valid ticks.', unit: 'bps' },
      { k: 'levels', label: 'Levels per side', hint: `How many orders on each side (1–${MAX_LEVELS}).` },
      { k: 'levelSpacingBps', label: 'Level spacing', hint: 'Extra distance between consecutive levels.', unit: 'bps' },
      { k: 'sizeLots', label: 'Size per level', hint: 'In whole tokens for this market. Each order must be worth at least $10.', unit: 'PURR' },
      { k: 'skewBps', label: 'Max inventory skew', hint: 'How far quotes lean when inventory sits at a bound.', unit: 'bps' },
      { k: 'requoteBps', label: 'Requote threshold', hint: 'Keep an order while it is within this distance of its target price.', unit: 'bps' },
    ],
  },
  {
    group: 'Exposure',
    help: <>Hard limits on what could be held if every live order filled.</>,
    items: [
      { k: 'baseline', label: 'Baseline inventory', hint: 'The holding the skew pulls back toward.', unit: 'PURR' },
      { k: 'minBase', label: 'Minimum inventory', hint: 'Never sell below this, counting every resting ask.', unit: 'PURR' },
      { k: 'maxBase', label: 'Maximum inventory', hint: 'Never buy above this, counting every resting bid.', unit: 'PURR' },
      { k: 'quoteBudget', label: 'Quote budget for bids', hint: 'Most USDC committed to bids at once (including a fee allowance).', unit: 'USDC' },
      { k: 'maxOutstanding', label: 'Max outstanding order value', hint: 'Both sides, including orders awaiting cancellation.', unit: 'USDC' },
      { k: 'feeAllowanceBps', label: 'Exchange fee allowance', hint: 'Added to bid reservations to cover exchange fees.', unit: 'bps' },
    ],
  },
  {
    group: 'Risk',
    help: <>Automatic shutdowns. They stop quoting and request cancellation; they do not cap losses.</>,
    items: [
      { k: 'lossTrigger', label: 'Loss trigger', hint: 'Stop quoting when measured loss reaches this. Loss can exceed it.', unit: 'USDC' },
      { k: 'volBps', label: 'Volatility trigger', hint: 'Pull quotes if the price moves this much within the window.', unit: 'bps' },
      { k: 'volWindowSec', label: 'Volatility window', hint: 'Length of the window the move is measured over.', unit: 's' },
      { k: 'calmSec', label: 'Calm period', hint: 'Wait this long after a volatility stop before resuming.', unit: 's' },
      { k: 'maxRefAgeSec', label: 'Max reference age', hint: 'Older data stops quoting, enforced by a timer even with no new data.', unit: 's' },
      { k: 'maxDeviationBps', label: 'Max deviation from mark', hint: 'Stop if the book mid disagrees with the exchange mark by more.', unit: 'bps' },
      { k: 'reconTimeoutSec', label: 'Reconciliation timeout', hint: 'Unknown outcomes or unexplained balances past this pause the mandate.', unit: 's' },
      { k: 'cancelTimeoutSec', label: 'Cancel retry timeout', hint: 'Request cancellation again if not confirmed within this.', unit: 's' },
      { k: 'watcherTimeoutSec', label: 'Watcher timeout', hint: 'Quoting fails closed if the watcher is silent this long.', unit: 's' },
    ],
  },
  {
    group: 'Fees and lifecycle',
    help: <>Service fees are prepaid on Elysium in a test token, separate from trading capital on HyperCore.</>,
    items: [
      { k: 'feeBps', label: 'Service fee', hint: 'Charged on executed notional. Unvalidated pricing hypothesis.', unit: 'bps' },
      { k: 'spendCap', label: 'Fee spending cap', hint: 'Most the mandate can ever spend on service fees.', unit: 'tFEE' },
      { k: 'expiryHours', label: 'Expires in', hint: 'An independent timer requests cancellation at expiry.', unit: 'hours' },
    ],
  },
  {
    group: 'Roles',
    help: <>Who reports data, who watches, and whose account holds the capital.</>,
    items: [
      { k: 'hlAccount', label: 'Your HyperCore account', hint: 'The account the agent trades for. Usually this wallet.' },
      { k: 'operator', label: 'Keeper reporter', hint: 'Signs observations and outcomes. Prefilled with Staple’s hosted keeper.' },
      { k: 'guardian', label: 'Watcher', hint: 'Independent watcher allowed to report mismatches and check in.' },
    ],
  },
];

function NewMandate({ addr, dep }: { addr: Hex; dep: Deployment }) {
  const nav = useNavigate();
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) return { ...defaultDraft(addr, dep), ...JSON.parse(saved) };
    } catch {
      /* storage unavailable: start from defaults */
    }
    return defaultDraft(addr, dep);
  });
  const [touched, setTouched] = useState(false);
  const [tx, setTx] = useState<{ phase: 'idle' | 'signing' | 'submitted' | 'confirmed' | 'failed'; hash?: Hex; error?: string }>({ phase: 'idle' });
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* ignore */
    }
  }, [draft]);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const { policy, errors } = useMemo(() => draftToPolicy(draft, dep, nowSec), [draft, dep, nowSec]);
  const busy = tx.phase === 'signing' || tx.phase === 'submitted';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!policy || busy) return;
    setTx({ phase: 'signing' });
    try {
      const hash = await sendTx(
        addr,
        { address: dep.registry, abi: MandateRegistryAbi, functionName: 'createMandate', args: [toChainArgs(policy), draft.operator, draft.guardian, draft.hlAccount] },
        (h) => setTx({ phase: 'submitted', hash: h }),
      );
      setTx({ phase: 'confirmed', hash });
      const ids = await mandatesOf(dep, addr);
      localStorage.removeItem(DRAFT_KEY);
      nav(`/console/${ids[ids.length - 1]}`);
    } catch (err) {
      setTx({ phase: 'failed', error: friendly(err) });
    }
  }

  return (
    <section className="stack">
      <SectionHead kicker="New mandate" title="Draft the public rules.">
        Everything here becomes public on Elysium as policy version 1. Your draft is saved in this browser until it is published.
      </SectionHead>
      <form onSubmit={submit} noValidate className="stack-lg">
        {FIELDS.map((g) => (
          <fieldset key={g.group}>
            <legend>{g.group}</legend>
            <p className="small" style={{ marginTop: 0 }}>
              {g.help}
            </p>
            <div className="grid-3">
              {g.items.map((f) => {
                const err = touched || draft[f.k] !== defaultDraft(addr, dep)[f.k] ? errors[f.k] : undefined;
                const id = `f-${f.k}`;
                return (
                  <div className="field" key={f.k} data-invalid={!!err}>
                    <label htmlFor={id}>
                      {f.label}
                      {f.unit ? <span className="small"> ({f.unit})</span> : null}
                    </label>
                    <input
                      id={id}
                      inputMode={['hlAccount', 'operator', 'guardian'].includes(f.k) ? 'text' : 'decimal'}
                      value={draft[f.k] as string}
                      aria-invalid={!!err}
                      aria-describedby={`${id}-h ${err ? `${id}-e` : ''}`}
                      onChange={(ev) => setDraft({ ...draft, [f.k]: ev.target.value })}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <span className="hint" id={`${id}-h`}>
                      {f.hint}
                    </span>
                    {err && (
                      <span className="err" id={`${id}-e`}>
                        {err}
                      </span>
                    )}
                  </div>
                );
              })}
              {g.group === 'Quotes' && (
                <div className="field">
                  <label htmlFor="f-bookRule">When the external book is already healthy</label>
                  <select id="f-bookRule" value={draft.bookRule} onChange={(ev) => setDraft({ ...draft, bookRule: ev.target.value as Draft['bookRule'] })}>
                    <option value="JOIN">Join without improving the best price</option>
                    <option value="STAY_OUT">Stay out of the book</option>
                  </select>
                  <span className="hint">“Healthy” means the external spread and depth already meet your target.</span>
                </div>
              )}
            </div>
          </fieldset>
        ))}
        <Notice tone="info" title="Before you publish">
          <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li>Publishing creates a public DRAFT. Nothing trades until you approve the agent on Hyperliquid and activate.</li>
            <li>Later edits create new public versions; risk-increasing edits wait 60 seconds.</li>
            <li>Use a dedicated HyperCore account. Other activity on it pauses the mandate for reconciliation.</li>
          </ul>
        </Notice>
        {tx.phase === 'failed' && (
          <Notice tone="bad" title="Not published">
            <p className="small" style={{ margin: '4px 0 0' }}>{tx.error} Your inputs are kept; fix and retry.</p>
          </Notice>
        )}
        {(tx.phase === 'submitted' || tx.phase === 'confirmed') && tx.hash && (
          <Notice tone={tx.phase === 'confirmed' ? 'ok' : 'info'} title={tx.phase === 'confirmed' ? 'Confirmed on Elysium' : 'Submitted, waiting for confirmation'}>
            <ExtLink href={explorerTx(tx.hash)}>{shortHash(tx.hash)}</ExtLink>
          </Notice>
        )}
        <div className="row" style={{ gap: 12 }}>
          <button type="submit" className="btn primary" disabled={busy}>
            {tx.phase === 'signing' ? 'Confirm in your wallet…' : tx.phase === 'submitted' ? 'Waiting for Elysium…' : 'Publish draft mandate'} <Arrow />
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setDraft(defaultDraft(addr, dep));
              setTouched(false);
            }}
            disabled={busy}
          >
            Reset to campaign defaults
          </button>
          {touched && !policy && <span className="err small" role="alert">Fix the highlighted fields first.</span>}
        </div>
      </form>
    </section>
  );
}
