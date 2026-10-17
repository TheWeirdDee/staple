import type { BookRule, ExposureParams, MarketParams, QuoteParams } from './quote.js';
import { MAX_LEVELS, parseScaled } from './quote.js';

export interface RiskParams {
  lossTriggerQuoteE8: bigint;
  volBps: number;
  volWindowSec: number;
  calmSec: number;
  maxRefAgeMs: number;
  maxDeviationBps: number;
  reconTimeoutSec: number;
  cancelTimeoutSec: number;
  watcherTimeoutSec: number;
}

export interface FeeParams {
  feeBps: number;
  spendCap: bigint;
}

export interface Policy {
  market: MarketParams;
  quotes: QuoteParams;
  exposure: ExposureParams;
  risk: RiskParams;
  fees: FeeParams;
  expiry: bigint;
}

export const MIN_NOTICE_SEC = 60;

/** Mirrors MandateRegistry.validatePolicy; returns the first failing field, or null. */
export function validatePolicy(p: Policy, nowSec: bigint): string | null {
  const { market: m, quotes: q, exposure: e, risk: r } = p;
  if (!m.isSpot) return 'market.isSpot';
  if (m.asset < 10000) return 'market.asset';
  if (m.szDecimals > 8) return 'market.szDecimals';
  if (q.levels < 1 || q.levels > MAX_LEVELS) return 'quotes.levels';
  if (q.spreadBps < 1 || q.spreadBps > 5000) return 'quotes.spreadBps';
  if (q.levels > 1 && q.levelSpacingBps === 0) return 'quotes.levelSpacingBps';
  if (q.spreadBps + 2 * (q.levels - 1) * q.levelSpacingBps >= 20_000) return 'quotes.ladderWidth';
  if (q.sizeLots <= 0n) return 'quotes.sizeLots';
  if (q.skewBps > 1000) return 'quotes.skewBps';
  if (q.requoteBps >= q.spreadBps) return 'quotes.requoteBps';
  if (!(e.minBaseE8 <= e.baselineBaseE8 && e.baselineBaseE8 <= e.maxBaseE8)) return 'exposure.inventoryBounds';
  if (e.maxOutstandingNotionalE8 === 0n) return 'exposure.maxOutstandingNotionalE8';
  if (e.feeAllowanceBps > 100) return 'exposure.feeAllowanceBps';
  if (r.lossTriggerQuoteE8 === 0n) return 'risk.lossTriggerQuoteE8';
  if (r.volBps === 0 || r.volWindowSec === 0) return 'risk.volatility';
  if (r.maxRefAgeMs < 1000 || r.maxRefAgeMs > 600_000) return 'risk.maxRefAgeMs';
  if (r.maxDeviationBps === 0) return 'risk.maxDeviationBps';
  if (r.reconTimeoutSec === 0 || r.cancelTimeoutSec === 0 || r.watcherTimeoutSec === 0) return 'risk.timeouts';
  if (p.fees.feeBps > 100) return 'fees.feeBps';
  if (p.expiry <= nowSec) return 'expiry';
  return null;
}

/** Plain-English explanations of every validation failure, shown next to the form field. */
export const VALIDATION_HELP: Record<string, string> = {
  'market.isSpot': 'The first release supports spot markets only.',
  'market.asset': 'Spot assets use 10000 + the spot index from HyperCore metadata.',
  'market.szDecimals': 'Size decimals must come from HyperCore metadata (0 to 8).',
  'quotes.levels': `Choose between 1 and ${MAX_LEVELS} price levels on each side.`,
  'quotes.spreadBps': 'Target spread must be between 1 and 5000 basis points.',
  'quotes.levelSpacingBps': 'With more than one level, levels need a spacing above zero.',
  'quotes.ladderWidth': 'The outermost level would sit at or beyond zero; narrow the ladder.',
  'quotes.sizeLots': 'Order size must be above zero.',
  'quotes.skewBps': 'Inventory skew is capped at 1000 basis points.',
  'quotes.requoteBps': 'The requote threshold must be smaller than the spread.',
  'exposure.inventoryBounds': 'Minimum ≤ baseline ≤ maximum inventory is required.',
  'exposure.maxOutstandingNotionalE8': 'Set a maximum outstanding order value above zero.',
  'exposure.feeAllowanceBps': 'Fee allowance is capped at 100 basis points.',
  'risk.lossTriggerQuoteE8': 'Set a loss trigger above zero.',
  'risk.volatility': 'Volatility threshold and window must be above zero.',
  'risk.maxRefAgeMs': 'Maximum reference age must be between 1 and 600 seconds.',
  'risk.maxDeviationBps': 'Set a permitted deviation above zero.',
  'risk.timeouts': 'Reconciliation, cancellation and watcher timeouts must be above zero.',
  'fees.feeBps': 'Service fee is capped at 100 basis points.',
  expiry: 'Expiry must be in the future.',
};

/** Mirrors MandateRegistry.isRiskIncreasing. Risk-increasing edits wait MIN_NOTICE_SEC before taking effect. */
export function riskIncreasingFields(a: Policy, b: Policy): string[] {
  const out: string[] = [];
  const add = (cond: boolean, name: string) => cond && out.push(name);
  add(b.quotes.levels > a.quotes.levels, 'quotes.levels');
  add(b.quotes.sizeLots > a.quotes.sizeLots, 'quotes.sizeLots');
  add(b.quotes.spreadBps < a.quotes.spreadBps, 'quotes.spreadBps');
  add(b.quotes.levelSpacingBps < a.quotes.levelSpacingBps, 'quotes.levelSpacingBps');
  add(b.quotes.skewBps < a.quotes.skewBps, 'quotes.skewBps');
  add(b.quotes.bookRule !== a.quotes.bookRule, 'quotes.bookRule');
  add(b.exposure.maxBaseE8 > a.exposure.maxBaseE8, 'exposure.maxBaseE8');
  add(b.exposure.minBaseE8 < a.exposure.minBaseE8, 'exposure.minBaseE8');
  add(b.exposure.quoteBudgetE8 > a.exposure.quoteBudgetE8, 'exposure.quoteBudgetE8');
  add(b.exposure.maxOutstandingNotionalE8 > a.exposure.maxOutstandingNotionalE8, 'exposure.maxOutstandingNotionalE8');
  add(b.exposure.feeAllowanceBps < a.exposure.feeAllowanceBps, 'exposure.feeAllowanceBps');
  add(b.exposure.baselineBaseE8 !== a.exposure.baselineBaseE8, 'exposure.baselineBaseE8');
  add(b.risk.lossTriggerQuoteE8 > a.risk.lossTriggerQuoteE8, 'risk.lossTriggerQuoteE8');
  add(b.risk.volBps > a.risk.volBps, 'risk.volBps');
  add(b.risk.volWindowSec !== a.risk.volWindowSec, 'risk.volWindowSec');
  add(b.risk.calmSec < a.risk.calmSec, 'risk.calmSec');
  add(b.risk.maxRefAgeMs > a.risk.maxRefAgeMs, 'risk.maxRefAgeMs');
  add(b.risk.maxDeviationBps > a.risk.maxDeviationBps, 'risk.maxDeviationBps');
  add(b.risk.reconTimeoutSec > a.risk.reconTimeoutSec, 'risk.reconTimeoutSec');
  add(b.risk.cancelTimeoutSec > a.risk.cancelTimeoutSec, 'risk.cancelTimeoutSec');
  add(b.risk.watcherTimeoutSec > a.risk.watcherTimeoutSec, 'risk.watcherTimeoutSec');
  add(b.expiry > a.expiry, 'expiry');
  add(b.fees.feeBps !== a.fees.feeBps, 'fees.feeBps');
  add(b.fees.spendCap > a.fees.spendCap, 'fees.spendCap');
  return out;
}

export interface PolicyField {
  key: string;
  group: 'Quotes' | 'Exposure' | 'Risk' | 'Fees' | 'Lifecycle';
  label: string;
  get: (p: Policy) => string;
}

const e8 = (v: bigint) => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const s = `${a / 100_000_000n}.${(a % 100_000_000n).toString().padStart(8, '0')}`.replace(/\.?0+$/, '');
  return (neg ? '-' : '') + s;
};
export const fmtE8 = e8;

/** Human-readable field list used for public diffs between versions. */
export const POLICY_FIELDS: PolicyField[] = [
  { key: 'quotes.spreadBps', group: 'Quotes', label: 'Target spread (bps)', get: (p) => `${p.quotes.spreadBps}` },
  { key: 'quotes.levels', group: 'Quotes', label: 'Levels per side', get: (p) => `${p.quotes.levels}` },
  { key: 'quotes.levelSpacingBps', group: 'Quotes', label: 'Level spacing (bps)', get: (p) => `${p.quotes.levelSpacingBps}` },
  { key: 'quotes.sizeLots', group: 'Quotes', label: 'Size per level (lots)', get: (p) => `${p.quotes.sizeLots}` },
  { key: 'quotes.skewBps', group: 'Quotes', label: 'Max inventory skew (bps)', get: (p) => `${p.quotes.skewBps}` },
  { key: 'quotes.requoteBps', group: 'Quotes', label: 'Requote threshold (bps)', get: (p) => `${p.quotes.requoteBps}` },
  { key: 'quotes.bookRule', group: 'Quotes', label: 'Healthy-book rule', get: (p) => p.quotes.bookRule },
  { key: 'exposure.baselineBaseE8', group: 'Exposure', label: 'Baseline inventory', get: (p) => e8(p.exposure.baselineBaseE8) },
  { key: 'exposure.minBaseE8', group: 'Exposure', label: 'Minimum inventory', get: (p) => e8(p.exposure.minBaseE8) },
  { key: 'exposure.maxBaseE8', group: 'Exposure', label: 'Maximum inventory', get: (p) => e8(p.exposure.maxBaseE8) },
  { key: 'exposure.quoteBudgetE8', group: 'Exposure', label: 'Quote budget for bids', get: (p) => e8(p.exposure.quoteBudgetE8) },
  {
    key: 'exposure.maxOutstandingNotionalE8',
    group: 'Exposure',
    label: 'Max outstanding order value',
    get: (p) => e8(p.exposure.maxOutstandingNotionalE8),
  },
  { key: 'exposure.feeAllowanceBps', group: 'Exposure', label: 'Exchange fee allowance (bps)', get: (p) => `${p.exposure.feeAllowanceBps}` },
  { key: 'risk.lossTriggerQuoteE8', group: 'Risk', label: 'Loss trigger (quote)', get: (p) => e8(p.risk.lossTriggerQuoteE8) },
  { key: 'risk.volBps', group: 'Risk', label: 'Volatility trigger (bps)', get: (p) => `${p.risk.volBps}` },
  { key: 'risk.volWindowSec', group: 'Risk', label: 'Volatility window (s)', get: (p) => `${p.risk.volWindowSec}` },
  { key: 'risk.calmSec', group: 'Risk', label: 'Calm period before resume (s)', get: (p) => `${p.risk.calmSec}` },
  { key: 'risk.maxRefAgeMs', group: 'Risk', label: 'Max reference age (ms)', get: (p) => `${p.risk.maxRefAgeMs}` },
  { key: 'risk.maxDeviationBps', group: 'Risk', label: 'Max deviation from mark (bps)', get: (p) => `${p.risk.maxDeviationBps}` },
  { key: 'risk.reconTimeoutSec', group: 'Risk', label: 'Reconciliation timeout (s)', get: (p) => `${p.risk.reconTimeoutSec}` },
  { key: 'risk.cancelTimeoutSec', group: 'Risk', label: 'Cancel retry timeout (s)', get: (p) => `${p.risk.cancelTimeoutSec}` },
  { key: 'risk.watcherTimeoutSec', group: 'Risk', label: 'Watcher timeout (s)', get: (p) => `${p.risk.watcherTimeoutSec}` },
  { key: 'fees.feeBps', group: 'Fees', label: 'Service fee (bps of executed notional)', get: (p) => `${p.fees.feeBps}` },
  { key: 'fees.spendCap', group: 'Fees', label: 'Fee spending cap (fee-token units)', get: (p) => p.fees.spendCap.toString() },
  { key: 'expiry', group: 'Lifecycle', label: 'Expiry', get: (p) => new Date(Number(p.expiry) * 1000).toISOString() },
];

export function diffPolicies(a: Policy, b: Policy) {
  const risky = new Set(riskIncreasingFields(a, b));
  return POLICY_FIELDS.filter((f) => f.get(a) !== f.get(b)).map((f) => ({
    key: f.key,
    label: f.label,
    from: f.get(a),
    to: f.get(b),
    riskIncreasing: risky.has(f.key),
  }));
}

/** PURR/USDC on HyperCore testnet: spot index 0, order asset 10000, szDecimals 0, $10 minimum order value. */
export const PURR_USDC_TESTNET: MarketParams = {
  asset: 10000,
  szDecimals: 0,
  isSpot: true,
  minNotionalE8: parseScaled('10', 8),
};

/** Conservative first-release policy used for the testnet campaign (see docs/campaign.md). */
export function campaignPolicy(expirySec: bigint): Policy {
  const q = (v: string) => parseScaled(v, 8);
  const bookRule: BookRule = 'JOIN';
  return {
    market: PURR_USDC_TESTNET,
    quotes: { spreadBps: 40, levels: 2, levelSpacingBps: 20, sizeLots: 3n, skewBps: 30, requoteBps: 10, bookRule },
    exposure: {
      baselineBaseE8: q('30'),
      minBaseE8: q('10'),
      maxBaseE8: q('50'),
      quoteBudgetE8: q('150'),
      maxOutstandingNotionalE8: q('100'),
      feeAllowanceBps: 10,
    },
    risk: {
      lossTriggerQuoteE8: q('5'),
      volBps: 150,
      volWindowSec: 60,
      calmSec: 120,
      maxRefAgeMs: 15_000,
      maxDeviationBps: 300,
      reconTimeoutSec: 60,
      cancelTimeoutSec: 20,
      watcherTimeoutSec: 45,
    },
    fees: { feeBps: 5, spendCap: 20_000_000n },
    expiry: expirySec,
  };
}
