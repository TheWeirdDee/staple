"""Independent public-book sampler.

Separate process and implementation from the keeper and the watcher. It subscribes to the public HyperCore
websocket feed for one market and writes one row per wall-clock second with the top of book, plus every public
trade. It has no knowledge of Staple orders or keys; campaign metrics are computed from these files only.

Usage: python sampler.py --coin PURR/USDC --out runs/<campaign>/sampler [--network testnet]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

import websockets

WS = {"testnet": "wss://api.hyperliquid-testnet.xyz/ws", "mainnet": "wss://api.hyperliquid.xyz/ws"}
DEPTH = 10


class Sampler:
    def __init__(self, coin: str, out: Path, network: str):
        self.coin = coin
        self.out = out
        self.network = network
        out.mkdir(parents=True, exist_ok=True)
        self.book = None  # latest l2Book message data
        self.book_recv_ms = 0
        self.alive_ms = 0  # last message of any kind (incl. pong)
        self.connected = False

    def _file(self, kind: str, t: float) -> Path:
        return self.out / f"{kind}-{time.strftime('%Y%m%d%H', time.gmtime(t))}.jsonl"

    def _write(self, kind: str, row: dict):
        with self._file(kind, time.time()).open("a") as f:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")

    async def consume(self):
        backoff = 1
        while True:
            try:
                async with websockets.connect(WS[self.network], ping_interval=None, max_size=2**22) as ws:
                    self.connected = True
                    self._write("events", {"t": int(time.time() * 1000), "event": "connected"})
                    for sub in ({"type": "l2Book", "coin": self.coin}, {"type": "trades", "coin": self.coin}):
                        await ws.send(json.dumps({"method": "subscribe", "subscription": sub}))
                    backoff = 1
                    pinger = asyncio.create_task(self._ping(ws))
                    try:
                        async for raw in ws:
                            now = int(time.time() * 1000)
                            self.alive_ms = now
                            msg = json.loads(raw)
                            ch = msg.get("channel")
                            if ch == "l2Book":
                                self.book = msg["data"]
                                self.book_recv_ms = now
                            elif ch == "trades":
                                for tr in msg["data"]:
                                    self._write("trades", {"recvMs": now, **tr})
                    finally:
                        pinger.cancel()
            except Exception as ex:  # noqa: BLE001 - every disconnect is recorded as a gap
                self._write("events", {"t": int(time.time() * 1000), "event": "disconnected", "error": str(ex)[:200]})
            self.connected = False
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def _ping(self, ws):
        while True:
            await asyncio.sleep(20)
            await ws.send(json.dumps({"method": "ping"}))

    async def sample(self):
        """One row per second. A row is valid only while the feed is demonstrably alive."""
        nxt = int(time.time()) + 1
        while True:
            await asyncio.sleep(max(0, nxt - time.time()))
            now_ms = int(time.time() * 1000)
            alive = self.connected and now_ms - self.alive_ms < 45_000
            row = {"s": nxt, "sampleMs": now_ms, "valid": bool(alive and self.book)}
            if self.book:
                bids, asks = self.book["levels"]
                row.update(bookTime=self.book["time"], bookRecvMs=self.book_recv_ms,
                           bids=[[l["px"], l["sz"], l["n"]] for l in bids[:DEPTH]],
                           asks=[[l["px"], l["sz"], l["n"]] for l in asks[:DEPTH]])
            self._write("book", row)
            nxt += 1


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--coin", default="PURR/USDC")
    ap.add_argument("--out", required=True)
    ap.add_argument("--network", default="testnet")
    a = ap.parse_args()
    s = Sampler(a.coin, Path(a.out), a.network)
    s._write("events", {"t": int(time.time() * 1000), "event": "start", "coin": a.coin, "network": a.network,
                        "depth": DEPTH, "version": 1})
    await asyncio.gather(s.consume(), s.sample())


if __name__ == "__main__":
    asyncio.run(main())
