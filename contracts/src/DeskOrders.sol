// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    Order, OrderState, Observation, Outcome, OutcomeKind, Policy, BookRule, Reason, MAX_LEVELS
} from "./StapleTypes.sol";
import {QuoteEngine} from "./QuoteEngine.sol";

struct OrderStore {
    mapping(uint256 => uint128[]) live; // bounded by MAX_LIVE_ORDERS
    mapping(uint128 => Order) orders;
    mapping(uint256 => uint64) nonce;
    mapping(uint256 => mapping(uint64 => bool)) fillSeen; // exchange trade ids already ingested
}

struct Totals {
    uint256 buyLots;
    uint256 sellLots;
    uint256 buyQuoteE8;
    uint256 notionalE8;
    uint256 pendingCount; // INTENT_EMITTED or SUBMISSION_UNKNOWN
}

struct QuoteResult {
    uint64 reservationE8;
    int32 skewBps;
    uint16 placed;
    uint16 cancelled;
    uint8 reason;
}

/// Order bookkeeping, reservations and intent emission (IntentGateway). Linked library operating on the
/// desk's storage; events are emitted from the desk's address.
library DeskOrders {
    uint16 internal constant INTENT_VERSION = 1;
    uint256 internal constant MAX_LIVE_ORDERS = 24;

    event PlaceIntent(
        uint256 indexed mandateId,
        uint128 indexed cloid,
        uint16 intentVersion,
        uint32 policyVersion,
        uint32 asset,
        bool isBuy,
        uint64 pxE8,
        uint64 szLots,
        uint8 level
    );
    event CancelIntent(uint256 indexed mandateId, uint128 indexed cloid, uint64 oid, uint8 reason);
    event CancelOverdue(uint256 indexed mandateId, uint128 indexed cloid, uint64 requestedAt);
    event OutcomeApplied(uint256 indexed mandateId, uint128 indexed cloid, OutcomeKind kind, OrderState state);
    event DuplicateIgnored(uint256 indexed mandateId, uint128 indexed cloid, uint64 fillId, OutcomeKind kind);

    event LateFill(uint256 indexed mandateId, uint128 indexed cloid, uint64 fillId);

    error UnknownOrder(uint128 cloid);

    /// Moves filled quantity from reserved to executed exactly once per exchange trade id. A fill reported
    /// after a confirmed cancel is still applied (and flagged) so accounting never drops real executions.
    function recordFill(OrderStore storage s, uint256 id, Outcome calldata out, bool terminal)
        public
        returns (bool applied, bool overfill)
    {
        if (s.fillSeen[id][out.fillId]) {
            emit DuplicateIgnored(id, out.cloid, out.fillId, OutcomeKind.FILL);
            return (false, false);
        }
        s.fillSeen[id][out.fillId] = true;
        Order storage ord = s.orders[out.cloid];
        if (ord.oid == 0) ord.oid = out.oid;
        uint64 rem = ord.szLots - ord.filledLots;
        overfill = out.szLots > rem;
        ord.filledLots += overfill ? rem : out.szLots;
        if (terminal) {
            emit LateFill(id, out.cloid, out.fillId);
        } else {
            ord.state = ord.filledLots == ord.szLots ? OrderState.FILLED : OrderState.PARTIALLY_FILLED;
            if (ord.state == OrderState.FILLED) removeLive(s, id, out.cloid);
        }
        applied = true;
    }

    /// Applies a non-fill outcome idempotently. Transport success is never treated as resting or cancelled;
    /// only an explicit exchange outcome changes state. Fills are returned to the desk for accounting.
    function applyStatus(OrderStore storage s, uint256 id, Outcome calldata out)
        public
        returns (bool isFill, bool terminal)
    {
        Order storage ord = s.orders[out.cloid];
        if (ord.mandateId != id || ord.state == OrderState.NONE) revert UnknownOrder(out.cloid);
        OrderState st = ord.state;
        terminal = st == OrderState.FILLED || st == OrderState.CANCELLED || st == OrderState.REJECTED;
        if (out.kind == OutcomeKind.FILL) return (true, terminal);
        if (terminal) {
            emit DuplicateIgnored(id, out.cloid, 0, out.kind);
            return (false, true);
        }
        bool pending = st == OrderState.INTENT_EMITTED || st == OrderState.SUBMISSION_UNKNOWN;
        if (ord.oid == 0) ord.oid = out.oid;
        if (out.kind == OutcomeKind.ACK_RESTING) {
            if (pending || st == OrderState.ACKNOWLEDGED) ord.state = OrderState.RESTING;
        } else if (out.kind == OutcomeKind.SUBMISSION_UNKNOWN) {
            if (st == OrderState.INTENT_EMITTED) ord.state = OrderState.SUBMISSION_UNKNOWN;
        } else if (out.kind == OutcomeKind.REJECTED) {
            ord.state = ord.filledLots == 0 ? OrderState.REJECTED : OrderState.CANCELLED;
            removeLive(s, id, out.cloid);
        } else if (out.kind == OutcomeKind.CANCEL_CONFIRMED) {
            ord.state = OrderState.CANCELLED;
            removeLive(s, id, out.cloid);
        }
        // CANCEL_REJECTED: still potentially executable; reservation stays and the cancel retries on timeout.
        emit OutcomeApplied(id, out.cloid, out.kind, ord.state);
    }

    function cloidFor(uint256 id, uint32 version, uint64 nonce) internal view returns (uint128) {
        return uint128(uint256(keccak256(abi.encode(block.chainid, address(this), id, version, nonce))));
    }

    /// Requests cancellation of every live order not already being cancelled. Reservations remain.
    function cancelAll(OrderStore storage s, uint256 id, uint8 reason) public returns (uint256 n) {
        uint128[] storage live = s.live[id];
        for (uint256 i = 0; i < live.length; i++) {
            if (s.orders[live[i]].cancelRequestedAt == 0) {
                _requestCancel(s, id, live[i], reason);
                n++;
            }
        }
    }

    function retryOverdueCancels(OrderStore storage s, uint256 id, uint32 timeoutSec) public {
        uint128[] storage live = s.live[id];
        for (uint256 i = 0; i < live.length; i++) {
            Order storage ord = s.orders[live[i]];
            if (ord.cancelRequestedAt != 0 && block.timestamp - ord.cancelRequestedAt > timeoutSec) {
                emit CancelOverdue(id, live[i], ord.cancelRequestedAt);
                _requestCancel(s, id, live[i], Reason.CANCEL_RETRY);
            }
        }
    }

    function removeLive(OrderStore storage s, uint256 id, uint128 cloid) public {
        uint128[] storage live = s.live[id];
        for (uint256 i = 0; i < live.length; i++) {
            if (live[i] == cloid) {
                live[i] = live[live.length - 1];
                live.pop();
                return;
            }
        }
    }

    function missingOutcome(OrderStore storage s, uint256 id, uint32 timeoutSec) public view returns (bool) {
        uint128[] storage live = s.live[id];
        for (uint256 i = 0; i < live.length; i++) {
            Order storage ord = s.orders[live[i]];
            if (
                (ord.state == OrderState.INTENT_EMITTED || ord.state == OrderState.SUBMISSION_UNKNOWN)
                    && block.timestamp - ord.emittedAt > timeoutSec
            ) return true;
        }
        return false;
    }

    function hasUncancelled(OrderStore storage s, uint256 id) public view returns (bool) {
        uint128[] storage live = s.live[id];
        for (uint256 i = 0; i < live.length; i++) {
            if (s.orders[live[i]].cancelRequestedAt == 0) return true;
        }
        return false;
    }

    /// Worst-case totals over every potentially executable order (placed, acknowledged, resting, partially
    /// filled, outcome-unknown and awaiting cancellation). Remaining size only; fills are executed exposure.
    function totals(OrderStore storage s, uint256 id, uint8 szd, uint16 feeAllowanceBps)
        public
        view
        returns (Totals memory t)
    {
        uint128[] storage live = s.live[id];
        for (uint256 i = 0; i < live.length; i++) {
            Order storage ord = s.orders[live[i]];
            uint64 rem = ord.szLots - ord.filledLots;
            uint256 notional = QuoteEngine.notionalUpE8(ord.pxE8, rem, szd);
            t.notionalE8 += notional;
            if (ord.isBuy) {
                t.buyLots += rem;
                t.buyQuoteE8 += notional + (notional * feeAllowanceBps + 9_999) / 10_000;
            } else {
                t.sellLots += rem;
            }
            if (ord.state == OrderState.INTENT_EMITTED || ord.state == OrderState.SUBMISSION_UNKNOWN) t.pendingCount++;
        }
    }

    /// One quoting pass: compute the ladder, keep matching orders, cancel the rest, then place what still fits
    /// inside conservative reservations.
    function quote(OrderStore storage s, uint256 id, uint32 version, Observation calldata o, Policy memory p)
        public
        returns (QuoteResult memory res)
    {
        bool healthy = QuoteEngine.isHealthy(
            o.bestBidE8, o.bestAskE8, o.extBidDepthLots, o.extAskDepthLots, p.quotes.spreadBps, p.quotes.sizeLots
        );
        if (healthy && p.quotes.bookRule == BookRule.STAY_OUT) {
            res.cancelled = uint16(cancelAll(s, id, Reason.HEALTHY_STAY_OUT));
            res.reason = Reason.HEALTHY_STAY_OUT;
            return res;
        }
        res.reason = healthy ? Reason.HEALTHY_JOIN : Reason.QUOTED;
        QuoteEngine.Ladder memory lad = QuoteEngine.ladder(
            QuoteEngine.LadderInput({
                midE8: uint64((uint256(o.bestBidE8) + o.bestAskE8) / 2),
                inventoryE8: o.baseBalE8,
                extBestBidE8: o.bestBidE8,
                extBestAskE8: o.bestAskE8,
                healthy: healthy,
                market: p.market,
                quotes: p.quotes,
                exposure: p.exposure
            })
        );
        res.reservationE8 = lad.reservationE8;
        res.skewBps = lad.skewBps;

        bool[MAX_LEVELS] memory bidTaken;
        bool[MAX_LEVELS] memory askTaken;
        uint128[] storage live = s.live[id];
        for (uint256 i = 0; i < live.length; i++) {
            Order storage ord = s.orders[live[i]];
            if (ord.cancelRequestedAt != 0) continue;
            QuoteEngine.Level memory target = ord.isBuy ? lad.bids[ord.level] : lad.asks[ord.level];
            bool[MAX_LEVELS] memory taken = ord.isBuy ? bidTaken : askTaken;
            uint256 diff = ord.pxE8 > target.pxE8 ? ord.pxE8 - target.pxE8 : target.pxE8 - ord.pxE8;
            if (
                ord.version == version && target.valid && !taken[ord.level]
                    && diff * 10_000 <= uint256(p.quotes.requoteBps) * target.pxE8 && ord.szLots == target.szLots
            ) {
                taken[ord.level] = true;
            } else {
                _requestCancel(s, id, live[i], Reason.REQUOTE);
                res.cancelled++;
            }
        }

        Totals memory t = totals(s, id, p.market.szDecimals, p.exposure.feeAllowanceBps);
        if (t.pendingCount > 0) return res; // an unresolved placement blocks new exposure
        for (uint256 lvl = 0; lvl < MAX_LEVELS; lvl++) {
            if (!bidTaken[lvl] && lad.bids[lvl].valid && _fits(s, id, o, p, t, true, lad.bids[lvl])) {
                _place(s, id, version, p.market.asset, true, lad.bids[lvl], uint8(lvl));
                res.placed++;
            }
            if (!askTaken[lvl] && lad.asks[lvl].valid && _fits(s, id, o, p, t, false, lad.asks[lvl])) {
                _place(s, id, version, p.market.asset, false, lad.asks[lvl], uint8(lvl));
                res.placed++;
            }
        }
    }

    /// Conservative worst-case reservation check: opposing orders are never netted against each other.
    function _fits(
        OrderStore storage s,
        uint256 id,
        Observation calldata o,
        Policy memory p,
        Totals memory t,
        bool isBuy,
        QuoteEngine.Level memory lvl
    ) private view returns (bool ok) {
        if (s.live[id].length >= MAX_LIVE_ORDERS) return false;
        QuoteEngine.Reserved memory next;
        (ok, next) = QuoteEngine.reservationFits(
            QuoteEngine.Reserved(t.buyLots, t.sellLots, t.buyQuoteE8, t.notionalE8),
            o.baseBalE8,
            o.quoteBalE8,
            isBuy,
            lvl.pxE8,
            lvl.szLots,
            p.market.szDecimals,
            p.exposure
        );
        if (ok) {
            t.buyLots = next.buyLots;
            t.sellLots = next.sellLots;
            t.buyQuoteE8 = next.buyQuoteE8;
            t.notionalE8 = next.notionalE8;
        }
    }

    function _place(
        OrderStore storage s,
        uint256 id,
        uint32 version,
        uint32 asset,
        bool isBuy,
        QuoteEngine.Level memory lvl,
        uint8 level
    ) private {
        uint64 n = ++s.nonce[id];
        uint128 cloid = cloidFor(id, version, n);
        s.orders[cloid] = Order({
            mandateId: id,
            version: version,
            isBuy: isBuy,
            state: OrderState.INTENT_EMITTED,
            pxE8: lvl.pxE8,
            szLots: lvl.szLots,
            filledLots: 0,
            oid: 0,
            emittedAt: uint64(block.timestamp),
            cancelRequestedAt: 0,
            level: level
        });
        s.live[id].push(cloid);
        emit PlaceIntent(id, cloid, INTENT_VERSION, version, asset, isBuy, lvl.pxE8, lvl.szLots, level);
    }

    function _requestCancel(OrderStore storage s, uint256 id, uint128 cloid, uint8 reason) private {
        Order storage ord = s.orders[cloid];
        ord.cancelRequestedAt = uint64(block.timestamp);
        emit CancelIntent(id, cloid, ord.oid, reason);
    }
}
