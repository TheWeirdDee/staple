"""Independent watcher: compares exchange activity with contract intents, keeps the on-chain timers running,
reports mismatches and attempts emergency cancellation through a separately approved guard agent.

It detects deviations after they happen. It cannot undo trades, and it cannot revoke the keeper's agent:
only the owner's key can do that on HyperCore.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from .checks import EXPOSED, MANDATE_STATES, reconcile
from .hl import HL
from .rpc import Desk, Rpc


def load_keys() -> dict:
    """Same envelope as keeper/src/keystore.ts (scrypt + AES-256-GCM). Env keys are for local development only."""
    path = os.environ.get("STAPLE_KEYSTORE")
    if path and Path(path).exists():
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        env = json.loads(Path(path).read_text())
        key = hashlib.scrypt(os.environ["STAPLE_KEYSTORE_PASSPHRASE"].encode(), salt=base64.b64decode(env["salt"]),
                             n=env["N"], r=env["r"], p=env["p"], dklen=32, maxmem=64 * 1024 * 1024)
        pt = AESGCM(key).decrypt(base64.b64decode(env["iv"]), base64.b64decode(env["ct"]) + base64.b64decode(env["tag"]), None)
        return json.loads(pt)
    return {"watcher": os.environ.get("STAPLE_WATCHER_KEY"), "guard": os.environ.get("STAPLE_GUARD_KEY")}


class Watcher:
    def __init__(self):
        e = os.environ
        keys = load_keys()
        self.mid = int(e["STAPLE_MANDATE_ID"])
        self.owner = e["STAPLE_OWNER_ACCOUNT"]
        self.coin = e.get("STAPLE_COIN", "PURR/USDC")
        self.asset = int(e.get("STAPLE_ASSET", "10000"))
        self.szd = int(e.get("STAPLE_SZ_DECIMALS", "0"))
        self.keeper_agent = e["STAPLE_KEEPER_AGENT"].lower()
        self.interval = float(e.get("STAPLE_WATCH_INTERVAL", "10"))
        self.keeper_timeout = int(e.get("STAPLE_KEEPER_TIMEOUT_SEC", "60"))
        dep = json.loads(Path(e["STAPLE_DEPLOYMENT"]).read_text())
        self.deploy_block = int(dep["deployBlock"])
        self.desk = Desk(Rpc(e.get("STAPLE_ELYSIUM_RPC", "https://testnet-rpc.elysium.kinetiq.xyz")), dep["desk"], keys.get("watcher"))
        self.hl = HL(e.get("STAPLE_NETWORK", "testnet"), keys.get("guard"))
        self.dir = Path(e.get("STAPLE_STATE_DIR", "state"))
        self.dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.dir / f"watcher-state-{self.mid}.json"
        self.log_path = self.dir / f"watcher-log-{self.mid}.jsonl"
        st = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.cursor = st.get("cursor", self.deploy_block - 1)
        self.intents = {int(k): v for k, v in st.get("intents", {}).items()}
        self.reported = set(st.get("reported", []))
        self.health = {"service": "watcher", "mandateId": self.mid, "startedAt": time.time(), "lastOkAt": 0,
                       "lastError": "", "consecutiveErrors": 0}

    def save(self):
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"cursor": self.cursor, "intents": {str(k): v for k, v in self.intents.items()},
                                   "reported": sorted(self.reported)}))
        tmp.replace(self.state_path)

    def log(self, kind: str, **data):
        with self.log_path.open("a") as f:
            f.write(json.dumps({"t": int(time.time() * 1000), "kind": kind, **data}, default=str) + "\n")

    def step(self):
        # Timer first: expiry, staleness and missing outcomes are enforced even if nothing else works.
        try:
            self.desk.poke(self.mid)
        except Exception as ex:  # noqa: BLE001 - recorded, loop continues
            self.log("poke_error", error=str(ex)[:300])

        rt = self.desk.runtime(self.mid)
        state = MANDATE_STATES[rt["state"]]
        head = self.desk.block_number()
        for it in self.desk.place_intents(self.mid, self.cursor + 1, head):
            self.intents[it["cloid"]] = it
        self.cursor = head
        chain_orders = {c: self.desk.order(c) for c in self.desk.live_cloids(self.mid)}
        since = max(0, int(rt["activatedAt"]) * 1000 - 60_000)
        open_orders = self.hl.open_orders(self.owner)
        fills = self.hl.fills_since(self.owner, since)
        rep = reconcile(self.intents, chain_orders, open_orders, fills, self.coin, self.szd)
        now = time.time()

        new_findings = [f for f in rep.findings if f.evidence_hash().hex() not in self.reported]
        if new_findings and state in EXPOSED:
            f = new_findings[0]
            tx = self.desk.report_mismatch(self.mid, f.evidence_hash(), f"{f.kind}:{json.dumps(f.detail)[:180]}")
            self.log("mismatch_reported", tx=tx, findings=[{"kind": x.kind, **x.detail} for x in new_findings])
            for x in new_findings:
                self.reported.add(x.evidence_hash().hex())
            # Try to remove unexplained orders. This uses the guard agent and cannot undo fills.
            unknown = [int(x.detail["oid"]) for x in new_findings if "oid" in x.detail and x.kind != "unknown_fill"]
            if unknown and self.hl.guard:
                self.log("emergency_cancel", reason="mismatch", oids=unknown, result=self.hl.cancel_oids(self.asset, unknown))
        elif new_findings:
            self.log("activity_while_quiescent", state=state, findings=[{"kind": x.kind, **x.detail} for x in new_findings])
            for x in new_findings:
                self.reported.add(x.evidence_hash().hex())

        keeper_age = now - int(rt["lastObsAt"]) if rt["lastObsAt"] else None
        if state in EXPOSED and rep.staple_open_oids and keeper_age is not None and keeper_age > self.keeper_timeout:
            res = self.hl.cancel_oids(self.asset, rep.staple_open_oids) if self.hl.guard else "no guard agent configured"
            self.log("emergency_cancel", reason="keeper_outage", keeperAgeSec=keeper_age, oids=rep.staple_open_oids, result=res)

        if state == "REVOKING" and not rt["agentRevokedObserved"]:
            agents = [a["address"].lower() for a in self.hl.extra_agents(self.owner)]
            if self.keeper_agent not in agents:
                tx = self.desk.report_agent_revoked(self.mid)
                self.log("agent_revocation_observed", tx=tx, agents=agents)

        # Heartbeat only after a complete check: if the watcher cannot see, quoting fails closed.
        hb = self.desk.heartbeat(self.mid)
        self.log("check", state=state, exchangeOrders=rep.exchange_orders, matchedOrders=rep.exchange_orders_matched,
                 fills=rep.fills, matchedFills=rep.fills_matched, findings=len(rep.findings), keeperAgeSec=keeper_age,
                 intentsKnown=len(self.intents), heartbeatTx=hb)
        self.health.update(lastOkAt=now, consecutiveErrors=0, state=state, coverage={
            "exchangeOrders": rep.exchange_orders, "matchedOrders": rep.exchange_orders_matched,
            "fills": rep.fills, "matchedFills": rep.fills_matched, "findingsTotal": len(self.reported)})
        self.save()

    def run(self):
        while True:
            t0 = time.time()
            try:
                self.step()
            except Exception as ex:  # noqa: BLE001
                self.health["consecutiveErrors"] += 1
                self.health["lastError"] = str(ex)[:300]
                self.log("step_error", error=str(ex)[:300])
            time.sleep(max(0.0, self.interval - (time.time() - t0)))


def serve_health(w: Watcher, port: int):
    class H(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            ok = time.time() - w.health["lastOkAt"] < max(60, w.interval * 6)
            body = json.dumps({**w.health, "ok": ok}).encode()
            self.send_response(200 if ok else 503)
            self.send_header("content-type", "application/json")
            self.send_header("access-control-allow-origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    HTTPServer(("0.0.0.0", port), H).serve_forever()


def main():
    w = Watcher()
    threading.Thread(target=serve_health, args=(w, int(os.environ.get("STAPLE_WATCHER_HEALTH_PORT", "8788"))), daemon=True).start()
    print(f"watcher started: mandate {w.mid} account {w.owner} coin {w.coin}", flush=True)
    w.run()


if __name__ == "__main__":
    main()
