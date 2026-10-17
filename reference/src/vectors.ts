import {
  type ExposureParams,
  type LadderInput,
  type MarketParams,
  type QuoteParams,
  type Reserved,
  isHealthy,
  ladder,
  parseScaled,
  reservationFits,
  roundPx,
} from './quote.js';

const q8 = (v: string) => parseScaled(v, 8);

const purr: MarketParams = { asset: 10000, szDecimals: 0, isSpot: true, minNotionalE8: q8('10') };
const micro: MarketParams = { asset: 10523, szDecimals: 0, isSpot: true, minNotionalE8: q8('10') };
const sz2: MarketParams = { asset: 11300, szDecimals: 2, isSpot: true, minNotionalE8: q8('10') };

const baseQuotes: QuoteParams = {
  spreadBps: 40,
  levels: 2,
  levelSpacingBps: 20,
  sizeLots: 3n,
  skewBps: 30,
  requoteBps: 10,
  bookRule: 'JOIN',
};
const baseExposure: ExposureParams = {
  baselineBaseE8: q8('30'),
  minBaseE8: q8('10'),
  maxBaseE8: q8('50'),
  quoteBudgetE8: q8('150'),
  maxOutstandingNotionalE8: q8('100'),
  feeAllowanceBps: 10,
};

function lad(name: string, over: Partial<Omit<LadderInput, 'quotes'>> & { quotes?: Partial<QuoteParams> }) {
  const input: LadderInput = {
    midE8: q8('4.55685'),
    inventoryE8: q8('30'),
    extBestBidE8: q8('4.5342'),
    extBestAskE8: q8('4.5795'),
    healthy: false,
    market: purr,
    exposure: baseExposure,
    ...over,
    quotes: { ...baseQuotes, ...(over.quotes ?? {}) },
  };
  return { name, input, expected: ladder(input) };
}

export function buildVectors() {
  const tickCases: [string, string, number, boolean][] = [
    ['purr 4.55685', '4.55685', 0, true],
    ['purr exact 4.5342', '4.5342', 0, true],
    ['five sig figs 12345.6', '12345.6', 0, true],
    ['integer allowed 123456.7', '123456.7', 0, true],
    ['sub-unit 0.00014613', '0.00014613', 0, true],
    ['spot szDec 2 caps decimals at 6: 0.00012345', '0.00012345', 2, true],
    ['perp cap szDec 1 0.012345', '0.012345', 1, false],
    ['boundary 9.99996 rounds up to 10', '9.99996', 0, true],
    ['boundary 99999.5 rounds up to 100000', '99999.5', 0, true],
    ['tiny price below tick 0.00000004 szDec 2', '0.00000004', 2, true],
  ];
  const ticks = tickCases.map(([name, px, szDecimals, isSpot]) => {
    const pxE8 = q8(px);
    return {
      name,
      pxE8,
      szDecimals,
      isSpot,
      down: roundPx(pxE8, szDecimals, isSpot, false),
      up: roundPx(pxE8, szDecimals, isSpot, true),
    };
  });

  const healthyCases: [string, string, string, bigint, bigint, number, bigint][] = [
    ['wide external book', '4.5342', '4.5795', 100000n, 77692n, 40, 3n],
    ['tight and deep', '4.556', '4.5575', 10n, 10n, 40, 3n],
    ['tight but thin bid', '4.556', '4.5575', 2n, 10n, 40, 3n],
    ['exactly at target', '99.8', '100.2', 3n, 3n, 40, 3n],
    ['crossed book', '4.6', '4.5', 10n, 10n, 40, 3n],
    ['one side empty', '0', '4.5', 10n, 10n, 40, 3n],
  ];
  const healthy = healthyCases.map(([name, bid, ask, bidDepth, askDepth, spreadBps, sizeLots]) => ({
    name,
    bid: q8(bid),
    ask: q8(ask),
    bidDepth,
    askDepth,
    spreadBps,
    sizeLots,
    expected: isHealthy(q8(bid), q8(ask), bidDepth, askDepth, spreadBps, sizeLots),
  }));

  const ladders = [
    lad('campaign policy at baseline inventory', {}),
    lad('long inventory skews quotes down', { inventoryE8: q8('45') }),
    lad('short inventory skews quotes up', { inventoryE8: q8('12') }),
    lad('skew clamps beyond max inventory', { inventoryE8: q8('80') }),
    lad('odd spread uses half-bps exactly', { quotes: { spreadBps: 41 } }),
    lad('five levels bounded', { quotes: { levels: 5, levelSpacingBps: 25 } }),
    lad('size below minimum notional is invalid', { quotes: { sizeLots: 2n } }),
    lad('healthy JOIN never improves external best', {
      healthy: true,
      extBestBidE8: q8('4.5560'),
      extBestAskE8: q8('4.5577'),
      midE8: q8('4.55685'),
    }),
    lad('post-only: bid that would cross the external ask is invalid', { extBestAskE8: q8('4.5470'), extBestBidE8: q8('4.5300') }),
    lad('micro-priced token 0.00014612', {
      market: micro,
      midE8: q8('0.00014612'),
      extBestBidE8: q8('0.00014601'),
      extBestAskE8: q8('0.00014623'),
      quotes: { sizeLots: 100000n },
    }),
    lad('fractional lots szDecimals 2', {
      market: sz2,
      midE8: q8('0.7995'),
      extBestBidE8: q8('0.799'),
      extBestAskE8: q8('0.8'),
      quotes: { sizeLots: 1500n, spreadBps: 60 },
    }),
  ];

  const empty: Reserved = { buyLots: 0n, sellLots: 0n, buyQuoteE8: 0n, notionalE8: 0n };
  const resCases: {
    name: string;
    t: Reserved;
    baseBalE8: bigint;
    quoteBalE8: bigint;
    isBuy: boolean;
    pxE8: bigint;
    lots: bigint;
    szDecimals: number;
    exposure: ExposureParams;
  }[] = [
    { name: 'first bid fits', t: empty, baseBalE8: q8('30'), quoteBalE8: q8('200'), isBuy: true, pxE8: q8('4.5477'), lots: 3n, szDecimals: 0, exposure: baseExposure },
    { name: 'first ask fits', t: empty, baseBalE8: q8('30'), quoteBalE8: q8('200'), isBuy: false, pxE8: q8('4.5661'), lots: 3n, szDecimals: 0, exposure: baseExposure },
    {
      name: 'bid blocked by max inventory incl. resting buys',
      t: { buyLots: 18n, sellLots: 0n, buyQuoteE8: q8('82'), notionalE8: q8('82') },
      baseBalE8: q8('30'),
      quoteBalE8: q8('200'),
      isBuy: true,
      pxE8: q8('4.5'),
      lots: 3n,
      szDecimals: 0,
      exposure: { ...baseExposure, maxOutstandingNotionalE8: q8('1000') },
    },
    {
      name: 'bid exactly at max inventory boundary fits',
      t: { buyLots: 17n, sellLots: 0n, buyQuoteE8: q8('80'), notionalE8: q8('80') },
      baseBalE8: q8('30'),
      quoteBalE8: q8('200'),
      isBuy: true,
      pxE8: q8('4.5'),
      lots: 3n,
      szDecimals: 0,
      exposure: { ...baseExposure, maxOutstandingNotionalE8: q8('1000') },
    },
    {
      name: 'ask blocked by min inventory incl. resting sells',
      t: { buyLots: 0n, sellLots: 18n, buyQuoteE8: 0n, notionalE8: q8('82') },
      baseBalE8: q8('30'),
      quoteBalE8: q8('200'),
      isBuy: false,
      pxE8: q8('4.6'),
      lots: 3n,
      szDecimals: 0,
      exposure: { ...baseExposure, maxOutstandingNotionalE8: q8('1000') },
    },
    {
      name: 'opposing buys do not free sell capacity',
      t: { buyLots: 12n, sellLots: 18n, buyQuoteE8: q8('55'), notionalE8: q8('137') },
      baseBalE8: q8('30'),
      quoteBalE8: q8('200'),
      isBuy: false,
      pxE8: q8('4.6'),
      lots: 3n,
      szDecimals: 0,
      exposure: { ...baseExposure, maxOutstandingNotionalE8: q8('1000') },
    },
    {
      name: 'insufficient quote balance',
      t: empty,
      baseBalE8: q8('30'),
      quoteBalE8: q8('13.6'),
      isBuy: true,
      pxE8: q8('4.5477'),
      lots: 3n,
      szDecimals: 0,
      exposure: baseExposure,
    },
    {
      name: 'insufficient base balance for ask',
      t: empty,
      baseBalE8: q8('2'),
      quoteBalE8: q8('200'),
      isBuy: false,
      pxE8: q8('4.5661'),
      lots: 3n,
      szDecimals: 0,
      exposure: { ...baseExposure, minBaseE8: 0n, baselineBaseE8: 0n },
    },
    {
      name: 'outstanding notional cap counts orders awaiting cancel',
      t: { buyLots: 6n, sellLots: 15n, buyQuoteE8: q8('27.4'), notionalE8: q8('95') },
      baseBalE8: q8('30'),
      quoteBalE8: q8('200'),
      isBuy: true,
      pxE8: q8('4.5477'),
      lots: 3n,
      szDecimals: 0,
      exposure: baseExposure,
    },
    {
      name: 'quote budget includes fee allowance (rounded up)',
      t: { buyLots: 0n, sellLots: 0n, buyQuoteE8: q8('136.4'), notionalE8: 0n },
      baseBalE8: q8('30'),
      quoteBalE8: q8('500'),
      isBuy: true,
      pxE8: q8('4.5477'),
      lots: 3n,
      szDecimals: 0,
      exposure: { ...baseExposure, quoteBudgetE8: q8('150.08') },
    },
  ];
  const reservations = resCases.map((r) => ({
    ...r,
    expected: reservationFits(r.t, r.baseBalE8, r.quoteBalE8, r.isBuy, r.pxE8, r.lots, r.szDecimals, r.exposure),
  }));

  return { version: 1, units: 'pxE8 / lots / baseE8 / quoteE8 — see docs/units.md', ticks, healthy, ladders, reservations };
}
