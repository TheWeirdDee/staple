// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    MandateState,
    Halt,
    Reason,
    Policy,
    Order,
    OrderState,
    Observation,
    Outcome,
    OutcomeKind
} from "./StapleTypes.sol";
import {MandateRegistry} from "./MandateRegistry.sol";
import {SignedReports} from "./SignedReports.sol";
import {Accounting, DeskAccounting} from "./DeskAccounting.sol";
import {OrderStore, Totals, QuoteResult, DeskOrders} from "./DeskOrders.sol";

/// Lifecycle, decisions, risk state, accounting and intent generation (StapleDesk), the versioned intent
/// interface (IntentGateway events), authenticated observations (BookSource) and idempotent outcomes
/// (OutcomeSink).
///
/// Authority boundary: this contract constrains the intents it emits. The keeper's HyperCore agent key can
/// still trade outside them; the independent watcher detects that after the fact and cannot undo trades.
/// Pausing here does not revoke the agent on HyperCore.
contract StapleDesk is SignedReports {
    uint16 public constant INTENT_VERSION = 1;

    MandateRegistry public immutable registry;

    struct Runtime {
        MandateState state;
        Halt halt;
        bool agentRevokedObserved;
        uint32 activeVersion;
        uint64 activatedAt;
        uint64 lastSeq;
        uint64 lastSourceTimeMs;
        uint64 lastObsAt;
        uint64 lastOutcomeSeq;
        uint64 lastWatcherBeat;
        uint64 unreconciledSince;
        uint64 calmUntil;
        uint64 volWindowStart;
        uint64 volWindowMidE8;
    }

    struct DecisionData {
        uint64 midE8;
        uint64 reservationE8;
        int32 skewBps;
        uint32 refAgeMs;
        uint16 placed;
        uint16 cancelled;
        uint8 reason;
    }

    mapping(uint256 => Runtime) internal _rt;
    mapping(uint256 => Accounting) internal _acct;
    OrderStore internal _os;

    event StateChanged(uint256 indexed mandateId, MandateState from, MandateState to, uint8 reason);
    event HaltChanged(uint256 indexed mandateId, Halt halt, uint8 reason);
    event VersionActivated(uint256 indexed mandateId, uint32 version);
    // IntentGateway
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
    event Decision(
        uint256 indexed mandateId,
        uint64 indexed seq,
        uint32 policyVersion,
        uint8 reason,
        uint64 midE8,
        uint64 reservationE8,
        int32 skewBps,
        uint32 refAgeMs,
        uint128 inventoryE8,
        uint16 placed,
        uint16 cancelled
    );
    // OutcomeSink
    event OutcomeApplied(uint256 indexed mandateId, uint128 indexed cloid, OutcomeKind kind, OrderState state);
    event FillApplied(
        uint256 indexed mandateId,
        uint128 indexed cloid,
        uint64 fillId,
        bool isBuy,
        uint64 szLots,
        uint64 pxE8,
        uint128 exchangeFeeE8,
        uint256 serviceFee
    );
    event DuplicateIgnored(uint256 indexed mandateId, uint128 indexed cloid, uint64 fillId, OutcomeKind kind);
    event LateFill(uint256 indexed mandateId, uint128 indexed cloid, uint64 fillId);
    event CancelOverdue(uint256 indexed mandateId, uint128 indexed cloid, uint64 requestedAt);
    event LossTriggered(uint256 indexed mandateId, int256 lossE8, uint128 thresholdE8);
    event Heartbeat(uint256 indexed mandateId, address guardian);
    event MismatchReported(uint256 indexed mandateId, bytes32 evidenceHash, string detail);
    event AgentRevocationObserved(uint256 indexed mandateId, address reporter);

    error NotOwner();
    error NotGuardian();
    error BadState(MandateState state);
    error LiveOrdersOutstanding(uint256 count);
    error StaleReport();
    error UnknownOrder(uint128 cloid);
    error Expired();
    error FeesUnavailable();

    constructor(MandateRegistry registry_) {
        registry = registry_;
    }

    modifier onlyOwner(uint256 id) {
        if (registry.ownerOf(id) != msg.sender) revert NotOwner();
        _;
    }

    // ------------------------------------------------------------- lifecycle

    function activate(uint256 id) external onlyOwner(id) {
        Runtime storage r = _rt[id];
        if (r.state != MandateState.DRAFT && r.state != MandateState.PAUSED) revert BadState(r.state);
        if (_os.live[id].length != 0) revert LiveOrdersOutstanding(_os.live[id].length);
        if (r.activeVersion == 0) r.activeVersion = 1;
        _maybeSwitchVersion(id);
        Policy memory p = registry.getPolicy(id, r.activeVersion);
        if (p.expiry <= block.timestamp) revert Expired();
        if (!registry.feesOk(id, r.activeVersion)) revert FeesUnavailable();
        uint64 epoch = _acct[id].epoch + 1;
        delete _acct[id];
        _acct[id].epoch = epoch;
        r.activatedAt = uint64(block.timestamp);
        r.unreconciledSince = 0;
        r.volWindowStart = 0;
        r.calmUntil = 0;
        r.agentRevokedObserved = false;
        // Fail closed until the independent watcher proves it is alive.
        r.lastWatcherBeat = 0;
        _setHalt(id, Halt.WATCHER, Reason.WATCHER_STALE);
        _setState(id, MandateState.ACTIVE, Reason.QUOTED);
    }

    function pause(uint256 id) external onlyOwner(id) {
        MandateState s = _rt[id].state;
        if (
            s == MandateState.DRAFT || s == MandateState.PAUSED || s == MandateState.REVOKED
                || s == MandateState.EXPIRED || s == MandateState.REVOKING || s == MandateState.PAUSING
        ) revert BadState(s);
        _setState(id, MandateState.PAUSING, Reason.OWNER_PAUSE);
        DeskOrders.cancelAll(_os, id, Reason.OWNER_PAUSE);
        _settle(id);
    }

    /// Step 1 of "cancel all and revoke". Agent revocation itself happens on HyperCore with the owner's key.
    function requestRevoke(uint256 id) external onlyOwner(id) {
        MandateState s = _rt[id].state;
        if (s == MandateState.REVOKED || s == MandateState.REVOKING) revert BadState(s);
        _setState(id, MandateState.REVOKING, Reason.OWNER_REVOKE);
        DeskOrders.cancelAll(_os, id, Reason.OWNER_REVOKE);
        _settle(id);
    }

    /// Records that agent removal was observed on HyperCore, by the owner or the independent watcher.
    function reportAgentRevoked(uint256 id) external {
        (address owner,, address guardian) = registry.roles(id);
        if (msg.sender != owner && msg.sender != guardian) revert NotGuardian();
        Runtime storage r = _rt[id];
        if (r.state != MandateState.REVOKING) revert BadState(r.state);
        r.agentRevokedObserved = true;
        emit AgentRevocationObserved(id, msg.sender);
        _settle(id);
    }

    /// Manual re-arm after a loss trigger or reconciliation failure. Never resumes quoting by itself.
    function rearm(uint256 id) external onlyOwner(id) {
        MandateState s = _rt[id].state;
        if (s != MandateState.TRIPPED && s != MandateState.RECONCILIATION_REQUIRED) revert BadState(s);
        if (_os.live[id].length != 0) revert LiveOrdersOutstanding(_os.live[id].length);
        _setState(id, MandateState.PAUSED, Reason.WAITING_RECONCILE);
    }

    function _maybeSwitchVersion(uint256 id) internal {
        Runtime storage r = _rt[id];
        MandateRegistry.Identity memory ident = registry.identity(id);
        if (ident.pendingVersion == 0 || block.timestamp < ident.pendingEffectiveAt) return;
        if (_os.live[id].length > 0) {
            _setHalt(id, Halt.VERSION_SWITCH, Reason.VERSION_SWITCH);
            DeskOrders.cancelAll(_os, id, Reason.VERSION_SWITCH);
            return;
        }
        uint32 v = registry.consumePending(id);
        if (v == 0) return;
        r.activeVersion = v;
        emit VersionActivated(id, v);
        if (r.halt == Halt.VERSION_SWITCH) _setHalt(id, Halt.NONE, Reason.VERSION_SWITCH);
    }

    // ------------------------------------------------------------ BookSource

    function tick(Observation calldata o, bytes calldata sig) external {
        uint256 id = o.mandateId;
        Runtime storage r = _rt[id];
        if (r.state == MandateState.DRAFT) revert BadState(r.state);
        (, address operator,) = registry.roles(id);
        if (_recover(observationDigest(o), sig) != operator) revert BadSignature();
        if (o.seq <= r.lastSeq || o.sourceTimeMs <= r.lastSourceTimeMs) revert StaleReport();
        r.lastSeq = o.seq;
        r.lastSourceTimeMs = o.sourceTimeMs;

        Policy memory p = registry.getPolicy(id, r.activeVersion);
        DecisionData memory d;
        uint256 nowMs = block.timestamp * 1000;
        d.refAgeMs = nowMs > o.sourceTimeMs ? uint32(_min(nowMs - o.sourceTimeMs, type(uint32).max)) : 0;

        DeskOrders.retryOverdueCancels(_os, id, p.risk.cancelTimeoutSec);
        if (d.refAgeMs > p.risk.maxRefAgeMs) {
            _stopQuoting(id, Halt.STALE, Reason.STALE_REFERENCE);
            return _finish(id, o, d, Reason.STALE_REFERENCE);
        }
        r.lastObsAt = uint64(block.timestamp);

        if (DeskOrders.missingOutcome(_os, id, p.risk.reconTimeoutSec)) {
            _requireReconciliation(id, Reason.MISSING_OUTCOME);
            return _finish(id, o, d, Reason.MISSING_OUTCOME);
        }

        // Reconcile: snapshot + ingested fills must explain the observed account while orders may execute.
        Accounting storage a = _acct[id];
        bool active = r.state == MandateState.ACTIVE;
        // Once nothing can execute (PAUSED, REVOKED, EXPIRED) the owner may use the account freely; the next
        // activation takes a fresh snapshot, so deposits and withdrawals never count as trading profit.
        bool exposed =
            r.state != MandateState.PAUSED && r.state != MandateState.REVOKED && r.state != MandateState.EXPIRED;
        if (active && !a.snapshotTaken) {
            if (o.unreportedFills != 0 || o.bestBidE8 == 0 || o.bestAskE8 == 0) {
                return _finish(id, o, d, Reason.WAITING_RECONCILE);
            }
            DeskAccounting.takeSnapshot(a, o);
        }
        if (exposed && a.snapshotTaken && !DeskAccounting.balancesMatch(a, o)) {
            if (
                o.unreportedFills == 0
                    || (r.unreconciledSince != 0 && block.timestamp - r.unreconciledSince > p.risk.reconTimeoutSec)
            ) {
                _requireReconciliation(id, Reason.UNRECONCILED_BALANCE);
                return _finish(id, o, d, Reason.UNRECONCILED_BALANCE);
            }
            if (r.unreconciledSince == 0) r.unreconciledSince = uint64(block.timestamp);
            _stopQuoting(id, Halt.UNRECONCILED, Reason.WAITING_RECONCILE);
            return _finish(id, o, d, Reason.WAITING_RECONCILE);
        }
        r.unreconciledSince = 0;

        if (o.bestBidE8 == 0 || o.bestAskE8 == 0 || o.bestAskE8 <= o.bestBidE8) {
            _stopQuoting(id, Halt.STALE, Reason.NO_BOOK);
            return _finish(id, o, d, Reason.NO_BOOK);
        }
        d.midE8 = uint64((uint256(o.bestBidE8) + o.bestAskE8) / 2);
        if (o.markE8 == 0 || _absDiff(d.midE8, o.markE8) * 10_000 > uint256(p.risk.maxDeviationBps) * o.markE8) {
            _stopQuoting(id, Halt.STALE, Reason.DEVIATION);
            return _finish(id, o, d, Reason.DEVIATION);
        }

        // Mark-to-market and loss trigger (a shutdown trigger, not a loss cap).
        if (exposed && a.snapshotTaken) {
            int256 loss = DeskAccounting.mark(a, o, d.midE8);
            if (active && loss >= int256(uint256(p.risk.lossTriggerQuoteE8))) {
                a.lossTriggeredAt = uint64(block.timestamp);
                a.lossAtTriggerE8 = a.lastLossE8;
                emit LossTriggered(id, a.lastLossE8, p.risk.lossTriggerQuoteE8);
                _setState(id, MandateState.TRIPPED, Reason.LOSS_TRIGGER);
                DeskOrders.cancelAll(_os, id, Reason.LOSS_TRIGGER);
                _settle(id);
                return _finish(id, o, d, Reason.LOSS_TRIGGER);
            }
        }

        if (!active) {
            _settle(id);
            return _finish(id, o, d, Reason.WAITING_RECONCILE);
        }
        if (block.timestamp >= p.expiry) {
            _setState(id, MandateState.EXPIRING, Reason.EXPIRY);
            DeskOrders.cancelAll(_os, id, Reason.EXPIRY);
            _settle(id);
            return _finish(id, o, d, Reason.EXPIRY);
        }
        _maybeSwitchVersion(id);
        if (r.halt == Halt.VERSION_SWITCH) return _finish(id, o, d, Reason.VERSION_SWITCH);
        p = registry.getPolicy(id, r.activeVersion);

        if (_volatile(r, d.midE8, p.risk.volBps, p.risk.volWindowSec)) {
            r.calmUntil = uint64(block.timestamp) + p.risk.calmSec;
            _stopQuoting(id, Halt.VOLATILITY, Reason.VOLATILITY);
            return _finish(id, o, d, Reason.VOLATILITY);
        }
        if (r.halt == Halt.VOLATILITY && block.timestamp < r.calmUntil) return _finish(id, o, d, Reason.VOLATILITY);
        if (r.lastWatcherBeat == 0 || block.timestamp - r.lastWatcherBeat > p.risk.watcherTimeoutSec) {
            _stopQuoting(id, Halt.WATCHER, Reason.WATCHER_STALE);
            return _finish(id, o, d, Reason.WATCHER_STALE);
        }
        if (!registry.feesOk(id, r.activeVersion)) {
            // Stops new placements only; cancellation never needs prepaid fees.
            _stopQuoting(id, Halt.FEES, Reason.FEES_EXHAUSTED);
            return _finish(id, o, d, Reason.FEES_EXHAUSTED);
        }
        // Every halt resumes only after a fresh, reconciled observation with no unresolved orders.
        if (r.halt != Halt.NONE) {
            if (_os.live[id].length != 0) return _finish(id, o, d, Reason.WAITING_RECONCILE);
            _setHalt(id, Halt.NONE, Reason.QUOTED);
        }
        QuoteResult memory q = DeskOrders.quote(_os, id, r.activeVersion, o, p);
        d.reservationE8 = q.reservationE8;
        d.skewBps = q.skewBps;
        d.placed = q.placed;
        d.cancelled = q.cancelled;
        _finish(id, o, d, q.reason);
    }

    // ------------------------------------------------------------ halts

    function _stopQuoting(uint256 id, Halt h, uint8 reason) internal {
        if (_rt[id].state == MandateState.ACTIVE) _setHalt(id, h, reason);
        DeskOrders.cancelAll(_os, id, reason);
    }

    function _requireReconciliation(uint256 id, uint8 reason) internal {
        if (_rt[id].state == MandateState.ACTIVE) _setState(id, MandateState.RECONCILIATION_REQUIRED, reason);
        DeskOrders.cancelAll(_os, id, reason);
    }

    function _finish(uint256 id, Observation calldata o, DecisionData memory d, uint8 reason) internal {
        emit Decision(
            id,
            o.seq,
            _rt[id].activeVersion,
            reason,
            d.midE8,
            d.reservationE8,
            d.skewBps,
            d.refAgeMs,
            o.baseBalE8,
            d.placed,
            d.cancelled
        );
    }

    // ----------------------------------------------------------- OutcomeSink

    function reportOutcomes(uint256 id, uint64 batchSeq, Outcome[] calldata outs, bytes calldata sig) external {
        Runtime storage r = _rt[id];
        (, address operator,) = registry.roles(id);
        if (_recover(outcomeBatchDigest(id, batchSeq, outs), sig) != operator) revert BadSignature();
        if (batchSeq <= r.lastOutcomeSeq) revert StaleReport();
        r.lastOutcomeSeq = batchSeq;
        for (uint256 i = 0; i < outs.length; i++) {
            _apply(id, outs[i]);
        }
        _settle(id);
    }

    function _apply(uint256 id, Outcome calldata out) internal {
        (bool isFill, bool terminal) = DeskOrders.applyStatus(_os, id, out);
        if (isFill) _applyFill(id, _os.orders[out.cloid], out, terminal);
    }

    function _applyFill(uint256 id, Order storage ord, Outcome calldata out, bool terminal) internal {
        (bool applied, bool overfill) = DeskOrders.recordFill(_os, id, out, terminal);
        if (!applied) return;
        // The exchange reported more than this intent allowed: execution outside policy.
        if (overfill) _requireReconciliation(id, Reason.MISMATCH);
        Policy memory p = registry.getPolicy(id, ord.version);
        Accounting storage a = _acct[id];
        uint256 notional = DeskAccounting.applyFill(a, ord.isBuy, out.szLots, out.pxE8, out.feeE8, p.market.szDecimals);
        uint256 svc = registry.chargeFee(id, ord.version, notional);
        a.serviceFeesCharged += svc;
        emit FillApplied(id, out.cloid, out.fillId, ord.isBuy, out.szLots, out.pxE8, out.feeE8, svc);
    }

    // ------------------------------------------------- watchdog + guardian

    /// Permissionless timer entry point: enforces expiry, staleness, watcher liveness and missing outcomes even
    /// when no observations arrive. The independent watcher calls it on its own schedule.
    function poke(uint256 id) external returns (bool acted) {
        Runtime storage r = _rt[id];
        if (r.state == MandateState.DRAFT) return false;
        Policy memory p = registry.getPolicy(id, r.activeVersion);
        DeskOrders.retryOverdueCancels(_os, id, p.risk.cancelTimeoutSec);
        if (r.state == MandateState.ACTIVE) {
            if (block.timestamp >= p.expiry) {
                _setState(id, MandateState.EXPIRING, Reason.EXPIRY);
                DeskOrders.cancelAll(_os, id, Reason.EXPIRY);
                acted = true;
            } else if (DeskOrders.missingOutcome(_os, id, p.risk.reconTimeoutSec)) {
                _requireReconciliation(id, Reason.MISSING_OUTCOME);
                acted = true;
            } else if (block.timestamp * 1000 > uint256(r.lastSourceTimeMs) + p.risk.maxRefAgeMs) {
                acted = r.halt != Halt.STALE || DeskOrders.hasUncancelled(_os, id);
                _stopQuoting(id, Halt.STALE, Reason.STALE_REFERENCE);
            } else if (r.lastWatcherBeat == 0 || block.timestamp - r.lastWatcherBeat > p.risk.watcherTimeoutSec) {
                acted = r.halt != Halt.WATCHER || DeskOrders.hasUncancelled(_os, id);
                _stopQuoting(id, Halt.WATCHER, Reason.WATCHER_STALE);
            }
        }
        _settle(id);
    }

    function heartbeat(uint256 id) external {
        (,, address guardian) = registry.roles(id);
        if (msg.sender != guardian) revert NotGuardian();
        _rt[id].lastWatcherBeat = uint64(block.timestamp);
        emit Heartbeat(id, msg.sender);
    }

    /// The independent watcher saw exchange activity that no intent explains. Stops new exposure; it cannot
    /// undo trades or revoke the agent.
    function reportMismatch(uint256 id, bytes32 evidenceHash, string calldata detail) external {
        (,, address guardian) = registry.roles(id);
        if (msg.sender != guardian) revert NotGuardian();
        emit MismatchReported(id, evidenceHash, detail);
        _requireReconciliation(id, Reason.MISMATCH);
    }

    // --------------------------------------------------------------- helpers

    function _settle(uint256 id) internal {
        if (_os.live[id].length != 0) return;
        Runtime storage r = _rt[id];
        if (r.state == MandateState.PAUSING) _setState(id, MandateState.PAUSED, Reason.OWNER_PAUSE);
        else if (r.state == MandateState.EXPIRING) _setState(id, MandateState.EXPIRED, Reason.EXPIRY);
        else if (r.state == MandateState.REVOKING && r.agentRevokedObserved) {
            _setState(id, MandateState.REVOKED, Reason.OWNER_REVOKE);
        }
        Accounting storage a = _acct[id];
        if (a.lossTriggeredAt != 0 && a.tripCancelConfirmedAt == 0) a.tripCancelConfirmedAt = uint64(block.timestamp);
        if (r.halt == Halt.VERSION_SWITCH) _maybeSwitchVersion(id);
    }

    function _setState(uint256 id, MandateState to, uint8 reason) internal {
        Runtime storage r = _rt[id];
        MandateState from = r.state;
        if (from == to) return;
        r.state = to;
        emit StateChanged(id, from, to, reason);
    }

    function _setHalt(uint256 id, Halt h, uint8 reason) internal {
        Runtime storage r = _rt[id];
        if (r.halt == h) return;
        r.halt = h;
        emit HaltChanged(id, h, reason);
    }

    function _volatile(Runtime storage r, uint64 mid, uint16 volBps, uint32 windowSec) internal returns (bool) {
        if (r.volWindowStart == 0 || block.timestamp - r.volWindowStart > windowSec) {
            r.volWindowStart = uint64(block.timestamp);
            r.volWindowMidE8 = mid;
            return false;
        }
        return _absDiff(mid, r.volWindowMidE8) * 10_000 > uint256(volBps) * r.volWindowMidE8;
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // ----------------------------------------------------------------- views

    function runtime(uint256 id) external view returns (Runtime memory) {
        return _rt[id];
    }

    function activeVersion(uint256 id) public view returns (uint32) {
        uint32 v = _rt[id].activeVersion;
        return v == 0 ? 1 : v;
    }

    /// Nothing can execute: used by the registry to allow role changes.
    function isQuiescent(uint256 id) external view returns (bool) {
        MandateState s = _rt[id].state;
        return _os.live[id].length == 0
            && (s == MandateState.DRAFT || s == MandateState.PAUSED || s == MandateState.REVOKED
                || s == MandateState.EXPIRED);
    }

    function getAccounting(uint256 id) external view returns (Accounting memory) {
        return _acct[id];
    }

    function reservations(uint256 id) external view returns (Totals memory) {
        Policy memory p = registry.getPolicy(id, activeVersion(id));
        return DeskOrders.totals(_os, id, p.market.szDecimals, p.exposure.feeAllowanceBps);
    }

    /// Client order ids of every potentially executable order; read each with getOrder.
    function liveCloids(uint256 id) external view returns (uint128[] memory) {
        return _os.live[id];
    }

    /// Unique client order id derived from chain, contract, mandate, policy version and intent nonce.
    function cloidFor(uint256 id, uint32 version, uint64 nonce) external view returns (uint128) {
        return DeskOrders.cloidFor(id, version, nonce);
    }

    function intentNonce(uint256 id) external view returns (uint64) {
        return _os.nonce[id];
    }

    function getOrder(uint128 cloid) external view returns (Order memory) {
        return _os.orders[cloid];
    }

    function fillSeen(uint256 id, uint64 fillId) external view returns (bool) {
        return _os.fillSeen[id][fillId];
    }
}
