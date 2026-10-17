// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MarketParams, QuoteParams, ExposureParams, BookRule, MAX_LEVELS as LEVELS} from "./StapleTypes.sol";

/// Deterministic, bounded quote calculations. Mirrored independently by reference/src/quote.ts and checked
/// against shared frozen vectors in reference/vectors/quote-vectors.json.
library QuoteEngine {
    uint256 internal constant MAX_LEVELS = LEVELS;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant E8 = 1e8;

    struct Level {
        uint64 pxE8;
        uint64 szLots;
        bool valid;
    }

    struct LadderInput {
        uint64 midE8;
        uint128 inventoryE8;
        uint64 extBestBidE8;
        uint64 extBestAskE8;
        bool healthy;
        MarketParams market;
        QuoteParams quotes;
        ExposureParams exposure;
    }

    struct Ladder {
        Level[LEVELS] bids;
        Level[LEVELS] asks;
        uint64 reservationE8;
        int32 skewBps;
    }

    function numDigits(uint256 x) internal pure returns (uint256 n) {
        if (x == 0) return 1;
        while (x > 0) {
            x /= 10;
            n++;
        }
    }

    /// Smallest valid price increment (in E8 units) at this price: 5 significant figures, at most
    /// (8 - szDecimals) decimals for spot or (6 - szDecimals) for perps; integer prices always allowed.
    function tickE8(uint64 pxE8, uint8 szDecimals, bool isSpot) internal pure returns (uint64) {
        uint256 maxDec = (isSpot ? 8 : 6);
        maxDec = maxDec > szDecimals ? maxDec - szDecimals : 0;
        uint256 nd = numDigits(pxE8);
        uint256 dec = nd >= 13 ? 0 : 13 - nd;
        if (dec > maxDec) dec = maxDec;
        return uint64(10 ** (8 - dec));
    }

    function roundPx(uint64 pxE8, uint8 szDecimals, bool isSpot, bool up) internal pure returns (uint64) {
        if (pxE8 == 0) return 0;
        uint64 t = tickE8(pxE8, szDecimals, isSpot);
        uint64 down = (pxE8 / t) * t;
        if (!up || down == pxE8) return down; // a zero bid is rejected later as an invalid level
        // Rounding up can cross a digit boundary; the result is then a coarser round number and stays valid.
        return down + t;
    }

    function lotsToBaseE8(uint64 lots, uint8 szDecimals) internal pure returns (uint256) {
        return uint256(lots) * (10 ** (8 - uint256(szDecimals)));
    }

    /// Quote value of `lots` at `pxE8`, rounded up (used for reservations and notional limits).
    function notionalUpE8(uint64 pxE8, uint64 lots, uint8 szDecimals) internal pure returns (uint256) {
        uint256 v = uint256(pxE8) * lotsToBaseE8(lots, szDecimals);
        return (v + E8 - 1) / E8;
    }

    /// Quote value rounded down (used for credited proceeds and the minimum-notional check).
    function notionalDownE8(uint64 pxE8, uint64 lots, uint8 szDecimals) internal pure returns (uint256) {
        return (uint256(pxE8) * lotsToBaseE8(lots, szDecimals)) / E8;
    }

    /// External book is healthy when its spread is at or inside the target and both sides show the size.
    function isHealthy(uint64 bid, uint64 ask, uint64 bidDepth, uint64 askDepth, uint16 spreadBps, uint64 sizeLots)
        internal
        pure
        returns (bool)
    {
        if (bid == 0 || ask == 0 || ask <= bid) return false;
        if (bidDepth < sizeLots || askDepth < sizeLots) return false;
        // (ask - bid) / mid <= spread  <=>  (ask - bid) * 2 * BPS <= spread * (ask + bid)
        return uint256(ask - bid) * 2 * BPS <= uint256(spreadBps) * (uint256(ask) + uint256(bid));
    }

    /// Signed skew in bps: positive when inventory is above baseline (quotes shift down to sell).
    function skew(uint128 inventoryE8, ExposureParams memory e, uint16 skewBps) internal pure returns (int32) {
        if (e.maxBaseE8 <= e.minBaseE8 || skewBps == 0) return 0;
        int256 dev = int256(uint256(inventoryE8)) - int256(uint256(e.baselineBaseE8));
        int256 half = int256(uint256(e.maxBaseE8 - e.minBaseE8)) / 2;
        if (half == 0) return 0;
        int256 norm = (dev * int256(BPS)) / half; // truncates toward zero
        if (norm > int256(BPS)) norm = int256(BPS);
        if (norm < -int256(BPS)) norm = -int256(BPS);
        return int32((int256(uint256(skewBps)) * norm) / int256(BPS));
    }

    struct Reserved {
        uint256 buyLots;
        uint256 sellLots;
        uint256 buyQuoteE8;
        uint256 notionalE8;
    }

    /// Conservative worst-case reservation check for one candidate order. Every potentially executable order is
    /// already counted in `t`; opposing orders are never netted. Returns the updated totals when it fits.
    function reservationFits(
        Reserved memory t,
        uint128 baseBalE8,
        uint128 quoteBalE8,
        bool isBuy,
        uint64 pxE8,
        uint64 lots,
        uint8 szd,
        ExposureParams memory e
    ) internal pure returns (bool ok, Reserved memory next) {
        next = t;
        uint256 addBase = lotsToBaseE8(lots, szd);
        uint256 notional = notionalUpE8(pxE8, lots, szd);
        if (t.notionalE8 + notional > e.maxOutstandingNotionalE8) return (false, t);
        if (isBuy) {
            uint256 cost = notional + (notional * e.feeAllowanceBps + BPS - 1) / BPS;
            uint256 buyBase = lotsToBaseE8(uint64(t.buyLots), szd);
            if (uint256(baseBalE8) + buyBase + addBase > e.maxBaseE8) return (false, t);
            if (t.buyQuoteE8 + cost > e.quoteBudgetE8 || t.buyQuoteE8 + cost > quoteBalE8) return (false, t);
            next.buyLots = t.buyLots + lots;
            next.buyQuoteE8 = t.buyQuoteE8 + cost;
        } else {
            uint256 sellBase = lotsToBaseE8(uint64(t.sellLots), szd);
            if (sellBase + addBase > baseBalE8) return (false, t);
            if (uint256(baseBalE8) < sellBase + addBase + e.minBaseE8) return (false, t);
            next.sellLots = t.sellLots + lots;
        }
        next.notionalE8 = t.notionalE8 + notional;
        ok = true;
    }

    function ladder(LadderInput memory inp) public pure returns (Ladder memory out) {
        QuoteParams memory q = inp.quotes;
        MarketParams memory m = inp.market;
        out.skewBps = skew(inp.inventoryE8, inp.exposure, q.skewBps);
        out.reservationE8 = uint64((uint256(inp.midE8) * uint256(int256(BPS) - out.skewBps)) / BPS);
        uint256 levels = q.levels > MAX_LEVELS ? MAX_LEVELS : q.levels;

        for (uint256 i = 0; i < levels; i++) {
            // Offsets in half-bps keep odd spreads exact: price = res * (2*BPS -/+ (spread + 2*i*spacing)) / (2*BPS)
            uint256 off2 = uint256(q.spreadBps) + 2 * i * uint256(q.levelSpacingBps);
            if (off2 >= 2 * BPS) break;
            uint64 bid = roundPx(
                uint64((uint256(out.reservationE8) * (2 * BPS - off2)) / (2 * BPS)), m.szDecimals, m.isSpot, false
            );
            uint64 ask = roundPx(
                uint64((uint256(out.reservationE8) * (2 * BPS + off2) + 2 * BPS - 1) / (2 * BPS)),
                m.szDecimals,
                m.isSpot,
                true
            );
            if (inp.healthy && q.bookRule == BookRule.JOIN) {
                // Join without improving: never better than the external best price.
                if (inp.extBestBidE8 != 0 && bid > inp.extBestBidE8) bid = inp.extBestBidE8;
                if (inp.extBestAskE8 != 0 && ask < inp.extBestAskE8) ask = inp.extBestAskE8;
            }
            out.bids[i] = Level(bid, q.sizeLots, _levelOk(bid, q.sizeLots, m, inp.extBestAskE8, true));
            out.asks[i] = Level(ask, q.sizeLots, _levelOk(ask, q.sizeLots, m, inp.extBestBidE8, false));
        }
    }

    function _levelOk(uint64 px, uint64 lots, MarketParams memory m, uint64 oppositeBest, bool isBuy)
        private
        pure
        returns (bool)
    {
        if (px == 0 || lots == 0) return false;
        if (notionalDownE8(px, lots, m.szDecimals) < m.minNotionalE8) return false;
        // Post-only: never cross the external opposite side.
        if (oppositeBest != 0) {
            if (isBuy && px >= oppositeBest) return false;
            if (!isBuy && px <= oppositeBest) return false;
        }
        return true;
    }
}

