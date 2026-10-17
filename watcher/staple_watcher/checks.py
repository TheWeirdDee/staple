"""Pure reconciliation checks: exchange activity versus contract intents. No I/O, unit-tested."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from decimal import Decimal

ORDER_STATES = ["NONE", "INTENT_EMITTED", "SUBMISSION_UNKNOWN", "ACKNOWLEDGED", "RESTING", "PARTIALLY_FILLED",
                "FILLED", "CANCELLED", "REJECTED"]
MANDATE_STATES = ["DRAFT", "ACTIVE", "PAUSING", "PAUSED", "TRIPPED", "REVOKING", "REVOKED", "EXPIRING", "EXPIRED",
                  "RECONCILIATION_REQUIRED"]
# States in which Staple orders may still execute, so any unexplained activity is a mismatch.
EXPOSED = {"ACTIVE", "PAUSING", "TRIPPED", "REVOKING", "EXPIRING", "RECONCILIATION_REQUIRED"}


def scaled(v: str, decimals: int) -> int:
    return int((Decimal(v) * (10 ** decimals)).to_integral_value())


@dataclass
class Finding:
    kind: str  # unknown_order | unknown_fill | order_mismatch | overfill | terminal_but_open
    detail: dict

    def evidence_hash(self) -> bytes:
        return hashlib.sha3_256(json.dumps({"kind": self.kind, **self.detail}, sort_keys=True).encode()).digest()


@dataclass
class Report:
    findings: list[Finding] = field(default_factory=list)
    exchange_orders: int = 0
    exchange_orders_matched: int = 0
    fills: int = 0
    fills_matched: int = 0
    staple_open_oids: list[int] = field(default_factory=list)


def reconcile(intents: dict[int, dict], chain_orders: dict[int, dict], open_orders: list[dict], fills: list[dict],
              coin: str, sz_decimals: int) -> Report:
    """Every exchange order and fill on the dedicated account must be explained by a contract intent.

    The denominator is all relevant exchange activity, including activity that matches nothing.
    """
    rep = Report()
    for o in open_orders:
        if o.get("coin") != coin:
            continue
        rep.exchange_orders += 1
        cloid = int(o["cloid"], 16) if o.get("cloid") else None
        it = intents.get(cloid) if cloid is not None else None
        if it is None:
            rep.findings.append(Finding("unknown_order", {"oid": o["oid"], "cloid": o.get("cloid"), "px": o["limitPx"],
                                                          "sz": o["sz"], "side": o["side"]}))
            continue
        px = scaled(o["limitPx"], 8)
        is_buy = o["side"] == "B"
        orig = scaled(o.get("origSz", o["sz"]), sz_decimals)
        if px != it["pxE8"] or is_buy != it["isBuy"] or orig > it["szLots"]:
            rep.findings.append(Finding("order_mismatch", {"oid": o["oid"], "cloid": o["cloid"], "px": o["limitPx"],
                                                           "intentPxE8": it["pxE8"], "side": o["side"],
                                                           "intentIsBuy": it["isBuy"], "origSz": o.get("origSz")}))
            continue
        co = chain_orders.get(cloid)
        if co is not None and ORDER_STATES[co["state"]] in ("CANCELLED", "REJECTED", "FILLED"):
            rep.findings.append(Finding("terminal_but_open", {"oid": o["oid"], "cloid": o["cloid"],
                                                              "chainState": ORDER_STATES[co["state"]]}))
            continue
        rep.exchange_orders_matched += 1
        rep.staple_open_oids.append(int(o["oid"]))

    filled: dict[int, int] = {}
    for f in fills:
        if f.get("coin") != coin:
            continue
        rep.fills += 1
        cloid = int(f["cloid"], 16) if f.get("cloid") else None
        it = intents.get(cloid) if cloid is not None else None
        if it is None:
            rep.findings.append(Finding("unknown_fill", {"tid": f["tid"], "oid": f["oid"], "px": f["px"], "sz": f["sz"],
                                                         "side": f["side"]}))
            continue
        filled[cloid] = filled.get(cloid, 0) + scaled(f["sz"], sz_decimals)
        if filled[cloid] > it["szLots"]:
            rep.findings.append(Finding("overfill", {"cloid": f["cloid"], "filledLots": filled[cloid],
                                                     "intentLots": it["szLots"]}))
            continue
        rep.fills_matched += 1
    return rep
