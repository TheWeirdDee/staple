"""Minimal JSON-RPC + contract access for the watcher (independent of the TypeScript keeper)."""
from __future__ import annotations

import json
import time
import urllib.request
from typing import Any

from eth_abi import decode, encode
from eth_account import Account
from eth_utils import keccak, to_checksum_address

UA = {"content-type": "application/json", "user-agent": "staple-watcher/0.1"}


def selector(sig: str) -> bytes:
    return keccak(text=sig)[:4]


def topic(sig: str) -> str:
    return "0x" + keccak(text=sig).hex()


class Rpc:
    def __init__(self, url: str, timeout: float = 15.0):
        self.url = url
        self.timeout = timeout
        self._id = 0

    def call(self, method: str, params: list[Any]) -> Any:
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params}).encode()
        req = urllib.request.Request(self.url, body, UA)
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            resp = json.loads(r.read())
        if "error" in resp:
            raise RuntimeError(f"{method}: {resp['error']}")
        return resp["result"]


class Desk:
    """Read and write access to StapleDesk using hand-encoded ABI calls."""

    RUNTIME_TYPES = [
        "uint8", "uint8", "bool", "uint32", "uint64", "uint64", "uint64", "uint64", "uint64",
        "uint64", "uint64", "uint64", "uint64", "uint64",
    ]
    RUNTIME_FIELDS = [
        "state", "halt", "agentRevokedObserved", "activeVersion", "activatedAt", "lastSeq", "lastSourceTimeMs",
        "lastObsAt", "lastOutcomeSeq", "lastWatcherBeat", "unreconciledSince", "calmUntil", "volWindowStart",
        "volWindowMidE8",
    ]
    ORDER_TYPES = ["uint256", "uint32", "bool", "uint8", "uint64", "uint64", "uint64", "uint64", "uint64", "uint64", "uint8"]
    ORDER_FIELDS = ["mandateId", "version", "isBuy", "state", "pxE8", "szLots", "filledLots", "oid", "emittedAt",
                    "cancelRequestedAt", "level"]
    PLACE_TOPIC = topic("PlaceIntent(uint256,uint128,uint16,uint32,uint32,bool,uint64,uint64,uint8)")
    STATE_TOPIC = topic("StateChanged(uint256,uint8,uint8,uint8)")

    def __init__(self, rpc: Rpc, address: str, key: str | None = None, chain_id: int = 99801):
        self.rpc = rpc
        self.address = to_checksum_address(address)
        self.account = Account.from_key(key) if key else None
        self.chain_id = chain_id

    def _eth_call(self, data: bytes) -> bytes:
        out = self.rpc.call("eth_call", [{"to": self.address, "data": "0x" + data.hex()}, "latest"])
        return bytes.fromhex(out[2:])

    def runtime(self, mid: int) -> dict:
        raw = self._eth_call(selector("runtime(uint256)") + encode(["uint256"], [mid]))
        vals = decode(self.RUNTIME_TYPES, raw)
        return dict(zip(self.RUNTIME_FIELDS, vals))

    def live_cloids(self, mid: int) -> list[int]:
        raw = self._eth_call(selector("liveCloids(uint256)") + encode(["uint256"], [mid]))
        return list(decode(["uint128[]"], raw)[0])

    def order(self, cloid: int) -> dict:
        raw = self._eth_call(selector("getOrder(uint128)") + encode(["uint128"], [cloid]))
        return dict(zip(self.ORDER_FIELDS, decode(self.ORDER_TYPES, raw)))

    def block_number(self) -> int:
        return int(self.rpc.call("eth_blockNumber", []), 16)

    def place_intents(self, mid: int, from_block: int, to_block: int) -> list[dict]:
        """All PlaceIntent events for the mandate in [from_block, to_block], fetched in bounded chunks."""
        out: list[dict] = []
        start = from_block
        mtopic = "0x" + mid.to_bytes(32, "big").hex()
        while start <= to_block:
            end = min(start + 5000, to_block)
            logs = self.rpc.call("eth_getLogs", [{
                "address": self.address, "fromBlock": hex(start), "toBlock": hex(end),
                "topics": [self.PLACE_TOPIC, mtopic],
            }])
            for lg in logs:
                cloid = int(lg["topics"][2], 16)
                iv, pv, asset, is_buy, px, sz, level = decode(
                    ["uint16", "uint32", "uint32", "bool", "uint64", "uint64", "uint8"], bytes.fromhex(lg["data"][2:]))
                out.append({"cloid": cloid, "policyVersion": pv, "asset": asset, "isBuy": is_buy, "pxE8": px,
                            "szLots": sz, "level": level, "block": int(lg["blockNumber"], 16), "tx": lg["transactionHash"]})
            start = end + 1
        return out

    # ------------------------------------------------------------- writes

    def _send(self, data: bytes, gas: int = 400_000) -> str:
        assert self.account is not None, "watcher key required for writes"
        nonce = int(self.rpc.call("eth_getTransactionCount", [self.account.address, "pending"]), 16)
        base = int(self.rpc.call("eth_gasPrice", []), 16)
        tx = {
            "chainId": self.chain_id, "nonce": nonce, "to": self.address, "data": data, "value": 0,
            "gas": gas, "maxFeePerGas": base * 2, "maxPriorityFeePerGas": 0, "type": 2,
        }
        signed = self.account.sign_transaction(tx)
        h = self.rpc.call("eth_sendRawTransaction", ["0x" + signed.raw_transaction.hex()])
        for _ in range(60):
            rc = self.rpc.call("eth_getTransactionReceipt", [h])
            if rc:
                if int(rc["status"], 16) != 1:
                    raise RuntimeError(f"tx reverted {h}")
                return h
            time.sleep(0.5)
        raise RuntimeError(f"tx not mined {h}")

    def heartbeat(self, mid: int) -> str:
        return self._send(selector("heartbeat(uint256)") + encode(["uint256"], [mid]), 120_000)

    def poke(self, mid: int) -> str:
        return self._send(selector("poke(uint256)") + encode(["uint256"], [mid]), 2_500_000)

    def report_mismatch(self, mid: int, evidence: bytes, detail: str) -> str:
        data = selector("reportMismatch(uint256,bytes32,string)") + encode(["uint256", "bytes32", "string"], [mid, evidence, detail])
        return self._send(data, 2_500_000)

    def report_agent_revoked(self, mid: int) -> str:
        return self._send(selector("reportAgentRevoked(uint256)") + encode(["uint256"], [mid]), 300_000)
