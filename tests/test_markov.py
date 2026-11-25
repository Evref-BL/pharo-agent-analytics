"""The Markov models, on sequences whose answers are known."""

import random

import numpy as np
import pytest

from pharo_agent_analytics import markov


def test_chi_square_tail_matches_the_tables():
    assert markov.chi2_sf(3.841459, 1) == pytest.approx(0.05, abs=1e-6)
    assert markov.chi2_sf(18.307038, 10) == pytest.approx(0.05, abs=1e-6)
    assert markov.chi2_sf(2700, 2678) == pytest.approx(0.375, abs=0.02)
    assert markov.chi2_sf(0, 3) == 1.0


def first_order(n_sessions, seed=1):
    """Sessions from a chain where the next call depends on the last only."""
    rng = random.Random(seed)
    after = {"a": ["b", "b", "b", "c"], "b": ["c", "a", "c", "c"], "c": ["a", "a", "b", "end"]}
    out = []
    for _ in range(n_sessions):
        seq, call = [], rng.choice("abc")
        while call != "end" and len(seq) < 60:
            seq.append(call)
            call = rng.choice(after[call])
        out.append(seq)
    return out


def second_order(n_sessions, seed=2):
    """Sessions where the next call depends on the last two: after x then y,
    x again, so the calls alternate in pairs."""
    rng = random.Random(seed)
    out = []
    for _ in range(n_sessions):
        seq = [rng.choice("abc"), rng.choice("abc")]
        while len(seq) < 30 and rng.random() > 0.05:
            seq.append(seq[-2] if rng.random() < 0.9 else rng.choice("abc"))
        out.append(seq)
    return out


def test_the_order_test_finds_a_first_order_chain():
    rows = markov.order_test(first_order(400))
    chosen = {name for row in rows if row["order"] == 1 for name in row["chosen_by"]}
    assert {"likelihood ratio", "BIC", "held-out sessions"} <= chosen
    assert rows[1]["p_value"] < 1e-6 and rows[2]["p_value"] > 0.01


def test_the_order_test_finds_memory_of_two_calls():
    rows = markov.order_test(second_order(400))
    chosen = {name for row in rows if row["order"] == 2 for name in row["chosen_by"]}
    assert {"BIC", "held-out sessions"} <= chosen


def test_too_few_calls_for_the_transitions_make_the_penalised_criteria_prefer_no_memory():
    rng = random.Random(4)
    tools = [f"tool{i}" for i in range(20)]
    rows = markov.order_test([[rng.choice(tools) for _ in range(6)] for _ in range(8)])
    assert {name for row in rows if row["order"] == 0 for name in row["chosen_by"]} >= {"BIC"}


def test_memory_names_the_pair_after_which_the_next_call_changes():
    rows = markov.memory(second_order(300))
    top = rows[0]
    assert top["next"] == top["before"] and top["p_after_both"] > top["p_after_last"] + 0.3
    assert top["sessions"] > 1 and top["gain_bits"] > 0


def test_the_absorbing_chain_answers_like_the_algebra():
    # From a failed x: half the time x works next, half the time the session
    # ends; from an ok x, the session ends.
    seqs = [[("x", True), ("x", False)], [("x", True)]]
    [row] = markov.recovery(seqs)
    assert row["tool"] == "x"
    assert row["p_works"] == pytest.approx(0.5) and row["p_ends"] == pytest.approx(0.5)
    assert row["expected_calls"] == pytest.approx(1.0) and row["calls_if_works"] == pytest.approx(1.0)


def test_a_tool_retried_through_another_takes_the_calls_the_chain_says():
    # Failed x → y → x ok, every time: two calls until x works, surely.
    seqs = [[("x", True), ("y", False), ("x", False)]] * 5
    [row] = markov.recovery(seqs)
    assert row["p_works"] == pytest.approx(1.0) and row["calls_if_works"] == pytest.approx(2.0)


def two_phases(n_sessions, seed=3):
    """Sessions that explore (search, read) and then edit (compile, test)."""
    rng = random.Random(seed)
    out = []
    for _ in range(n_sessions):
        seq = [(rng.choice(["search", "read"]), False) for _ in range(rng.randint(4, 8))]
        seq += [(rng.choice(["compile", "test"]), rng.random() < 0.3) for _ in range(rng.randint(4, 8))]
        out.append(seq)
    return out


def test_hidden_phases_find_exploring_then_editing():
    fits, phases, transitions, places = markov.phases(two_phases(80), max_phases=3)
    by_k = {f["phases"]: f for f in fits}
    assert by_k[2]["bic"] < by_k[1]["bic"] and "BIC" not in by_k[1]["chosen_by"]
    two = [p for p in phases if p["phases"] == 2]
    assert set(two[0]["tools"][:2]) == {"search", "read"} and set(two[1]["tools"][:2]) == {"compile", "test"}
    assert two[0]["failed"] < 0.05 < two[1]["failed"]
    assert two[0]["starts"] > 0.9 and two[1]["ends"] > 0.9
    stay = {(t["source"], t["target"]): t["p"] for t in transitions if t["phases"] == 2}
    assert stay[(1, 1)] > 0.7 and stay[(2, 1)] < 0.05
    first_decile = {p["phase"]: p["share"] for p in places if p["phases"] == 2 and p["decile"] == 0}
    assert first_decile[1] > 0.9


def test_baum_welch_never_lowers_the_likelihood():
    seqs = [np.array([i % 3 for i in range(n)]) for n in (5, 9, 12)]
    one = markov.fit_hmm(seqs, 2, 3, iterations=1, restarts=1)
    many = markov.fit_hmm(seqs, 2, 3, iterations=50, restarts=1)
    assert many.log_likelihood >= one.log_likelihood - 1e-9
