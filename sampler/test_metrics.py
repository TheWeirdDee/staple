from metrics import classify, compute, second_metrics


def row(s, bids, asks, valid=True):
    return {"s": s, "valid": valid, "bids": [[p, z, 1] for p, z in bids], "asks": [[p, z, 1] for p, z in asks]}


def test_wide_book_is_not_at_target():
    m = second_metrics(row(1, [("4.5342", "100000")], [("4.5795", "77692")]))
    assert round(m["spreadBps"], 1) == 99.4 and m["atTarget"] is False


def test_tight_deep_book_is_at_target_and_depth_band_applies():
    m = second_metrics(row(1, [("4.548", "3"), ("4.40", "500")], [("4.565", "3")]))
    assert m["atTarget"] is True and m["bidDepth"] == 3.0
    thin = second_metrics(row(1, [("4.548", "2")], [("4.565", "3")]))
    rounded_out = second_metrics(row(1, [("4.5477", "3")], [("4.566", "3")]))
    assert rounded_out["atTarget"] is False  # 40.2 bps after tick rounding
    assert thin["atTarget"] is False


def test_invalid_and_crossed_rows_are_excluded():
    assert second_metrics(row(1, [("4.5", "3")], [("4.6", "3")], valid=False)) is None
    assert second_metrics(row(1, [("4.6", "3")], [("4.5", "3")])) is None


def test_arms_follow_chain_state(tmp_path):
    lines = [row(100 + i, [("4.548", "3")], [("4.565", "3")]) for i in range(10)]
    lines += [row(110 + i, [("4.5342", "100000")], [("4.5795", "77692")]) for i in range(10)]
    import json
    (tmp_path / "book-2026101700.jsonl").write_text("\n".join(json.dumps(r) for r in lines))
    states = [{"t": 100, "to": "ACTIVE"}, {"t": 110, "to": "PAUSED"}]
    assert classify(states, 105) == "ACTIVE" and classify(states, 115) == "PAUSED"
    res = compute(str(tmp_path), states)
    assert res["arms"]["on"]["timeAtTarget"] == 1.0 and res["arms"]["off"]["timeAtTarget"] == 0.0
    assert res["improvementPctPoints"] == 100.0
