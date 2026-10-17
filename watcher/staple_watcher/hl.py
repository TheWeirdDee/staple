"""HyperCore info reads and the watcher's emergency cancellation (independent implementation)."""
from __future__ import annotations

import json
import time
import urllib.request
from decimal import Decimal

import msgpack
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak

API = {"testnet": "https://api.hyperliquid-testnet.xyz", "mainnet": "https://api.hyperliquid.xyz"}
UA = {"content-type": "application/json", "user-agent": "staple-watcher/0.1"}


def e8(v: str) -> int:
    return int((Decimal(v) * 100_000_000).to_integral_value())


class HL:
    def __init__(self, network: str = "testnet", guard_key: str | None = None, timeout: float = 10.0):
        self.base = API[network]
        self.network = network
        self.guard = Account.from_key(guard_key) if guard_key else None
        self.timeout = timeout
        self._last_nonce = 0

    def _post(self, path: str, body: dict):
        req = urllib.request.Request(self.base + path, json.dumps(body).encode(), UA)
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.loads(r.read())

    def info(self, body: dict):
        return self._post("/info", body)

    def open_orders(self, user: str):
        return self.info({"type": "openOrders", "user": user})

    def fills_since(self, user: str, start_ms: int):
        return self.info({"type": "userFillsByTime", "user": user, "startTime": start_ms, "aggregateByTime": False})

    def extra_agents(self, user: str):
        return self.info({"type": "extraAgents", "user": user})

    def order_status(self, user: str, oid_or_cloid):
        return self.info({"type": "orderStatus", "user": user, "oid": oid_or_cloid})

    # -------------------------------------------- emergency cancellation

    def _nonce(self) -> int:
        self._last_nonce = max(int(time.time() * 1000), self._last_nonce + 1)
        return self._last_nonce

    def _sign_l1(self, action: dict, nonce: int) -> dict:
        data = msgpack.packb(action) + nonce.to_bytes(8, "big") + b"\x00"
        connection_id = keccak(data)
        typed = {
            "domain": {"name": "Exchange", "version": "1", "chainId": 1337,
                       "verifyingContract": "0x0000000000000000000000000000000000000000"},
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"},
                ],
                "Agent": [{"name": "source", "type": "string"}, {"name": "connectionId", "type": "bytes32"}],
            },
            "primaryType": "Agent",
            "message": {"source": "a" if self.network == "mainnet" else "b", "connectionId": connection_id},
        }
        signed = self.guard.sign_message(encode_typed_data(full_message=typed))
        return {"r": hex(signed.r), "s": hex(signed.s), "v": signed.v}

    def cancel_oids(self, asset: int, oids: list[int]) -> dict:
        """Cancels by exchange order id with the separately approved guard agent."""
        assert self.guard is not None, "guard agent key not configured"
        action = {"type": "cancel", "cancels": [{"a": asset, "o": o} for o in oids]}
        nonce = self._nonce()
        return self._post("/exchange", {"action": action, "nonce": nonce, "signature": self._sign_l1(action, nonce)})
