/**
 * Independent TypeScript reference for the on-chain QuoteEngine (contracts/src/QuoteEngine.sol).
 * Written separately from the Solidity code (different algorithms for tick size and skew) and checked against
 * the same frozen vectors, so a shared bug is less likely to pass unnoticed.
 *
 * Units: pxE8 = quote per whole base token x 1e8; lots = 10^-szDecimals base; baseE8 = base x 1e8.
 */

export const MAX_LEVELS = 5;
const BPS = 10_000n;
const E8 = 100_000_000n;

export type BookRule = 'STAY_OUT' | 'JOIN';

export interface MarketParams {
  asset: number;
  szDecimals: number;
  isSpot: boolean;
  minNotionalE8: bigint;
}

export interface QuoteParams {
  spreadBps: number;
  levels: number;
  levelSpacingBps: number;
  sizeLots: bigint;
  skewBps: number;
  requoteBps: number;
  bookRule: BookRule;
}

export interface ExposureParams {
  baselineBaseE8: bigint;
  minBaseE8: bigint;
  maxBaseE8: bigint;
  quoteBudgetE8: bigint;
  maxOutstandingNotionalE8: bigint;
  feeAllowanceBps: number;
}

export interface Level {
  pxE8: bigint;
  szLots: bigint;
  valid: boolean;
}

export interface LadderInput {
  midE8: bigint;
  inventoryE8: bigint;
  extBestBidE8: bigint;
  extBestAskE8: bigint;
  healthy: boolean;
  market: MarketParams;
  quotes: QuoteParams;
  exposure: ExposureParams;
}

export interface Ladder {
  bids: Level[];
  asks: Level[];
  reservationE8: bigint;
  skewBps: number;
}

/** Allowed decimal places for a price: 5 significant figures, capped by (8|6) - szDecimals. */
export function allowedDecimals(pxE8: bigint, szDecimals: number, isSpot: boolean): number {
  const cap = Math.max(0, (isSpot ? 8 : 6) - szDecimals);
  const whole = pxE8 / E8;
  let sig: number;
  if (whole > 0n) {
    // 5 significant figures minus the integer digits; integer prices are always valid.
    sig = Math.max(0, 5 - whole.toString().length);
  } else {
    // Leading zeros after the decimal point, then 5 significant digits.
    const frac = pxE8.toString().padStart(8, '0');
    const leadingZeros = frac.length - frac.replace(/^0+/, '').length;
    sig = leadingZeros + 5;
  }
  return Math.min(cap, sig);
}

export function tickE8(pxE8: bigint, szDecimals: number, isSpot: boolean): bigint {
  return 10n ** BigInt(8 - allowedDecimals(pxE8, szDecimals, isSpot));
}

export function roundPx(pxE8: bigint, szDecimals: number, isSpot: boolean, up: boolean): bigint {
  if (pxE8 === 0n) return 0n;
  const t = tickE8(pxE8, szDecimals, isSpot);
  const rem = pxE8 % t;
  if (rem === 0n) return pxE8;
  return up ? pxE8 - rem + t : pxE8 - rem;
}

export function lotsToBaseE8(lots: bigint, szDecimals: number): bigint {
  return lots * 10n ** BigInt(8 - szDecimals);
}

export function notionalUpE8(pxE8: bigint, lots: bigint, szDecimals: number): bigint {
  const v = pxE8 * lotsToBaseE8(lots, szDecimals);
  return (v + E8 - 1n) / E8;
}

export function notionalDownE8(pxE8: bigint, lots: bigint, szDecimals: number): bigint {
  return (pxE8 * lotsToBaseE8(lots, szDecimals)) / E8;
}

export function isHealthy(
  bid: bigint,
  ask: bigint,
  bidDepth: bigint,
  askDepth: bigint,
  spreadBps: number,
  sizeLots: bigint,
): boolean {
  if (bid === 0n || ask === 0n || ask <= bid) return false;
  if (bidDepth < sizeLots || askDepth < sizeLots) return false;
  return (ask - bid) * 2n * BPS <= BigInt(spreadBps) * (ask + bid);
}

/** Integer division truncating toward zero for signed bigints (matches Solidity). */
function divTrunc(a: bigint, b: bigint): bigint {
  const q = a / b; // bigint division already truncates toward zero
  return q;
}

export function skew(inventoryE8: bigint, e: ExposureParams, skewBps: number): number {
  if (e.maxBaseE8 <= e.minBaseE8 || skewBps === 0) return 0;
  const half = (e.maxBaseE8 - e.minBaseE8) / 2n;
  if (half === 0n) return 0;
  let norm = divTrunc((inventoryE8 - e.baselineBaseE8) * BPS, half);
  if (norm > BPS) norm = BPS;
  if (norm < -BPS) norm = -BPS;
  return Number(divTrunc(BigInt(skewBps) * norm, BPS));
}

function levelOk(px: bigint, lots: bigint, m: MarketParams, oppositeBest: bigint, isBuy: boolean): boolean {
  if (px === 0n || lots === 0n) return false;
  if (notionalDownE8(px, lots, m.szDecimals) < m.minNotionalE8) return false;
  if (oppositeBest !== 0n) {
    if (isBuy && px >= oppositeBest) return false;
    if (!isBuy && px <= oppositeBest) return false;
  }
  return true;
}

export function ladder(inp: LadderInput): Ladder {
  const q = inp.quotes;
  const m = inp.market;
  const s = skew(inp.inventoryE8, inp.exposure, q.skewBps);
  const reservationE8 = (inp.midE8 * (BPS - BigInt(s))) / BPS;
  const empty = (): Level => ({ pxE8: 0n, szLots: 0n, valid: false });
  const bids: Level[] = Array.from({ length: MAX_LEVELS }, empty);
  const asks: Level[] = Array.from({ length: MAX_LEVELS }, empty);
  const levels = Math.min(q.levels, MAX_LEVELS);
  const twoBps = 2n * BPS;
  for (let i = 0; i < levels; i++) {
    const off2 = BigInt(q.spreadBps) + 2n * BigInt(i) * BigInt(q.levelSpacingBps);
    if (off2 >= twoBps) break;
    let bid = roundPx((reservationE8 * (twoBps - off2)) / twoBps, m.szDecimals, m.isSpot, false);
    let ask = roundPx((reservationE8 * (twoBps + off2) + twoBps - 1n) / twoBps, m.szDecimals, m.isSpot, true);
    if (inp.healthy && q.bookRule === 'JOIN') {
      if (inp.extBestBidE8 !== 0n && bid > inp.extBestBidE8) bid = inp.extBestBidE8;
      if (inp.extBestAskE8 !== 0n && ask < inp.extBestAskE8) ask = inp.extBestAskE8;
    }
    bids[i] = { pxE8: bid, szLots: q.sizeLots, valid: levelOk(bid, q.sizeLots, m, inp.extBestAskE8, true) };
    asks[i] = { pxE8: ask, szLots: q.sizeLots, valid: levelOk(ask, q.sizeLots, m, inp.extBestBidE8, false) };
  }
  return { bids, asks, reservationE8, skewBps: s };
}

/** Formats a pxE8 price as the exchange wire string (no trailing zeros). */
export function pxToWire(pxE8: bigint): string {
  const whole = pxE8 / E8;
  const frac = (pxE8 % E8).toString().padStart(8, '0').replace(/0+$/, '');
  return frac.length ? `${whole}.${frac}` : whole.toString();
}

/** Formats lots as the exchange size string. */
export function lotsToWire(lots: bigint, szDecimals: number): string {
  if (szDecimals === 0) return lots.toString();
  const d = 10n ** BigInt(szDecimals);
  const frac = (lots % d).toString().padStart(szDecimals, '0').replace(/0+$/, '');
  return frac.length ? `${lots / d}.${frac}` : (lots / d).toString();
}

/** Parses a decimal string into an integer scaled by 10^scale, rejecting excess precision. */
export function parseScaled(value: string, scale: number): bigint {
  const neg = value.startsWith('-');
  const v = neg ? value.slice(1) : value;
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`invalid decimal: ${value}`);
  const [w, f = ''] = v.split('.');
  const trimmed = f.replace(/0+$/, '');
  if (trimmed.length > scale) throw new Error(`precision exceeds 1e-${scale}: ${value}`);
  const out = BigInt(w) * 10n ** BigInt(scale) + BigInt((trimmed || '0').padEnd(scale, '0'));
  return neg ? -out : out;
}

export interface Reserved {
  buyLots: bigint;
  sellLots: bigint;
  buyQuoteE8: bigint;
  notionalE8: bigint;
}

/**
 * Worst-case reservation check: every potentially executable order is already in `t` and opposing orders are
 * never netted. Mirrors QuoteEngine.reservationFits.
 */
export function reservationFits(
  t: Reserved,
  baseBalE8: bigint,
  quoteBalE8: bigint,
  isBuy: boolean,
  pxE8: bigint,
  lots: bigint,
  szDecimals: number,
  e: ExposureParams,
): { ok: boolean; next: Reserved } {
  const addBase = lotsToBaseE8(lots, szDecimals);
  const notional = notionalUpE8(pxE8, lots, szDecimals);
  const fail = { ok: false, next: t };
  if (t.notionalE8 + notional > e.maxOutstandingNotionalE8) return fail;
  if (isBuy) {
    const cost = notional + (notional * BigInt(e.feeAllowanceBps) + BPS - 1n) / BPS;
    if (baseBalE8 + lotsToBaseE8(t.buyLots, szDecimals) + addBase > e.maxBaseE8) return fail;
    if (t.buyQuoteE8 + cost > e.quoteBudgetE8 || t.buyQuoteE8 + cost > quoteBalE8) return fail;
    return {
      ok: true,
      next: { ...t, buyLots: t.buyLots + lots, buyQuoteE8: t.buyQuoteE8 + cost, notionalE8: t.notionalE8 + notional },
    };
  }
  const sellBase = lotsToBaseE8(t.sellLots, szDecimals);
  if (sellBase + addBase > baseBalE8) return fail;
  if (baseBalE8 < sellBase + addBase + e.minBaseE8) return fail;
  return { ok: true, next: { ...t, sellLots: t.sellLots + lots, notionalE8: t.notionalE8 + notional } };
}
