// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Unit conventions (see docs/units.md):
//  - pxE8:      price in quote per 1 whole base token, scaled by 1e8 (HyperCore spot allows at most 8 decimals).
//  - lots:      order size in units of 10^-szDecimals base tokens (HyperCore lot size).
//  - baseE8:    base token amount scaled by 1e8.
//  - quoteE8:   quote (USDC) amount scaled by 1e8.
//  - bps:       1/10_000.
// Rounding: bids round down, asks round up, reservations round up, credited proceeds round down.

// Maximum quote levels per side; bounds every per-tick loop.
uint256 constant MAX_LEVELS = 5;

enum MandateState {
    DRAFT,
    ACTIVE,
    PAUSING,
    PAUSED,
    TRIPPED,
    REVOKING,
    REVOKED,
    EXPIRING,
    EXPIRED,
    RECONCILIATION_REQUIRED
}

enum OrderState {
    NONE,
    INTENT_EMITTED,
    SUBMISSION_UNKNOWN,
    ACKNOWLEDGED,
    RESTING,
    PARTIALLY_FILLED,
    FILLED,
    CANCELLED,
    REJECTED
}

/// Behaviour when external liquidity already satisfies the policy.
enum BookRule {
    STAY_OUT,
    JOIN
}

/// Why quoting is currently withheld while the mandate remains ACTIVE.
enum Halt {
    NONE,
    STALE,
    VOLATILITY,
    FEES,
    WATCHER,
    UNRECONCILED,
    VERSION_SWITCH
}

/// Decision and cancellation reason codes, published with every decision so the public page can explain it.
library Reason {
    uint8 internal constant QUOTED = 1;
    uint8 internal constant HEALTHY_STAY_OUT = 2;
    uint8 internal constant HEALTHY_JOIN = 3;
    uint8 internal constant STALE_REFERENCE = 4;
    uint8 internal constant DEVIATION = 5;
    uint8 internal constant VOLATILITY = 6;
    uint8 internal constant LOSS_TRIGGER = 7;
    uint8 internal constant FEES_EXHAUSTED = 8;
    uint8 internal constant UNRECONCILED_BALANCE = 9;
    uint8 internal constant MISSING_OUTCOME = 10;
    uint8 internal constant WATCHER_STALE = 11;
    uint8 internal constant EXPIRY = 12;
    uint8 internal constant OWNER_PAUSE = 13;
    uint8 internal constant OWNER_REVOKE = 14;
    uint8 internal constant REQUOTE = 15;
    uint8 internal constant MISMATCH = 16;
    uint8 internal constant VERSION_SWITCH = 17;
    uint8 internal constant NO_BOOK = 18;
    uint8 internal constant WAITING_RECONCILE = 19;
    uint8 internal constant CANCEL_RETRY = 20;
}

struct MarketParams {
    uint32 asset; // HyperCore order asset id (10000 + spot index)
    uint8 szDecimals;
    bool isSpot;
    uint64 minNotionalE8; // HyperCore minimum order value in quote
}

struct QuoteParams {
    uint16 spreadBps; // full target spread between best Staple bid and ask
    uint8 levels; // per side, 1..MAX_LEVELS
    uint16 levelSpacingBps;
    uint64 sizeLots; // per level
    uint16 skewBps; // max reservation-price shift at a full inventory deviation
    uint16 requoteBps; // keep an order while its price is within this distance of the target
    BookRule bookRule;
}

struct ExposureParams {
    uint128 baselineBaseE8;
    uint128 minBaseE8;
    uint128 maxBaseE8;
    uint128 quoteBudgetE8; // maximum quote committed to buy reservations
    uint128 maxOutstandingNotionalE8; // both sides, all potentially executable orders
    uint16 feeAllowanceBps; // conservative exchange-fee allowance added to buy reservations
}

struct RiskParams {
    uint128 lossTriggerQuoteE8; // shutdown trigger, not a loss cap
    uint16 volBps;
    uint32 volWindowSec;
    uint32 calmSec;
    uint32 maxRefAgeMs;
    uint16 maxDeviationBps; // between external-book mid and independent mark
    uint32 reconTimeoutSec;
    uint32 cancelTimeoutSec;
    uint32 watcherTimeoutSec;
}

struct FeeParams {
    uint16 feeBps; // service fee on executed notional
    uint128 spendCap; // fee-token units
}

struct Policy {
    MarketParams market;
    QuoteParams quotes;
    ExposureParams exposure;
    RiskParams risk;
    FeeParams fees;
    uint64 expiry; // unix seconds
}

/// Keeper-reported view of the external book and the owner's HyperCore account.
struct Observation {
    uint256 mandateId;
    uint64 seq; // strictly increasing per mandate
    uint64 sourceTimeMs; // HyperCore book timestamp, strictly increasing
    uint64 bestBidE8; // external best bid excluding known Staple orders (0 = none)
    uint64 bestAskE8; // external best ask excluding known Staple orders (0 = none)
    uint64 extBidDepthLots; // external size at best bid
    uint64 extAskDepthLots;
    uint64 markE8; // independent reference (HyperCore mark/oracle) for deviation checks
    uint128 baseBalE8; // total base balance (includes amounts on hold for resting orders)
    uint128 quoteBalE8;
    uint32 unreportedFills; // fills seen on the exchange but not yet ingested
}

enum OutcomeKind {
    NONE,
    ACK_RESTING,
    SUBMISSION_UNKNOWN,
    REJECTED,
    FILL,
    CANCEL_CONFIRMED,
    CANCEL_REJECTED
}

struct Outcome {
    uint128 cloid;
    OutcomeKind kind;
    uint64 oid;
    uint64 fillId; // HyperCore trade id, unique per fill
    uint64 szLots;
    uint64 pxE8;
    uint128 feeE8; // exchange fee amount, in base for buys and quote for sells on spot
    uint64 timeMs;
}

struct Order {
    uint256 mandateId;
    uint32 version;
    bool isBuy;
    OrderState state;
    uint64 pxE8;
    uint64 szLots;
    uint64 filledLots;
    uint64 oid;
    uint64 emittedAt;
    uint64 cancelRequestedAt;
    uint8 level;
}
