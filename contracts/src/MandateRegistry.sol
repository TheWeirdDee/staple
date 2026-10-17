// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Policy, MarketParams, QuoteParams, ExposureParams, RiskParams, MAX_LEVELS} from "./StapleTypes.sol";
import {IERC20Minimal} from "./IERC20Minimal.sol";

interface IDeskView {
    function activeVersion(uint256 id) external view returns (uint32);
    function isQuiescent(uint256 id) external view returns (bool);
}

/// Ownership, roles, versioned public policies and prepaid service-fee balances.
/// No admin key and no upgrade path. The deployer can bind the desk exactly once; afterwards nobody but a
/// mandate's owner can change its terms, and risk-increasing edits only take effect after a public notice.
contract MandateRegistry {
    uint64 public constant MIN_NOTICE_SEC = 60;

    struct Identity {
        address owner;
        address operator; // keeper reporter: signs observations and outcomes
        address guardian; // independent watcher: heartbeats, mismatch and revocation reports
        address hlAccount; // owner's HyperCore account (holds trading capital)
        uint64 createdAt;
        uint32 latestVersion;
        uint32 pendingVersion;
        uint64 pendingEffectiveAt;
    }

    struct FeeAccount {
        uint256 balance;
        uint256 spent;
        uint256 owed; // accrued but unpaid because the balance ran out
    }

    IERC20Minimal public immutable feeToken;
    uint8 public immutable feeTokenDecimals;
    address public immutable feeRecipient;
    address public immutable deployer;
    address public desk;

    uint256 public mandateCount;
    uint256 public feesClaimable;

    mapping(uint256 => Identity) internal _ids;
    mapping(uint256 => mapping(uint32 => Policy)) internal _policies;
    mapping(uint256 => mapping(uint32 => uint64)) public versionCreatedAt;
    mapping(uint256 => mapping(uint32 => uint64)) public versionEffectiveAt;
    mapping(uint256 => FeeAccount) internal _fees;

    event DeskBound(address desk);
    event MandateCreated(
        uint256 indexed mandateId, address indexed owner, address hlAccount, address operator, address guardian
    );
    event PolicyProposed(uint256 indexed mandateId, uint32 version, uint64 effectiveAt, bool riskIncreasing);
    event RolesChanged(uint256 indexed mandateId, address operator, address guardian);
    event FeesDeposited(uint256 indexed mandateId, address from, uint256 amount);
    event FeesWithdrawn(uint256 indexed mandateId, uint256 amount);
    event FeeCharged(uint256 indexed mandateId, uint256 charged, uint256 owed);

    error NotOwner();
    error NotDesk();
    error InvalidPolicy(string field);
    error NotQuiescent();
    error TransferFailed();
    error AlreadyBound();

    constructor(IERC20Minimal feeToken_, uint8 feeTokenDecimals_, address feeRecipient_) {
        feeToken = feeToken_;
        feeTokenDecimals = feeTokenDecimals_;
        feeRecipient = feeRecipient_;
        deployer = msg.sender;
    }

    function bindDesk(address desk_) external {
        if (msg.sender != deployer || desk != address(0)) revert AlreadyBound();
        desk = desk_;
        emit DeskBound(desk_);
    }

    modifier onlyOwner(uint256 id) {
        if (_ids[id].owner != msg.sender) revert NotOwner();
        _;
    }

    modifier onlyDesk() {
        if (msg.sender != desk) revert NotDesk();
        _;
    }

    // ---------------------------------------------------------------- policy

    function validatePolicy(Policy memory p) public view {
        MarketParams memory m = p.market;
        QuoteParams memory q = p.quotes;
        ExposureParams memory e = p.exposure;
        RiskParams memory r = p.risk;
        if (!m.isSpot) revert InvalidPolicy("market.isSpot"); // first release: spot only
        if (m.asset < 10000) revert InvalidPolicy("market.asset");
        if (m.szDecimals > 8) revert InvalidPolicy("market.szDecimals");
        if (q.levels == 0 || q.levels > MAX_LEVELS) revert InvalidPolicy("quotes.levels");
        if (q.spreadBps == 0 || q.spreadBps > 5000) revert InvalidPolicy("quotes.spreadBps");
        if (q.levels > 1 && q.levelSpacingBps == 0) revert InvalidPolicy("quotes.levelSpacingBps");
        if (uint256(q.spreadBps) + 2 * uint256(q.levels - 1) * q.levelSpacingBps >= 20_000) {
            revert InvalidPolicy("quotes.ladderWidth");
        }
        if (q.sizeLots == 0) revert InvalidPolicy("quotes.sizeLots");
        if (q.skewBps > 1000) revert InvalidPolicy("quotes.skewBps");
        if (q.requoteBps >= q.spreadBps) revert InvalidPolicy("quotes.requoteBps");
        if (!(e.minBaseE8 <= e.baselineBaseE8 && e.baselineBaseE8 <= e.maxBaseE8)) {
            revert InvalidPolicy("exposure.inventoryBounds");
        }
        if (e.maxOutstandingNotionalE8 == 0) revert InvalidPolicy("exposure.maxOutstandingNotionalE8");
        if (e.feeAllowanceBps > 100) revert InvalidPolicy("exposure.feeAllowanceBps");
        if (r.lossTriggerQuoteE8 == 0) revert InvalidPolicy("risk.lossTriggerQuoteE8");
        if (r.volBps == 0 || r.volWindowSec == 0) revert InvalidPolicy("risk.volatility");
        if (r.maxRefAgeMs < 1000 || r.maxRefAgeMs > 600_000) revert InvalidPolicy("risk.maxRefAgeMs");
        if (r.maxDeviationBps == 0) revert InvalidPolicy("risk.maxDeviationBps");
        if (r.reconTimeoutSec == 0 || r.cancelTimeoutSec == 0 || r.watcherTimeoutSec == 0) {
            revert InvalidPolicy("risk.timeouts");
        }
        if (p.fees.feeBps > 100) revert InvalidPolicy("fees.feeBps");
        if (p.expiry <= block.timestamp) revert InvalidPolicy("expiry");
    }

    /// True when `b` could expose the owner to more risk than `a`.
    function isRiskIncreasing(Policy memory a, Policy memory b) public pure returns (bool) {
        QuoteParams memory qa = a.quotes;
        QuoteParams memory qb = b.quotes;
        ExposureParams memory ea = a.exposure;
        ExposureParams memory eb = b.exposure;
        RiskParams memory ra = a.risk;
        RiskParams memory rb = b.risk;
        return qb.levels > qa.levels || qb.sizeLots > qa.sizeLots || qb.spreadBps < qa.spreadBps
            || qb.levelSpacingBps < qa.levelSpacingBps || qb.skewBps < qa.skewBps || qb.bookRule != qa.bookRule
            || eb.maxBaseE8 > ea.maxBaseE8 || eb.minBaseE8 < ea.minBaseE8 || eb.quoteBudgetE8 > ea.quoteBudgetE8
            || eb.maxOutstandingNotionalE8 > ea.maxOutstandingNotionalE8 || eb.feeAllowanceBps < ea.feeAllowanceBps
            || eb.baselineBaseE8 != ea.baselineBaseE8 || rb.lossTriggerQuoteE8 > ra.lossTriggerQuoteE8
            || rb.volBps > ra.volBps || rb.volWindowSec != ra.volWindowSec || rb.calmSec < ra.calmSec
            || rb.maxRefAgeMs > ra.maxRefAgeMs || rb.maxDeviationBps > ra.maxDeviationBps
            || rb.reconTimeoutSec > ra.reconTimeoutSec || rb.cancelTimeoutSec > ra.cancelTimeoutSec
            || rb.watcherTimeoutSec > ra.watcherTimeoutSec || b.expiry > a.expiry || b.fees.feeBps != a.fees.feeBps
            || b.fees.spendCap > a.fees.spendCap;
    }

    function createMandate(Policy calldata p, address operator, address guardian, address hlAccount)
        external
        returns (uint256 id)
    {
        validatePolicy(p);
        if (operator == address(0) || guardian == address(0) || hlAccount == address(0)) {
            revert InvalidPolicy("roles");
        }
        id = ++mandateCount;
        Identity storage m = _ids[id];
        m.owner = msg.sender;
        m.operator = operator;
        m.guardian = guardian;
        m.hlAccount = hlAccount;
        m.createdAt = uint64(block.timestamp);
        m.latestVersion = 1;
        _policies[id][1] = p;
        versionCreatedAt[id][1] = uint64(block.timestamp);
        versionEffectiveAt[id][1] = uint64(block.timestamp);
        emit MandateCreated(id, msg.sender, hlAccount, operator, guardian);
        emit PolicyProposed(id, 1, uint64(block.timestamp), false);
    }

    /// Publish a new policy version. Risk-reducing edits are effective immediately at the policy layer;
    /// risk-increasing edits wait MIN_NOTICE_SEC. The desk only switches once every order placed under the
    /// old version is confirmed terminal. A newer proposal supersedes an unapplied pending one.
    function proposePolicy(uint256 id, Policy calldata p) external onlyOwner(id) returns (uint32 version) {
        validatePolicy(p);
        Identity storage m = _ids[id];
        uint32 active = IDeskView(desk).activeVersion(id);
        Policy storage cur = _policies[id][active == 0 ? 1 : active];
        if (
            p.market.asset != cur.market.asset || p.market.szDecimals != cur.market.szDecimals
                || p.market.isSpot != cur.market.isSpot
        ) revert InvalidPolicy("market.immutable");
        bool up = isRiskIncreasing(cur, p);
        version = ++m.latestVersion;
        _policies[id][version] = p;
        uint64 eff = uint64(block.timestamp) + (up ? MIN_NOTICE_SEC : 0);
        versionCreatedAt[id][version] = uint64(block.timestamp);
        versionEffectiveAt[id][version] = eff;
        m.pendingVersion = version;
        m.pendingEffectiveAt = eff;
        emit PolicyProposed(id, version, eff, up);
    }

    /// Desk consumes a due pending version when it switches to it.
    function consumePending(uint256 id) external onlyDesk returns (uint32 version) {
        Identity storage m = _ids[id];
        if (m.pendingVersion == 0 || block.timestamp < m.pendingEffectiveAt) return 0;
        version = m.pendingVersion;
        m.pendingVersion = 0;
        m.pendingEffectiveAt = 0;
    }

    function setRoles(uint256 id, address operator, address guardian) external onlyOwner(id) {
        if (!IDeskView(desk).isQuiescent(id)) revert NotQuiescent();
        if (operator == address(0) || guardian == address(0)) revert InvalidPolicy("roles");
        _ids[id].operator = operator;
        _ids[id].guardian = guardian;
        emit RolesChanged(id, operator, guardian);
    }

    // ------------------------------------------------------------------ fees

    function depositFees(uint256 id, uint256 amount) external {
        if (_ids[id].owner == address(0)) revert InvalidPolicy("mandate");
        if (!feeToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        FeeAccount storage f = _fees[id];
        uint256 pay = f.owed < amount ? f.owed : amount;
        f.owed -= pay;
        f.spent += pay;
        feesClaimable += pay;
        f.balance += amount - pay;
        emit FeesDeposited(id, msg.sender, amount);
    }

    /// Unspent prepaid fees are withdrawable by the owner at any time; quoting stops when the balance is empty.
    function withdrawFees(uint256 id, uint256 amount) external onlyOwner(id) {
        FeeAccount storage f = _fees[id];
        if (amount > f.balance) revert InvalidPolicy("fees.amount");
        f.balance -= amount;
        if (!feeToken.transfer(msg.sender, amount)) revert TransferFailed();
        emit FeesWithdrawn(id, amount);
    }

    function claimFees() external {
        uint256 amt = feesClaimable;
        feesClaimable = 0;
        if (!feeToken.transfer(feeRecipient, amt)) revert TransferFailed();
    }

    /// Charges the service fee on executed notional (rounded up). Idempotency is the desk's job (unique fill id).
    function chargeFee(uint256 id, uint32 version, uint256 notionalE8) external onlyDesk returns (uint256 fee) {
        FeeAccount storage f = _fees[id];
        Policy storage p = _policies[id][version];
        if (p.fees.feeBps == 0) return 0;
        uint256 e8 = (notionalE8 * p.fees.feeBps + 9_999) / 10_000;
        uint8 dec = feeTokenDecimals;
        fee = dec >= 8 ? e8 * 10 ** (dec - 8) : (e8 + 10 ** (8 - dec) - 1) / 10 ** (8 - dec);
        uint256 used = f.spent + f.owed;
        uint256 room = used >= p.fees.spendCap ? 0 : p.fees.spendCap - used;
        if (fee > room) fee = room;
        uint256 pay = fee <= f.balance ? fee : f.balance;
        f.balance -= pay;
        f.spent += pay;
        f.owed += fee - pay;
        feesClaimable += pay;
        emit FeeCharged(id, pay, fee - pay);
    }

    /// True while prepaid fees allow new placements under `version`.
    function feesOk(uint256 id, uint32 version) external view returns (bool) {
        Policy storage p = _policies[id][version];
        if (p.fees.feeBps == 0) return true;
        FeeAccount storage f = _fees[id];
        return f.balance > 0 && f.owed == 0 && f.spent < p.fees.spendCap;
    }

    // ----------------------------------------------------------------- views

    function identity(uint256 id) external view returns (Identity memory) {
        return _ids[id];
    }

    function ownerOf(uint256 id) external view returns (address) {
        return _ids[id].owner;
    }

    function roles(uint256 id) external view returns (address owner, address operator, address guardian) {
        Identity storage m = _ids[id];
        return (m.owner, m.operator, m.guardian);
    }

    function getPolicy(uint256 id, uint32 version) external view returns (Policy memory) {
        return _policies[id][version];
    }

    function getFees(uint256 id) external view returns (FeeAccount memory) {
        return _fees[id];
    }
}
