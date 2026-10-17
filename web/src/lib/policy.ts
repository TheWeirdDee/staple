import type { Policy } from '@staple/reference';
import type { PolicyView } from './desk';

/** Converts an on-chain policy tuple into the reference model used for validation, diffs and display. */
export function toRefPolicy(p: PolicyView): Policy {
  return {
    market: {
      asset: Number(p.market.asset),
      szDecimals: Number(p.market.szDecimals),
      isSpot: p.market.isSpot,
      minNotionalE8: BigInt(p.market.minNotionalE8),
    },
    quotes: {
      spreadBps: Number(p.quotes.spreadBps),
      levels: Number(p.quotes.levels),
      levelSpacingBps: Number(p.quotes.levelSpacingBps),
      sizeLots: BigInt(p.quotes.sizeLots),
      skewBps: Number(p.quotes.skewBps),
      requoteBps: Number(p.quotes.requoteBps),
      bookRule: Number(p.quotes.bookRule) === 1 ? 'JOIN' : 'STAY_OUT',
    },
    exposure: {
      baselineBaseE8: BigInt(p.exposure.baselineBaseE8),
      minBaseE8: BigInt(p.exposure.minBaseE8),
      maxBaseE8: BigInt(p.exposure.maxBaseE8),
      quoteBudgetE8: BigInt(p.exposure.quoteBudgetE8),
      maxOutstandingNotionalE8: BigInt(p.exposure.maxOutstandingNotionalE8),
      feeAllowanceBps: Number(p.exposure.feeAllowanceBps),
    },
    risk: {
      lossTriggerQuoteE8: BigInt(p.risk.lossTriggerQuoteE8),
      volBps: Number(p.risk.volBps),
      volWindowSec: Number(p.risk.volWindowSec),
      calmSec: Number(p.risk.calmSec),
      maxRefAgeMs: Number(p.risk.maxRefAgeMs),
      maxDeviationBps: Number(p.risk.maxDeviationBps),
      reconTimeoutSec: Number(p.risk.reconTimeoutSec),
      cancelTimeoutSec: Number(p.risk.cancelTimeoutSec),
      watcherTimeoutSec: Number(p.risk.watcherTimeoutSec),
    },
    fees: { feeBps: Number(p.fees.feeBps), spendCap: BigInt(p.fees.spendCap) },
    expiry: BigInt(p.expiry),
  };
}

/** Encodes a reference policy as the tuple the contracts expect. */
export function toChainArgs(p: Policy) {
  return {
    market: p.market,
    quotes: { ...p.quotes, bookRule: p.quotes.bookRule === 'JOIN' ? 1 : 0 },
    exposure: p.exposure,
    risk: p.risk,
    fees: p.fees,
    expiry: p.expiry,
  };
}
