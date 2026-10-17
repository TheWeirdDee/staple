// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Observation} from "./StapleTypes.sol";

struct Accounting {
    bool snapshotTaken;
    uint64 epoch; // increments per activation; a snapshot never spans deposits or withdrawals
    uint64 startMidE8;
    uint64 lastMarkE8;
    uint128 startBaseE8;
    uint128 startQuoteE8;
    uint128 expBaseE8; // expected balances: snapshot + ingested fills
    uint128 expQuoteE8;
    uint128 posBaseE8; // average-cost position
    uint256 costBasisE8;
    int256 realisedE8; // after exchange fees
    uint256 exchangeFeesQuoteEqE8;
    uint256 executedNotionalE8;
    uint256 serviceFeesCharged; // fee-token units
    uint32 fillCount;
    int256 lastLossE8; // start equity - current equity, at the last observation
    int256 peakLossE8;
    uint64 lossTriggeredAt;
    int256 lossAtTriggerE8;
    uint64 tripCancelConfirmedAt;
}

/// Fill accounting and marking for one mandate epoch. Linked library: keeps StapleDesk under the code-size limit.
library DeskAccounting {
    uint256 internal constant BAL_TOLERANCE_E8 = 10;

    function takeSnapshot(Accounting storage a, Observation calldata o) public {
        a.snapshotTaken = true;
        uint64 mid = uint64((uint256(o.bestBidE8) + o.bestAskE8) / 2);
        a.startMidE8 = mid;
        a.lastMarkE8 = mid;
        a.startBaseE8 = o.baseBalE8;
        a.startQuoteE8 = o.quoteBalE8;
        a.expBaseE8 = o.baseBalE8;
        a.expQuoteE8 = o.quoteBalE8;
        a.posBaseE8 = o.baseBalE8;
        a.costBasisE8 = (uint256(o.baseBalE8) * mid) / 1e8;
    }

    /// Equity-based loss relative to the activation snapshot, marked at the external-book mid.
    function mark(Accounting storage a, Observation calldata o, uint64 midE8) public returns (int256) {
        a.lastMarkE8 = midE8;
        int256 start = int256(uint256(a.startQuoteE8) + (uint256(a.startBaseE8) * a.startMidE8) / 1e8);
        int256 nowEq = int256(uint256(o.quoteBalE8) + (uint256(o.baseBalE8) * midE8) / 1e8);
        a.lastLossE8 = start - nowEq;
        if (a.lastLossE8 > a.peakLossE8) a.peakLossE8 = a.lastLossE8;
        return a.lastLossE8;
    }

    function balancesMatch(Accounting storage a, Observation calldata o) public view returns (bool) {
        return _absDiff(o.baseBalE8, a.expBaseE8) <= BAL_TOLERANCE_E8
            && _absDiff(o.quoteBalE8, a.expQuoteE8) <= BAL_TOLERANCE_E8;
    }

    /// Applies one exchange fill. Spot buys pay the exchange fee in the received base token, sells in quote.
    /// Returns executed notional in quote E8 (rounded down).
    function applyFill(Accounting storage a, bool isBuy, uint64 szLots, uint64 pxE8, uint128 feeE8, uint8 szd)
        public
        returns (uint256 notional)
    {
        uint256 baseE8 = uint256(szLots) * (10 ** (8 - uint256(szd)));
        uint256 notionalExact = uint256(pxE8) * baseE8; // scaled 1e16
        notional = notionalExact / 1e8;
        a.fillCount++;
        a.executedNotionalE8 += notional;
        if (isBuy) {
            uint256 netBase = baseE8 - _min(feeE8, baseE8);
            uint256 cost = (notionalExact + 1e8 - 1) / 1e8;
            a.expBaseE8 += uint128(netBase);
            a.expQuoteE8 -= uint128(_min(cost, a.expQuoteE8));
            a.posBaseE8 += uint128(netBase);
            a.costBasisE8 += cost;
            a.exchangeFeesQuoteEqE8 += (uint256(feeE8) * pxE8) / 1e8;
        } else {
            a.expBaseE8 -= uint128(_min(baseE8, a.expBaseE8));
            a.expQuoteE8 += uint128(notional - _min(feeE8, notional));
            uint256 sold = _min(baseE8, a.posBaseE8);
            uint256 costOut = a.posBaseE8 == 0 ? 0 : (a.costBasisE8 * sold) / a.posBaseE8;
            a.realisedE8 += int256(notional) - int256(costOut) - int256(uint256(feeE8));
            a.costBasisE8 -= costOut;
            a.posBaseE8 -= uint128(sold);
            a.exchangeFeesQuoteEqE8 += feeE8;
        }
    }

    function _absDiff(uint256 x, uint256 y) private pure returns (uint256) {
        return x > y ? x - y : y - x;
    }

    function _min(uint256 x, uint256 y) private pure returns (uint256) {
        return x < y ? x : y;
    }
}
