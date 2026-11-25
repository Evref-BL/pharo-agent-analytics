"""When the calls are too few, the report says so on the view it concerns."""

import json

import pytest

from pharo_agent_analytics import report, sufficiency
from test_everything_exported import connection  # noqa: F401  (the fixture)


def test_a_share_of_seventeen_is_known_to_about_twenty_one_points():
    assert sufficiency.half_width(17) == pytest.approx(0.2146, abs=1e-3)
    assert sufficiency.half_width(sufficiency.ENOUGH) <= sufficiency.ROUGH < sufficiency.half_width(sufficiency.ENOUGH - 1)


def order_rows(picks):
    return [{"order": k, "parameters": 26 * 27 ** k, "transitions": 480, "chosen_by": names} for k, names in enumerate(picks)]


def test_the_penalised_criteria_choosing_less_memory_warn():
    message = sufficiency.order(order_rows([["AIC", "BIC"], ["likelihood ratio", "held-out sessions"], [], []]))
    assert "AIC and BIC choose no memory, held-out sessions 1 call back" in message and "702 probabilities" in message
    assert sufficiency.order(order_rows([[], ["AIC", "BIC", "likelihood ratio", "held-out sessions"], [], []])) is None


def test_pairs_warn_while_no_criterion_finds_memory_beyond_the_last_call():
    pairs = [{"before": "a", "last": "b"}]
    assert sufficiency.memory(order_rows([["AIC"], ["held-out sessions"], [], []]), pairs)
    assert sufficiency.memory(order_rows([["AIC"], [], ["held-out sessions"], []]), pairs) is None


def test_phases_warn_when_the_criteria_disagree_or_find_none():
    fits = lambda picks: [{"phases": k + 1, "heldout_bits": 4.0, "chosen_by": names} for k, names in enumerate(picks)]
    assert "the 3 more that held-out sessions finds" in sufficiency.phases(fits([[], ["BIC"], [], [], ["held-out sessions"]]))
    assert "single phase" in sufficiency.phases(fits([["BIC", "held-out sessions"], [], []]))
    assert sufficiency.phases(fits([[], ["BIC", "held-out sessions"], []])) is None


def test_releases_warn_only_where_a_component_has_releases_to_compare():
    table = lambda rows: {"columns": ["component", "release", "tool", "sessions"], "rows": rows}
    assert sufficiency.releases(table([["MCP", "4.4.0", "x", 9], ["PLexus", "0.22.0", "x", 10]])) is None
    assert "MCP 4.4.0, MCP 4.5.0" in sufficiency.releases(table([["MCP", "4.4.0", "x", 9], ["MCP", "4.5.0", "x", 12]]))


def test_the_report_carries_its_warnings(connection, tmp_path):  # noqa: F811
    meta = report.write(connection, tmp_path, max_phases=2)
    assert meta["enough"] == sufficiency.ENOUGH
    warnings = json.loads((tmp_path / "warnings.json").read_text())
    assert warnings["columns"] == ["facet", "facet_value", "view", "message", "shown"]
    shown = {r[2]: r[4] for r in warnings["rows"] if r[0] == "all"}
    assert shown["report"] == "note" and shown["recovery"] == "note"
    assert all(shown[v] == "sign" for v in sufficiency.SESSION_SHARES)
