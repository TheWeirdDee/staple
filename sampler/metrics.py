"""Computes the frozen campaign metrics (docs/metrics.md v1) from independent sampler files.

Arm classification comes from public desk StateChanged events (exported to JSON by the campaign tooling or read
from the chain); no keeper data is used for the primary metric.

Usage:
  python metrics.py --sampler runs/<c>/sampler --states runs/<c>/states.json --out runs/<c>/results.json
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
from decimal import Decimal
from pathlib import Path

TARGET_BPS = Decimal(40)
BAND_BPS = Decimal(40)
SIZE = Decimal(3)


def second_metrics(row: dict) -> dict | None:
    if not row.get("valid") or not row.get("bids") or not row.get("asks"):
        return None
    bids = [(Decimal(p), Decimal(s)) for p, s, _ in row["bids"]]
    asks = [(Decimal(p), Decimal(s)) for p, s, _ in row["asks"]]
    bb, ba = bids[0][0], asks[0][0]
    if ba <= bb:
        return None
    mid = (bb + ba) / 2
    spread = (ba - bb) / mid * 10_000
    lo = mid * (1 - BAND_BPS / 10_000)
    hi = mid * (1 + BAND_BPS / 10_000)
    bd = sum(s for p, s in bids if p >= lo)
    ad = sum(s for p, s in asks if p <= hi)
    return {"spreadBps": float(spread), "bidDepth": float(bd), "askDepth": float(ad), "mid": float(mid),
            "atTarget": spread <= TARGET_BPS and bd >= SIZE and ad >= SIZE}


def load_rows(sampler_dir: str):
    files = sorted(glob.glob(str(Path(sampler_dir) / "book-*.jsonl")))
    hashes = {}
    rows = []
    for f in files:
        data = Path(f).read_bytes()
        hashes[Path(f).name] = hashlib.sha256(data).hexdigest()
        for line in data.decode().splitlines():
            if line.strip():
                rows.append(json.loads(line))
    return rows, hashes


def classify(states: list[dict], s: int) -> str:
    """states: [{"t": unix_seconds, "to": "ACTIVE"|...}] sorted; returns the state at second s."""
    cur = "UNKNOWN"
    for e in states:
        if e["t"] <= s:
            cur = e["to"]
        else:
            break
    return cur


def pct(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    k = min(len(xs) - 1, max(0, int(round(q * (len(xs) - 1)))))
    return xs[k]


def compute(sampler_dir: str, states: list[dict], start: int | None = None, end: int | None = None) -> dict:
    rows, hashes = load_rows(sampler_dir)
    arms = {"on": {"valid": 0, "atTarget": 0, "spreads": []}, "off": {"valid": 0, "atTarget": 0, "spreads": []}}
    other = {}
    invalid = 0
    seen = set()
    first = last = None
    for r in rows:
        s = r["s"]
        if (start and s < start) or (end and s > end) or s in seen:
            continue
        seen.add(s)
        first = s if first is None else min(first, s)
        last = s if last is None else max(last, s)
        st = classify(states, s) if states else "UNKNOWN"
        arm = "on" if st == "ACTIVE" else "off" if st in ("PAUSED", "DRAFT") else None
        m = second_metrics(r)
        if m is None:
            invalid += 1
            continue
        if arm is None:
            other[st] = other.get(st, 0) + 1
            continue
        a = arms[arm]
        a["valid"] += 1
        a["atTarget"] += 1 if m["atTarget"] else 0
        a["spreads"].append(m["spreadBps"])
    expected = (last - first + 1) if first is not None else 0
    out = {
        "definition": "docs/metrics.md v1",
        "window": {"start": first, "end": last, "secondsSpanned": expected, "secondsSampled": len(seen),
                   "missingSeconds": expected - len(seen), "invalidSeconds": invalid, "transitionalSeconds": other},
        "arms": {},
        "rawFiles": hashes,
    }
    for k, a in arms.items():
        out["arms"][k] = {
            "validSeconds": a["valid"],
            "atTargetSeconds": a["atTarget"],
            "timeAtTarget": (a["atTarget"] / a["valid"]) if a["valid"] else None,
            "spreadBpsP50": pct(a["spreads"], 0.5),
            "spreadBpsP95": pct(a["spreads"], 0.95),
        }
    on, off = out["arms"]["on"]["timeAtTarget"], out["arms"]["off"]["timeAtTarget"]
    out["improvementPctPoints"] = (on - off) * 100 if on is not None and off is not None else None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sampler", required=True)
    ap.add_argument("--states", help="JSON list of {t, to} mandate state changes")
    ap.add_argument("--start", type=int)
    ap.add_argument("--end", type=int)
    ap.add_argument("--out")
    a = ap.parse_args()
    states = json.loads(Path(a.states).read_text()) if a.states else []
    res = compute(a.sampler, states, a.start, a.end)
    txt = json.dumps(res, indent=2)
    if a.out:
        Path(a.out).write_text(txt + "\n")
    print(txt)


if __name__ == "__main__":
    main()
