// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase, Vm} from "./TestBase.sol";
import {StapleDesk} from "../src/StapleDesk.sol";
import {SignedReports} from "../src/SignedReports.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {TestFeeToken} from "../src/TestFeeToken.sol";
import {IERC20Minimal} from "../src/IERC20Minimal.sol";
import {Totals} from "../src/DeskOrders.sol";
import {Accounting} from "../src/DeskAccounting.sol";
import {
    Policy,
    MarketParams,
    QuoteParams,
    ExposureParams,
    RiskParams,
    FeeParams,
    BookRule,
    MandateState,
    Halt,
    Observation,
    Outcome,
    OutcomeKind,
    Order,
    OrderState
} from "../src/StapleTypes.sol";

contract StapleDeskTest is TestBase {
    uint256 constant OP_PK = 0xA11CE;
    address operator;
    address constant GUARDIAN = address(0x6A2D);
    address constant OWNER = address(0x0BEE);
    address constant HL = address(0xC0DE);
    address constant FEES_TO = address(0xFEE5);

    TestFeeToken token;
    MandateRegistry registry;
    StapleDesk desk;
    uint256 id;
    uint64 seq;
    uint64 srcMs;
    uint64 outSeq;
    uint64 fillIds;

    uint64 constant BID = 453420000; // 4.5342
    uint64 constant ASK = 457950000; // 4.5795
    uint128 constant BASE0 = 30e8;
    uint128 constant QUOTE0 = 300e8;

    function setUp() public {
        vm.warp(1_800_000_000);
        operator = vm.addr(OP_PK);
        token = new TestFeeToken();
        registry = new MandateRegistry(IERC20Minimal(address(token)), 6, FEES_TO);
        desk = new StapleDesk(registry);
        registry.bindDesk(address(desk));
        vm.prank(OWNER);
        id = registry.createMandate(policy(), operator, GUARDIAN, HL);
        vm.startPrank(OWNER);
        token.faucet();
        token.approve(address(registry), type(uint256).max);
        registry.depositFees(id, 50e6);
        vm.stopPrank();
        srcMs = uint64(block.timestamp * 1000);
    }

    // ---------------------------------------------------------------- helpers

    function policy() internal view returns (Policy memory p) {
        p.market = MarketParams(10000, 0, true, 10e8);
        p.quotes = QuoteParams(40, 2, 20, 3, 30, 10, BookRule.JOIN);
        p.exposure = ExposureParams(30e8, 10e8, 50e8, 150e8, 100e8, 10);
        p.risk = RiskParams(5e8, 150, 60, 120, 15_000, 300, 60, 20, 45);
        p.fees = FeeParams(5, 20e6);
        p.expiry = uint64(block.timestamp + 1 days);
    }

    function obsAt(uint128 base, uint128 quote, uint64 bid, uint64 ask, uint32 unreported)
        internal
        returns (Observation memory o)
    {
        seq++;
        srcMs = uint64(block.timestamp * 1000) > srcMs ? uint64(block.timestamp * 1000) : srcMs + 1;
        o = Observation(id, seq, srcMs, bid, ask, 100000, 77692, (bid + ask) / 2, base, quote, unreported);
    }

    function tick(Observation memory o) internal {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OP_PK, desk.observationDigest(o));
        desk.tick(o, abi.encodePacked(r, s, v));
    }

    function tickBal(uint128 base, uint128 quote) internal {
        tick(obsAt(base, quote, BID, ASK, 0));
    }

    function report(Outcome[] memory outs) internal {
        outSeq++;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OP_PK, desk.outcomeBatchDigest(id, outSeq, outs));
        desk.reportOutcomes(id, outSeq, outs, abi.encodePacked(r, s, v));
    }

    function one(Outcome memory o) internal pure returns (Outcome[] memory a) {
        a = new Outcome[](1);
        a[0] = o;
    }

    function ack(uint128 cloid) internal {
        report(one(Outcome(cloid, OutcomeKind.ACK_RESTING, uint64(uint128(cloid) % 1e9) + 1, 0, 0, 0, 0, 0)));
    }

    function confirmCancel(uint128 cloid) internal {
        report(one(Outcome(cloid, OutcomeKind.CANCEL_CONFIRMED, 0, 0, 0, 0, 0, 0)));
    }

    function fill(uint128 cloid, uint64 lots, uint128 fee) internal returns (uint64 fid) {
        Order memory o = desk.getOrder(cloid);
        fid = ++fillIds;
        report(one(Outcome(cloid, OutcomeKind.FILL, 1, fid, lots, o.pxE8, fee, 0)));
    }

    function activateLive() internal {
        vm.prank(OWNER);
        desk.activate(id);
        vm.prank(GUARDIAN);
        desk.heartbeat(id);
    }

    function live() internal view returns (uint128[] memory) {
        return desk.liveCloids(id);
    }

    function ackAll() internal {
        uint128[] memory l = live();
        for (uint256 i = 0; i < l.length; i++) {
            if (desk.getOrder(l[i]).state == OrderState.INTENT_EMITTED) ack(l[i]);
        }
    }

    function confirmAllCancels() internal {
        uint128[] memory l = live();
        for (uint256 i = 0; i < l.length; i++) {
            if (desk.getOrder(l[i]).cancelRequestedAt != 0) confirmCancel(l[i]);
        }
    }

    function state() internal view returns (MandateState) {
        return desk.runtime(id).state;
    }

    function firstBuy() internal view returns (uint128) {
        uint128[] memory l = live();
        for (uint256 i = 0; i < l.length; i++) {
            if (desk.getOrder(l[i]).isBuy) return l[i];
        }
        revert("no buy");
    }

    // ------------------------------------------------------- access control

    function test_accessControl() public {
        vm.expectRevert(StapleDesk.NotOwner.selector);
        desk.activate(id);
        vm.expectRevert(MandateRegistry.NotOwner.selector);
        registry.proposePolicy(id, policy());
        vm.expectRevert(StapleDesk.NotGuardian.selector);
        desk.heartbeat(id);
        vm.expectRevert(StapleDesk.NotGuardian.selector);
        desk.reportMismatch(id, bytes32(0), "x");
        vm.expectRevert(MandateRegistry.NotDesk.selector);
        registry.chargeFee(id, 1, 1e8);
        vm.expectRevert(MandateRegistry.AlreadyBound.selector);
        registry.bindDesk(address(1));
        vm.expectRevert(MandateRegistry.NotOwner.selector);
        registry.withdrawFees(id, 1);
    }

    function test_draftRejectsObservations() public {
        Observation memory o = obsAt(BASE0, QUOTE0, BID, ASK, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OP_PK, desk.observationDigest(o));
        vm.expectRevert(abi.encodeWithSelector(StapleDesk.BadState.selector, MandateState.DRAFT));
        desk.tick(o, abi.encodePacked(r, s, v));
    }

    function test_validationRejectsUnsafePolicies() public {
        Policy memory p = policy();
        p.quotes.requoteBps = 40;
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidPolicy.selector, "quotes.requoteBps"));
        registry.createMandate(p, operator, GUARDIAN, HL);
        p = policy();
        p.market.isSpot = false;
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidPolicy.selector, "market.isSpot"));
        registry.createMandate(p, operator, GUARDIAN, HL);
        p = policy();
        p.exposure.minBaseE8 = 31e8;
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidPolicy.selector, "exposure.inventoryBounds"));
        registry.createMandate(p, operator, GUARDIAN, HL);
        p = policy();
        p.quotes.levels = 6;
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidPolicy.selector, "quotes.levels"));
        registry.createMandate(p, operator, GUARDIAN, HL);
    }

    // ------------------------------------------------- signatures + replay

    function test_badSignerRejected() public {
        activateLive();
        Observation memory o = obsAt(BASE0, QUOTE0, BID, ASK, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, desk.observationDigest(o));
        vm.expectRevert(SignedReports.BadSignature.selector);
        desk.tick(o, abi.encodePacked(r, s, v));
    }

    function test_observationReplayRejected() public {
        activateLive();
        Observation memory o = obsAt(BASE0, QUOTE0, BID, ASK, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OP_PK, desk.observationDigest(o));
        desk.tick(o, abi.encodePacked(r, s, v));
        vm.expectRevert(StapleDesk.StaleReport.selector);
        desk.tick(o, abi.encodePacked(r, s, v));
    }

    function test_domainSeparation() public {
        activateLive();
        Observation memory o = obsAt(BASE0, QUOTE0, BID, ASK, 0);
        // Signed for a different chain id: must not verify here.
        bytes32 otherDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Staple"),
                keccak256("1"),
                block.chainid + 1,
                address(desk)
            )
        );
        bytes32 ours = desk.observationDigest(o);
        bytes32 structHash = _structHashOf(o);
        assertTrue(keccak256(abi.encodePacked("\x19\x01", desk.domainSeparator(), structHash)) == ours, "hash");
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(OP_PK, keccak256(abi.encodePacked("\x19\x01", otherDomain, structHash)));
        vm.expectRevert(SignedReports.BadSignature.selector);
        desk.tick(o, abi.encodePacked(r, s, v));
        // Signed for a different desk deployment: must not verify here.
        StapleDesk other = new StapleDesk(registry);
        (v, r, s) = vm.sign(OP_PK, other.observationDigest(o));
        vm.expectRevert(SignedReports.BadSignature.selector);
        desk.tick(o, abi.encodePacked(r, s, v));
    }

    function _structHashOf(Observation memory o) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "Observation(uint256 mandateId,uint64 seq,uint64 sourceTimeMs,uint64 bestBidE8,uint64 bestAskE8,uint64 extBidDepthLots,uint64 extAskDepthLots,uint64 markE8,uint128 baseBalE8,uint128 quoteBalE8,uint32 unreportedFills)"
                ),
                o.mandateId,
                o.seq,
                o.sourceTimeMs,
                o.bestBidE8,
                o.bestAskE8,
                o.extBidDepthLots,
                o.extAskDepthLots,
                o.markE8,
                o.baseBalE8,
                o.quoteBalE8,
                o.unreportedFills
            )
        );
    }

    function test_outcomeBatchReplayRejected() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        uint128 c = live()[0];
        Outcome[] memory outs = one(Outcome(c, OutcomeKind.ACK_RESTING, 7, 0, 0, 0, 0, 0));
        outSeq++;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OP_PK, desk.outcomeBatchDigest(id, outSeq, outs));
        desk.reportOutcomes(id, outSeq, outs, abi.encodePacked(r, s, v));
        vm.expectRevert(StapleDesk.StaleReport.selector);
        desk.reportOutcomes(id, outSeq, outs, abi.encodePacked(r, s, v));
    }

    function test_cloidsUniqueAndDomainBound() public {
        assertTrue(desk.cloidFor(id, 1, 1) != desk.cloidFor(id, 1, 2), "nonce");
        assertTrue(desk.cloidFor(id, 1, 1) != desk.cloidFor(id, 2, 1), "version");
        assertTrue(desk.cloidFor(id, 1, 1) != desk.cloidFor(id + 1, 1, 1), "mandate");
        StapleDesk other = new StapleDesk(registry);
        assertTrue(desk.cloidFor(id, 1, 1) != other.cloidFor(id, 1, 1), "contract");
    }

    // ------------------------------------------------------------ live loop

    function test_failClosedUntilWatcherHeartbeat() public {
        vm.prank(OWNER);
        desk.activate(id);
        tickBal(BASE0, QUOTE0);
        assertEqU(live().length, 0, "no orders without watcher");
        assertTrue(desk.runtime(id).halt == Halt.WATCHER, "halt watcher");
        vm.prank(GUARDIAN);
        desk.heartbeat(id);
        tickBal(BASE0, QUOTE0);
        assertEqU(live().length, 4, "two levels each side");
        assertTrue(desk.runtime(id).halt == Halt.NONE, "resumed");
    }

    function test_placementsMatchLadderAndReserve() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        uint128[] memory l = live();
        assertEqU(l.length, 4, "orders");
        Totals memory t = desk.reservations(id);
        assertEqU(t.buyLots, 6, "buy lots");
        assertEqU(t.sellLots, 6, "sell lots");
        assertEqU(t.pendingCount, 4, "pending until ack");
        // 4.5477*3 + 4.5386*3 = 27.2589 quote, plus 10 bps fee allowance rounded up per order
        assertEqU(t.buyQuoteE8, 1364310000 + 1364310 + 1361580000 + 1361580, "buy quote reserved");
        // Unacknowledged placements block any further exposure.
        tickBal(BASE0, QUOTE0);
        assertEqU(live().length, 4, "no duplicate placement while pending");
        ackAll();
        tickBal(BASE0, QUOTE0);
        assertEqU(live().length, 4, "matching orders kept");
    }

    function test_cancelRequestKeepsReservationUntilConfirmed() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        ackAll();
        // External book moves ~80 bps: every order is outside the requote threshold and gets replaced.
        tick(obsAt(BASE0, QUOTE0, 457000000, 461600000, 0));
        Totals memory t = desk.reservations(id);
        // Old orders (cancel requested) and new orders both count; the outstanding-notional cap (100 USDC)
        // therefore blocks the last replacement until the old orders are confirmed cancelled.
        assertEqU(live().length, 7, "old + new live, one blocked by cap");
        assertTrue(t.notionalE8 <= 100e8, "cap respected across generations");
        assertEqU(t.buyLots, 12, "both generations of bids reserved");
        uint128[] memory l = live();
        uint256 requested;
        for (uint256 i = 0; i < l.length; i++) {
            if (desk.getOrder(l[i]).cancelRequestedAt != 0) requested++;
        }
        assertEqU(requested, 4, "four cancels requested");
        confirmAllCancels();
        t = desk.reservations(id);
        assertEqU(t.buyLots, 6, "released only after confirmation");
    }

    function test_partialFillDuringCancelAndLateFillExactlyOnce() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        ackAll();
        uint128 b = firstBuy();
        Order memory ob = desk.getOrder(b);
        fill(b, 1, 0.0004e8); // partial: 1 of 3 lots, fee in base
        assertTrue(desk.getOrder(b).state == OrderState.PARTIALLY_FILLED, "partial");
        assertEqU(desk.reservations(id).buyLots, 5, "remaining 2 + other level 3");
        vm.prank(OWNER);
        desk.pause(id);
        assertTrue(state() == MandateState.PAUSING, "pausing until confirmed");
        // A second partial fill races the cancel.
        uint64 fid = fill(b, 1, 0.0004e8);
        confirmAllCancels();
        assertTrue(state() == MandateState.PAUSED, "paused once all confirmed");
        // Late fill for the cancelled order is applied once and flagged.
        uint64 late = ++fillIds;
        report(one(Outcome(b, OutcomeKind.FILL, 1, late, 1, ob.pxE8, 0.0004e8, 0)));
        Accounting memory a = desk.getAccounting(id);
        assertEqU(a.fillCount, 3, "three fills");
        uint256 feesBefore = registry.getFees(id).spent;
        // Duplicate delivery of an already-applied fill: no accounting or fee change.
        report(one(Outcome(b, OutcomeKind.FILL, 1, fid, 1, ob.pxE8, 0.0004e8, 0)));
        assertEqU(desk.getAccounting(id).fillCount, 3, "duplicate ignored");
        assertEqU(registry.getFees(id).spent, feesBefore, "no double charge");
        assertEqU(desk.getAccounting(id).expBaseE8, BASE0 + 3 * (1e8 - 0.0004e8), "inventory exact");
    }

    function test_fillBeforeAckOutOfOrder() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        uint128 b = firstBuy();
        fill(b, 3, 0);
        assertTrue(desk.getOrder(b).state == OrderState.FILLED, "filled");
        ack(b); // late ack for a filled order is ignored
        assertTrue(desk.getOrder(b).state == OrderState.FILLED, "still filled");
    }

    function test_healthyBookStayOutCancelsAndDoesNotQuote() public {
        Policy memory p = policy();
        p.quotes.bookRule = BookRule.STAY_OUT;
        vm.prank(OWNER);
        id = registry.createMandate(p, operator, GUARDIAN, HL);
        vm.prank(OWNER);
        registry.depositFees(id, 1e6);
        activateLive();
        // Wide external book: not healthy, so the mandate quotes.
        tickBal(BASE0, QUOTE0);
        assertEqU(live().length, 4, "quotes into a thin book");
        ackAll();
        // External liquidity now meets the policy (spread <= 40 bps, depth >= 3 on both sides): stay out.
        tick(obsAt(BASE0, QUOTE0, 455600000, 455770000, 0));
        uint128[] memory l = live();
        for (uint256 i = 0; i < l.length; i++) {
            assertTrue(desk.getOrder(l[i]).cancelRequestedAt != 0, "all orders withdrawn");
        }
        confirmAllCancels();
        tick(obsAt(BASE0, QUOTE0, 455600000, 455770000, 0));
        assertEqU(live().length, 0, "no new quotes while the external book is healthy");
    }

    function test_healthyBookJoinNeverImproves() public {
        activateLive();
        tick(obsAt(BASE0, QUOTE0, 455600000, 455770000, 0));
        uint128[] memory l = live();
        assertTrue(l.length > 0, "joins");
        for (uint256 i = 0; i < l.length; i++) {
            Order memory o = desk.getOrder(l[i]);
            if (o.isBuy) assertTrue(o.pxE8 <= 455600000, "bid never above external best bid");
            else assertTrue(o.pxE8 >= 455770000, "ask never below external best ask");
        }
    }

    function test_rejectedReleasesReservation() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        uint128 b = firstBuy();
        report(one(Outcome(b, OutcomeKind.REJECTED, 0, 0, 0, 0, 0, 0)));
        assertTrue(desk.getOrder(b).state == OrderState.REJECTED, "rejected");
        assertEqU(live().length, 3, "removed");
    }

    function test_unknownOutcomeBlocksExposureThenRequiresReconciliation() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        uint128 b = firstBuy();
        report(one(Outcome(b, OutcomeKind.SUBMISSION_UNKNOWN, 0, 0, 0, 0, 0, 0)));
        assertTrue(desk.getOrder(b).state == OrderState.SUBMISSION_UNKNOWN, "unknown");
        ackAll();
        vm.warp(block.timestamp + 30);
        vm.prank(GUARDIAN);
        desk.heartbeat(id);
        tickBal(BASE0, QUOTE0);
        assertEqU(desk.reservations(id).pendingCount, 1, "unknown still reserved");
        vm.warp(block.timestamp + 31);
        vm.prank(GUARDIAN);
        desk.heartbeat(id);
        assertTrue(desk.poke(id), "acted");
        assertTrue(state() == MandateState.RECONCILIATION_REQUIRED, "missing outcome shutdown");
        // Querying shows it actually rested; then the cancel completes.
        ack(b);
        confirmAllCancels();
        assertEqU(live().length, 0, "all terminal");
        vm.prank(OWNER);
        desk.rearm(id);
        assertTrue(state() == MandateState.PAUSED, "manual re-arm to paused, never auto-resume");
    }

    // ----------------------------------------------------------- shutdowns

    function test_staleShutdownWithoutAnyNewTick() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        ackAll();
        vm.warp(block.timestamp + 16); // past maxRefAge (15 s), no further observations
        vm.recordLogs();
        assertTrue(desk.poke(id), "watchdog acted");
        assertTrue(desk.runtime(id).halt == Halt.STALE, "stale halt");
        uint256 cancels;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("CancelIntent(uint256,uint128,uint64,uint8)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == topic) cancels++;
        }
        assertEqU(cancels, 4, "cancel intents emitted by timer");
        assertTrue(!desk.poke(id), "idempotent second poke");
        // A fresh observation does not resume until every order is confirmed terminal.
        vm.prank(GUARDIAN);
        desk.heartbeat(id);
        tickBal(BASE0, QUOTE0);
        assertEqU(live().length, 4, "no new orders while old ones unconfirmed");
        confirmAllCancels();
        tickBal(BASE0, QUOTE0);
        assertTrue(desk.runtime(id).halt == Halt.NONE, "resumed after reconciliation");
        assertEqU(live().length, 4, "requoted");
    }

    function test_staleObservationRejectedForQuoting() public {
        activateLive();
        Observation memory o = obsAt(BASE0, QUOTE0, BID, ASK, 0);
        o.sourceTimeMs = uint64(block.timestamp * 1000 - 20_000);
        srcMs = o.sourceTimeMs;
        tick(o);
        assertEqU(live().length, 0, "old reference never quotes");
        assertTrue(desk.runtime(id).halt == Halt.STALE, "stale");
    }

    function test_expiryWithoutTick() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        ackAll();
        vm.warp(block.timestamp + 1 days);
        desk.poke(id);
        assertTrue(state() == MandateState.EXPIRING, "expiring: cancels unconfirmed");
        confirmAllCancels();
        assertTrue(state() == MandateState.EXPIRED, "expired after confirmation");
    }

    function test_volatilityPullsQuotesAndResumesAfterCalm() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        ackAll();
        // ~1.8% move inside the 60 s window, small enough not to hit the loss trigger.
        vm.warp(block.timestamp + 5);
        tick(obsAt(BASE0, QUOTE0, 461600000, 466200000, 0));
        assertTrue(desk.runtime(id).halt == Halt.VOLATILITY, "vol halt");
        confirmAllCancels();
        vm.warp(block.timestamp + 60);
        vm.prank(GUARDIAN);
        desk.heartbeat(id);
        tick(obsAt(BASE0, QUOTE0, 461600000, 466200000, 0));
        assertEqU(live().length, 0, "still calm period");
        vm.warp(block.timestamp + 70);
        vm.prank(GUARDIAN);
        desk.heartbeat(id);
        tick(obsAt(BASE0, QUOTE0, 461600000, 466200000, 0));
        assertTrue(desk.runtime(id).halt == Halt.NONE, "resumed");
        assertEqU(live().length, 4, "requoted after calm, fresh ref, confirmed state");
    }

    function test_deviationFromIndependentMarkStopsQuoting() public {
        activateLive();
        Observation memory o = obsAt(BASE0, QUOTE0, BID, ASK, 0);
        o.markE8 = 480000000; // 5% away from the external-book mid
        tick(o);
        assertEqU(live().length, 0, "no quotes on deviating reference");
    }

    function test_lossTriggerTripsAndReportsOvershoot() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        ackAll();
        // Price gap: 30 PURR marked ~0.25 lower = ~7.5 USDC loss vs 5 USDC trigger.
        vm.warp(block.timestamp + 61);
        vm.prank(GUARDIAN);
        desk.heartbeat(id);
        tick(obsAt(BASE0, QUOTE0, 428000000, 432000000, 0));
        assertTrue(state() == MandateState.TRIPPED, "tripped");
        Accounting memory a = desk.getAccounting(id);
        assertTrue(a.lossAtTriggerE8 > 5e8, "loss exceeded threshold before detection: overshoot reported");
        assertTrue(a.tripCancelConfirmedAt == 0, "cancels pending");
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(StapleDesk.LiveOrdersOutstanding.selector, 4));
        desk.rearm(id);
        confirmAllCancels();
        assertTrue(desk.getAccounting(id).tripCancelConfirmedAt != 0, "confirmed time recorded");
        // Peak loss keeps tracking residual inventory after shutdown.
        tick(obsAt(BASE0, QUOTE0, 420000000, 424000000, 0));
        assertTrue(desk.getAccounting(id).peakLossE8 > a.lossAtTriggerE8, "peak tracked after trip");
        vm.prank(OWNER);
        desk.rearm(id);
        assertTrue(state() == MandateState.PAUSED, "manual re-arm");
    }

    function test_feeExhaustionStopsPlacementButCancelStillWorks() public {
        // Fresh mandate with a tiny prepaid balance.
        vm.startPrank(OWNER);
        uint256 id2 = registry.createMandate(policy(), operator, GUARDIAN, HL);
        registry.depositFees(id2, 1); // 0.000001 tFEE
        vm.stopPrank();
        id = id2;
        activateLive();
        tickBal(BASE0, QUOTE0);
        ackAll();
        uint128 b = firstBuy();
        fill(b, 3, 0); // fee 0.0068 tFEE > balance: balance drained, remainder owed
        assertTrue(registry.getFees(id).owed > 0, "owed");
        Observation memory o = obsAt(BASE0 + 3e8, QUOTE0 - 1364310000, BID, ASK, 0);
        tick(o);
        assertTrue(desk.runtime(id).halt == Halt.FEES, "fees halt");
        uint128[] memory l = live();
        for (uint256 i = 0; i < l.length; i++) {
            assertTrue(desk.getOrder(l[i]).cancelRequestedAt != 0, "cancel requested regardless of fees");
        }
        vm.prank(OWNER);
        desk.pause(id);
        confirmAllCancels();
        assertTrue(state() == MandateState.PAUSED, "pause works with no prepaid fees");
    }

    function test_unrelatedAccountActivityRequiresReconciliation() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        ackAll();
        tickBal(BASE0, QUOTE0 + 50e8); // deposit that no fill explains
        assertTrue(state() == MandateState.RECONCILIATION_REQUIRED, "paused for reconciliation");
    }

    function test_unreportedFillsWaitThenTimeout() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        ackAll();
        tick(obsAt(BASE0 + 3e8, QUOTE0 - 1364310000, BID, ASK, 1));
        assertTrue(desk.runtime(id).halt == Halt.UNRECONCILED, "waiting for fill report");
        assertTrue(state() == MandateState.ACTIVE, "still active while within timeout");
        vm.warp(block.timestamp + 61);
        tick(obsAt(BASE0 + 3e8, QUOTE0 - 1364310000, BID, ASK, 1));
        assertTrue(state() == MandateState.RECONCILIATION_REQUIRED, "timeout");
    }

    function test_overfillIsExecutionMismatch() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        uint128 b = firstBuy();
        fill(b, 5, 0); // intent allowed 3
        assertTrue(state() == MandateState.RECONCILIATION_REQUIRED, "mismatch");
    }

    function test_watcherMismatchStopsNewExposure() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        vm.prank(GUARDIAN);
        desk.reportMismatch(id, keccak256("unknown oid 42"), "order without intent");
        assertTrue(state() == MandateState.RECONCILIATION_REQUIRED, "recon");
        tickBal(BASE0, QUOTE0);
        uint128[] memory l = live();
        for (uint256 i = 0; i < l.length; i++) {
            assertTrue(desk.getOrder(l[i]).cancelRequestedAt != 0, "all cancelling");
        }
        assertEqU(l.length, 4, "no new orders");
    }

    function test_watcherTimeoutViaPoke() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        vm.warp(block.timestamp + 10);
        tickBal(BASE0, QUOTE0);
        vm.warp(block.timestamp + 40); // watcher last beat 50 s ago (> 45 s); reference 0 s old
        tickBal(BASE0, QUOTE0);
        assertTrue(desk.runtime(id).halt == Halt.WATCHER, "fail-closed on watcher outage");
    }

    // ------------------------------------------------------------ owner exit

    function test_cancelAllAndRevokeFlow() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        ackAll();
        vm.prank(OWNER);
        desk.requestRevoke(id);
        assertTrue(state() == MandateState.REVOKING, "revoking");
        confirmAllCancels();
        assertTrue(state() == MandateState.REVOKING, "orders gone but agent not yet confirmed removed");
        vm.prank(GUARDIAN);
        desk.reportAgentRevoked(id);
        assertTrue(state() == MandateState.REVOKED, "revoked after both confirmations");
    }

    function test_revocationObservedBeforeOrdersGoneStaysRevoking() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        vm.prank(OWNER);
        desk.requestRevoke(id);
        vm.prank(OWNER);
        desk.reportAgentRevoked(id);
        assertTrue(state() == MandateState.REVOKING, "revocation does not cancel resting orders");
        confirmAllCancels();
        assertTrue(state() == MandateState.REVOKED, "revoked");
    }

    // ------------------------------------------------------------ versioning

    function test_riskIncreasingEditWaitsNoticeAndOldOrdersFirst() public {
        activateLive();
        tickBal(BASE0, QUOTE0);
        ackAll();
        Policy memory p = policy();
        p.quotes.sizeLots = 4;
        vm.prank(OWNER);
        uint32 v = registry.proposePolicy(id, p);
        assertEqU(v, 2, "v2");
        assertEqU(registry.versionEffectiveAt(id, 2), block.timestamp + 60, "notice");
        tickBal(BASE0, QUOTE0);
        assertEqU(desk.activeVersion(id), 1, "still v1 during notice");
        vm.warp(block.timestamp + 61);
        vm.prank(GUARDIAN);
        desk.heartbeat(id);
        tickBal(BASE0, QUOTE0);
        assertTrue(desk.runtime(id).halt == Halt.VERSION_SWITCH, "cancelling v1 orders first");
        assertEqU(desk.activeVersion(id), 1, "not switched while v1 orders live");
        confirmAllCancels();
        assertEqU(desk.activeVersion(id), 2, "switched once v1 terminal");
        tickBal(BASE0, QUOTE0);
        assertEqU(desk.getOrder(live()[0]).szLots, 4, "v2 sizes");
    }

    function test_riskReducingEditImmediate() public {
        Policy memory p = policy();
        p.quotes.spreadBps = 60;
        vm.prank(OWNER);
        registry.proposePolicy(id, p);
        assertEqU(registry.versionEffectiveAt(id, 2), block.timestamp, "immediate");
        activateLive();
        assertEqU(desk.activeVersion(id), 2, "applied at activation");
    }

    function test_marketIsImmutableAcrossVersions() public {
        Policy memory p = policy();
        p.market.asset = 10001;
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidPolicy.selector, "market.immutable"));
        registry.proposePolicy(id, p);
    }

    // ---------------------------------------------------------------- fuzz

    /// Under any reconciled balances, a quoting pass never breaches the worst-case inventory bounds or budgets.
    function testFuzz_reservationInvariants(uint128 base, uint128 quote, uint64 bidOff) public {
        base = uint128(bound(base, 0, 80e8));
        quote = uint128(bound(quote, 0, 400e8));
        uint64 bid = uint64(bound(bidOff, 400000000, 500000000));
        uint64 ask = bid + 4500000;
        activateLive();
        tick(obsAt(base, quote, bid, ask, 0));
        Totals memory t = desk.reservations(id);
        Policy memory p = policy();
        assertTrue(uint256(base) + t.buyLots * 1e8 <= p.exposure.maxBaseE8 || t.buyLots == 0, "max inventory");
        assertTrue(t.sellLots == 0 || uint256(base) >= t.sellLots * 1e8 + p.exposure.minBaseE8, "min inventory");
        assertTrue(t.sellLots * 1e8 <= base, "sells covered by balance");
        assertTrue(t.buyQuoteE8 <= p.exposure.quoteBudgetE8 && t.buyQuoteE8 <= quote, "quote budget");
        assertTrue(t.notionalE8 <= p.exposure.maxOutstandingNotionalE8, "outstanding");
    }

    function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + (x % (hi - lo + 1));
    }
}
