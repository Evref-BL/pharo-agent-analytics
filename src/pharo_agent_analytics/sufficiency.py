"""What the calls are too few for: warnings the report shows on the views
they concern, per facet.

Two signals, neither a fixed sample size:

- Where criteria choose a model, their disagreement. AIC and BIC charge for
  every probability a model estimates; when they choose less memory or fewer
  phases than held-out sessions or the likelihood ratio do, the calls are too
  few to pin the richer model down, and it is a lead, not a finding.
- Where a view shows shares, how precise a share of the count it rests on
  can be: at best, the half-width of its 95 % Wilson interval at one half. A
  view warns when that is wider than ROUGH.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Any

#: The widest a share's 95 % interval may be, either side, before a view warns.
ROUGH = 0.15
Z = 1.96


def half_width(n: int) -> float:
    """The half-width of the 95 % Wilson interval of a share of one half out of n."""
    if n <= 0:
        return 1.0
    z2 = Z * Z
    return Z * math.sqrt(0.25 / n + z2 / (4 * n * n)) / (1 + z2 / n)


#: The fewest observations whose shares are known to ±ROUGH.
ENOUGH = next(n for n in range(1, 10_000) if half_width(n) <= ROUGH)


def points(n: int) -> str:
    return f"±{round(100 * half_width(n))} points"


def _by_facet(table: dict[str, Any] | None) -> dict[tuple, list[dict[str, Any]]]:
    out: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    if not table or not table.get("rows"):
        return out
    columns = table["columns"]
    for row in table["rows"]:
        record = dict(zip(columns, row))
        out[(record.get("facet", "all"), record.get("facet_value", "all"))].append(record)
    return out


def _picks(rows: list[dict[str, Any]], key: str) -> dict[str, int]:
    return {name: row[key] for row in rows for name in row.get("chosen_by") or []}


def _back(n: int) -> str:
    return "no memory" if n == 0 else f"{n} call{'s' if n > 1 else ''} back"


def order(rows: list[dict[str, Any]]) -> str | None:
    picks = _picks(rows, "order")
    penalised = [picks[c] for c in ("AIC", "BIC") if c in picks]
    others = [picks[c] for c in ("held-out sessions", "likelihood ratio") if c in picks]
    if not penalised or not others or max(others) <= max(penalised):
        return None
    richer = max(others)
    row = next(r for r in rows if r["order"] == richer)
    by = "held-out sessions" if picks.get("held-out sessions") == richer else "the likelihood ratio"
    return (f"AIC and BIC choose {_back(max(penalised))}, {by} {_back(richer)}: a chain of {_back(richer)} estimates "
            f"{row['parameters']:,} probabilities from {row['transitions']:,} transitions, more than these calls pin down. "
            f"Read its memory as a lead until there are calls enough for AIC and BIC to weigh it.")


def memory(order_rows: list[dict[str, Any]], memory_rows: list[dict[str, Any]]) -> str | None:
    if not memory_rows or not order_rows:
        return None
    if any(n >= 2 for n in _picks(order_rows, "order").values()):
        return None
    return ("No criterion finds that the call before last matters here: these pairs are where such memory "
            "would show first, not evidence of it.")


def phases(rows: list[dict[str, Any]]) -> str | None:
    if not rows:
        return None
    picks = _picks(rows, "phases")
    if picks and all(n == 1 for n in picks.values()):
        return ("Every criterion prefers a single phase: the phases drawn are what more would look like, "
                "not phases these calls show.")
    bic, heldout = picks.get("BIC"), picks.get("held-out sessions")
    if bic is not None and heldout is not None and bic != heldout:
        low, high = sorted((bic, heldout))
        more = "held-out sessions" if heldout == high else "BIC"
        return (f"BIC chooses {bic} phases, held-out sessions {heldout}: these calls support {low} with confidence; "
                f"the {high - low} more that {more} finds may not hold up on more sessions.")
    if bic is not None and heldout is None and all(r.get("heldout_bits") is None for r in rows):
        return "Too few sessions to hold any out: BIC alone chooses the number of phases."
    return None


def chain(rows: list[dict[str, Any]]) -> str | None:
    shown = sorted((r for r in rows if r["failures"] > 0), key=lambda r: -r["failures"])[:15]
    few = [r for r in shown if r["failures"] < ENOUGH]
    if not few:
        return None
    return (f"{len(few)} of the {len(shown)} tools shown failed fewer than {ENOUGH} times: the chain's chances for "
            f"them rest on few failures, and the observed shares beside them are known to {points(few[0]['failures'])} or worse.")


def shares(n: int, what: str) -> str | None:
    if n >= ENOUGH or n <= 0:
        return None
    return f"{n:,} {what}: the shares here are known to {points(n)} at best."


def sessions_of(n: int) -> str | None:
    if n >= ENOUGH or n <= 0:
        return None
    return (f"{n:,} session{'s' if n != 1 else ''}: a share of them is known to {points(n)} at best, so a "
            f"difference between tools, hosts or releases smaller than that may be chance.")


def variants(rows: list[dict[str, Any]], sessions: int, min_sessions: int) -> str | None:
    if not rows or not sessions:
        return None
    alone = sum(r["sessions"] for r in rows if r["variant"] == "other variants" or r["sessions"] < 2)
    if alone * 2 < sessions:
        return None
    shared = "no other session shares" if min_sessions <= 2 else f"fewer than {min_sessions} sessions share"
    return (f"{alone} of {sessions} sessions follow a sequence {shared}: too few sessions for whole sequences to "
            f"repeat. The process map and the Markov models, which look at pairs of calls, generalise instead.")


def releases(table: dict[str, Any] | None) -> str | None:
    rows = _by_facet(table).get(("all", "all"), [])
    seen: dict[tuple, int] = {}
    for r in rows:
        key = (r["component"], r["release"])
        seen[key] = max(seen.get(key, 0), r["sessions"])
    # Releases are compared within a component: one with a single release compares nothing.
    compared = {c for c, _ in seen if sum(1 for other, _ in seen if other == c) > 1}
    few = sorted((n, f"{c} {v}") for (c, v), n in seen.items() if c in compared and n < ENOUGH)
    if not few:
        return None
    names = ", ".join(name for _, name in sorted(few, key=lambda f: f[1]))
    return (f"{names} saw fewer than {ENOUGH} sessions: a rate of theirs is known to {points(few[0][0])} "
            f"or worse, wider than most differences between releases.")


def warnings(files: dict[str, Any], meta: dict[str, Any]) -> dict[str, Any]:
    """The warnings of every facet, as a report file: facet, facet_value, view, message."""
    out: list[list[Any]] = []
    sessions = {key: rows[0]["sessions"] for key, rows in _by_facet(files.get("facets")).items()}
    sessions[("all", "all")] = meta["sessions"]
    order_rows = _by_facet(files.get("markov-order"))
    memory_rows = _by_facet(files.get("markov-memory"))
    phase_rows = _by_facet(files.get("phase-fits"))
    chain_rows = _by_facet(files.get("markov-recovery"))
    failure_rows = _by_facet(files.get("recovery-curves"))
    green_rows = _by_facet(files.get("green-curves"))
    variant_rows = _by_facet(files.get("variants"))
    for key, n in sorted(sessions.items()):
        def add(view: str, message: str | None) -> None:
            if message:
                out.append([key[0], key[1], view, message])

        add("report", sessions_of(n))
        add("markov-order", order(order_rows.get(key, [])))
        add("markov-memory", memory(order_rows.get(key, []), memory_rows.get(key, [])))
        add("phases", phases(phase_rows.get(key, [])))
        add("markov-recovery", chain(chain_rows.get(key, [])))
        # The curves start with every failure at risk; group "all" holds every kind of error.
        failures = sum(r["at_risk"] for r in failure_rows.get(key, []) if r["calls"] == 0 and r["group"] == "all")
        add("recovery", shares(failures, "failed calls"))
        add("recovery-curves", shares(failures, "failed calls"))
        curves = [r for r in green_rows.get(key, []) if r["calls"] == 0 and r["group"] == "all"]
        add("green-curves", shares(sum(r["at_risk"] for r in curves), "sessions compiled a method"))
        add("variants", variants(variant_rows.get(key, []), n, meta.get("minSessions", 1)))
    add_release = releases(files.get("releases"))
    if add_release:
        out.append(["all", "all", "releases", add_release])
    return {"columns": ["facet", "facet_value", "view", "message"], "rows": out}
