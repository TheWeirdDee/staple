import base64
import hashlib
import json
from pathlib import Path

from staple_watcher.checks import reconcile
from staple_watcher.hl import HL

HERE = Path(__file__).parent


def test_guard_cancel_signature_matches_official_sdk():
    g = json.loads((HERE / "sdk_cancel_golden.json").read_text())
    hl = HL("testnet", "0x" + "22" * 32)
    assert hl.guard.address == g["address"]
    sig = hl._sign_l1(g["action"], g["nonce"])
    assert int(sig["r"], 16) == int(g["sig"]["r"], 16)
    assert int(sig["s"], 16) == int(g["sig"]["s"], 16)
    assert sig["v"] == g["sig"]["v"]


def intent(cloid, px, sz, buy=True):
    return {"cloid": cloid, "pxE8": px, "szLots": sz, "isBuy": buy}


def oo(oid, cloid, px, sz, side="B", orig=None):
    return {"coin": "PURR/USDC", "oid": oid, "cloid": None if cloid is None else f"0x{cloid:032x}", "limitPx": px,
            "sz": sz, "origSz": orig or sz, "side": side}


def fill(tid, oid, cloid, px, sz, side="B"):
    return {"coin": "PURR/USDC", "tid": tid, "oid": oid, "cloid": None if cloid is None else f"0x{cloid:032x}",
            "px": px, "sz": sz, "side": side}


def test_matched_activity_has_full_coverage():
    intents = {1: intent(1, 454770000, 3), 2: intent(2, 456600000, 3, False)}
    rep = reconcile(intents, {1: {"state": 4}, 2: {"state": 4}},
                    [oo(10, 1, "4.5477", "3"), oo(11, 2, "4.566", "3", "A")],
                    [fill(5, 10, 1, "4.5477", "1")], "PURR/USDC", 0)
    assert rep.findings == []
    assert (rep.exchange_orders, rep.exchange_orders_matched, rep.fills, rep.fills_matched) == (2, 2, 1, 1)


def test_order_without_intent_is_a_finding_and_counts_in_denominator():
    rep = reconcile({}, {}, [oo(99, None, "4.4", "50")], [], "PURR/USDC", 0)
    assert [f.kind for f in rep.findings] == ["unknown_order"]
    assert rep.exchange_orders == 1 and rep.exchange_orders_matched == 0


def test_price_side_or_size_deviation_is_a_mismatch():
    intents = {1: intent(1, 454770000, 3)}
    for o in (oo(10, 1, "4.6", "3"), oo(10, 1, "4.5477", "3", "A"), oo(10, 1, "4.5477", "3", orig="9")):
        rep = reconcile(intents, {1: {"state": 4}}, [o], [], "PURR/USDC", 0)
        assert [f.kind for f in rep.findings] == ["order_mismatch"]


def test_overfill_and_unknown_fill():
    intents = {1: intent(1, 454770000, 3)}
    fills = [fill(1, 10, 1, "4.5477", "2"), fill(2, 10, 1, "4.5477", "2"), fill(3, 77, None, "4.5", "5")]
    rep = reconcile(intents, {}, [], fills, "PURR/USDC", 0)
    assert sorted(f.kind for f in rep.findings) == ["overfill", "unknown_fill"]


def test_open_order_for_terminal_intent_is_flagged():
    rep = reconcile({1: intent(1, 454770000, 3)}, {1: {"state": 7}}, [oo(10, 1, "4.5477", "3")], [], "PURR/USDC", 0)
    assert [f.kind for f in rep.findings] == ["terminal_but_open"]


def test_keystore_envelope_compatible_with_keeper(tmp_path, monkeypatch):
    """Decrypts an envelope in the keeper's format (scrypt + AES-256-GCM)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    import os

    salt, iv = os.urandom(16), os.urandom(12)
    key = hashlib.scrypt(b"a long test passphrase", salt=salt, n=1 << 15, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024)
    ct = AESGCM(key).encrypt(iv, json.dumps({"watcher": "0x" + "33" * 32}).encode(), None)
    env = {"v": 1, "kdf": "scrypt", "N": 1 << 15, "r": 8, "p": 1, "salt": base64.b64encode(salt).decode(),
           "iv": base64.b64encode(iv).decode(), "tag": base64.b64encode(ct[-16:]).decode(),
           "ct": base64.b64encode(ct[:-16]).decode()}
    p = tmp_path / "ks.json"
    p.write_text(json.dumps(env))
    monkeypatch.setenv("STAPLE_KEYSTORE", str(p))
    monkeypatch.setenv("STAPLE_KEYSTORE_PASSPHRASE", "a long test passphrase")
    from staple_watcher.main import load_keys

    assert load_keys()["watcher"] == "0x" + "33" * 32
