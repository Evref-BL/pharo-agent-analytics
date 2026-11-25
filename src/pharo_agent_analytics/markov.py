"""The calls as Markov models.

A session is a sequence of calls; a Markov chain says the next call depends on
the last k only. The directly-follows graph is the first-order chain's counts,
so this module tests that order, finds where a longer memory matters, asks the
chain how a failure ends, and looks for hidden phases a session goes through.

Each model runs whatever the data: when the calls are too few for what a
model estimates, its criteria say so, and the report says it too.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Iterable

import numpy as np

START, END = "▶", "■"

#: A call: the tool, whether it failed, and how long the session stayed in it
#: (until the next call started, in ms), when the spans tell.
Call = tuple[str, bool, float | None]


def sequences(connection, facet_table: str = "faceted") -> dict[tuple[str, str], list[list[Call]]]:
    """The agent's calls of each kept facet, session by session, in order."""
    out: dict[tuple[str, str], dict[str, list[Call]]] = defaultdict(dict)
    rows = connection.execute(
        f"SELECT facet, facet_value, session_id, tool, failed, hold_ms FROM {facet_table} "
        "JOIN kept USING (facet, facet_value) ORDER BY facet, facet_value, session_id, step"
    ).fetchall()
    for facet, value, session, tool, failed, hold in rows:
        out[(facet, value)].setdefault(session, []).append((tool, bool(failed), hold))
    return {key: list(sessions.values()) for key, sessions in out.items()}


# ---------------------------------------------------------------- chi-square

def chi2_sf(x: float, df: float) -> float:
    """P(X > x) for X chi-square with df degrees of freedom."""
    if df <= 0:
        return float("nan")
    if x <= 0:
        return 1.0
    return _gamma_q(df / 2, x / 2)


def _gamma_q(a: float, x: float) -> float:
    """The regularized upper incomplete gamma function Q(a, x)."""
    if x < a + 1:
        # The series for P(a, x).
        term = total = 1 / a
        n = a
        for _ in range(10_000):
            n += 1
            term *= x / n
            total += term
            if abs(term) < abs(total) * 1e-15:
                break
        return max(0.0, 1 - total * math.exp(-x + a * math.log(x) - math.lgamma(a)))
    # Lentz's continued fraction for Q(a, x).
    tiny = 1e-300
    b = x + 1 - a
    c = 1 / tiny
    d = 1 / b
    h = d
    for i in range(1, 10_000):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        d = tiny if abs(d) < tiny else d
        c = b + an / c
        c = tiny if abs(c) < tiny else c
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < 1e-15:
            break
    return min(1.0, math.exp(-x + a * math.log(x) - math.lgamma(a)) * h)


# ---------------------------------------------------------------- order

def _transitions(seqs: Iterable[list[str]], k: int) -> tuple[Counter, Counter]:
    """Counts of each context of k calls, and of each (context, next call)."""
    contexts: Counter = Counter()
    joint: Counter = Counter()
    for seq in seqs:
        padded = [START] * k + list(seq) + [END]
        for i in range(k, len(padded)):
            context = tuple(padded[i - k:i])
            contexts[context] += 1
            joint[(context, padded[i])] += 1
    return contexts, joint


def _log_likelihood(contexts: Counter, joint: Counter) -> float:
    return sum(n * math.log(n / contexts[context]) for (context, _), n in joint.items())


def order_test(seqs: list[list[str]], max_order: int = 3, folds: int = 5) -> list[dict]:
    """Chains of order 0 to max_order, by the criteria that choose among them.

    A chain of order k has, for each context of k calls seen, a probability
    for every next call (each tool, or the session's end): (|tools|) free
    parameters per context. The likelihood ratio of order k against k - 1 is
    chi-square under the smaller chain. Held-out sessions are predicted with
    add-one smoothing, as bits per call: what each order would cost to
    predict calls it has not seen.
    """
    tools = {t for seq in seqs for t in seq}
    outcomes = len(tools) + 1
    calls = sum(len(seq) + 1 for seq in seqs)
    rows: list[dict] = []
    for k in range(max_order + 1):
        contexts, joint = _transitions(seqs, k)
        ll = _log_likelihood(contexts, joint)
        params = len(contexts) * (outcomes - 1)
        row = {
            "order": k, "log_likelihood": ll, "contexts": len(contexts), "parameters": params,
            "transitions": calls, "aic": -2 * ll + 2 * params, "bic": -2 * ll + params * math.log(max(calls, 1)),
            "lr": None, "df": None, "p_value": None, "heldout_bits": _heldout_bits(seqs, k, outcomes, folds),
        }
        if rows:
            previous = rows[-1]
            row["lr"] = 2 * (ll - previous["log_likelihood"])
            row["df"] = params - previous["parameters"]
            row["p_value"] = chi2_sf(row["lr"], row["df"]) if row["df"] > 0 else None
        rows.append(row)
    choices = _choices(rows)
    for row in rows:
        row["chosen_by"] = [name for name, order in choices.items() if order == row["order"]]
    return rows


def _heldout_bits(seqs: list[list[str]], k: int, outcomes: int, folds: int) -> float | None:
    folds = min(folds, len(seqs))
    if folds < 2:
        return None
    bits = 0.0
    n = 0
    for fold in range(folds):
        train = [s for i, s in enumerate(seqs) if i % folds != fold]
        test = [s for i, s in enumerate(seqs) if i % folds == fold]
        contexts, joint = _transitions(train, k)
        for seq in test:
            padded = [START] * k + list(seq) + [END]
            for i in range(k, len(padded)):
                context = tuple(padded[i - k:i])
                p = (joint.get((context, padded[i]), 0) + 1) / (contexts.get(context, 0) + outcomes)
                bits -= math.log2(p)
                n += 1
    return bits / n if n else None


def _choices(rows: list[dict]) -> dict[str, int]:
    """The order each criterion picks. The likelihood ratio goes up an order
    while the step up is significant at 5 %."""
    lr = 0
    for row in rows[1:]:
        if row["p_value"] is not None and row["p_value"] < 0.05:
            lr = row["order"]
        else:
            break
    choices = {"likelihood ratio": lr}
    choices["AIC"] = min(rows, key=lambda r: r["aic"])["order"]
    choices["BIC"] = min(rows, key=lambda r: r["bic"])["order"]
    heldout = [r for r in rows if r["heldout_bits"] is not None]
    if heldout:
        choices["held-out sessions"] = min(heldout, key=lambda r: r["heldout_bits"])["order"]
    return choices


# ---------------------------------------------------------------- memory

def memory(seqs: list[list[str]], sessions_of: list[str] | None = None) -> list[dict]:
    """The pairs of calls after which the next call differs most from what the
    last call alone predicts.

    For a context (before, last), `gain_bits` is the information knowing
    `before` adds, summed over the times the pair was followed:
    n · KL(P(next | before, last) ‖ P(next | last)). `next` is the call whose
    probability moved most.
    """
    first, first_joint = _transitions(seqs, 1)
    second, second_joint = _transitions(seqs, 2)
    sessions: dict[tuple, set] = defaultdict(set)
    for index, seq in enumerate(seqs):
        padded = [START, START] + list(seq) + [END]
        for i in range(2, len(padded)):
            sessions[tuple(padded[i - 2:i])].add(sessions_of[index] if sessions_of else index)
    nexts: dict[tuple, dict[str, int]] = defaultdict(dict)
    for (context, nxt), n in second_joint.items():
        nexts[context][nxt] = n
    rows = []
    for context, total in second.items():
        before, last = context
        if before == START and last == START:
            continue
        kl = 0.0
        moved, moved_by = None, -1.0
        for nxt in set(nexts[context]) | {x for (c, x) in first_joint if c == (last,)}:
            p2 = nexts[context].get(nxt, 0) / total
            p1 = first_joint.get(((last,), nxt), 0) / first[(last,)]
            if p2 > 0:
                kl += p2 * math.log2(p2 / p1)
            if abs(p2 - p1) > moved_by:
                moved, moved_by = nxt, abs(p2 - p1)
        rows.append({
            "before": before, "last": last, "times": total, "sessions": len(sessions[context]),
            "kl_bits": kl, "gain_bits": total * kl, "next": moved,
            "p_after_both": nexts[context].get(moved, 0) / total,
            "p_after_last": first_joint.get(((last,), moved), 0) / first[(last,)],
        })
    return sorted(rows, key=lambda r: -r["gain_bits"])


# ---------------------------------------------------------------- absorbing chain

def recovery(seqs: list[list[Call]]) -> list[dict]:
    """After a failed call of a tool, what the first-order chain over
    (tool, outcome) expects: the chance the tool works before the session
    ends, and the calls it takes.

    The tool working and the session ending are made absorbing; with Q the
    transitions among the other states and R those into the two, N = (I − Q)⁻¹
    gives the absorption probabilities N·R and the expected calls N·1, and
    the calls until the tool works, given that it does, (N·b) / b.

    When the spans give how long the session stays in each call, the chain is
    semi-Markov: with h each state's mean holding time, N·h is the time until
    either happens, and (N·(h ∘ b)) / b the time until the tool works, given
    that it does.
    """
    states = sorted({(c[0], c[1]) for seq in seqs for c in seq})
    index = {s: i for i, s in enumerate(states)}
    end = len(states)
    counts = np.zeros((len(states), len(states) + 1))
    held = np.zeros(len(states))
    holds = np.zeros(len(states))
    for seq in seqs:
        keys = [index[(c[0], c[1])] for c in seq]
        for a, b in zip(keys, keys[1:]):
            counts[a, b] += 1
        counts[keys[-1], end] += 1
        for key, call in zip(keys, seq):
            if len(call) > 2 and call[2] is not None:
                held[key] += call[2]
                holds[key] += 1
    timed = bool(holds.all())
    h = held / np.maximum(holds, 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        P = counts / counts.sum(axis=1, keepdims=True)
    rows = []
    for tool in sorted({t for t, failed in states if failed}):
        start = index[(tool, True)]
        works = index.get((tool, False))
        transient = [i for i in range(len(states)) if i != works]
        Q = P[np.ix_(transient, transient)]
        to_works = P[transient, works] if works is not None else np.zeros(len(transient))
        to_end = P[transient, end]
        try:
            N = np.linalg.inv(np.eye(len(transient)) - Q)
        except np.linalg.LinAlgError:
            continue
        i = transient.index(start)
        b_works = N @ to_works
        b_end = N @ to_end
        steps = N @ np.ones(len(transient))
        given = (N @ b_works)[i] / b_works[i] if b_works[i] > 0 else None
        seconds = seconds_given = None
        if timed:
            ht = h[transient]
            seconds = float((N @ ht)[i]) / 1000
            if b_works[i] > 0:
                seconds_given = float((N @ (ht * b_works))[i] / b_works[i]) / 1000
        rows.append({
            "tool": tool, "p_works": float(b_works[i]), "p_ends": float(b_end[i]),
            "expected_calls": float(steps[i]), "calls_if_works": None if given is None else float(given),
            "expected_seconds": seconds, "seconds_if_works": seconds_given,
        })
    return rows


# ---------------------------------------------------------------- hidden phases

@dataclass
class HMM:
    start: np.ndarray  # K
    trans: np.ndarray  # K × K
    emit: np.ndarray  # K × M
    log_likelihood: float

    @property
    def phases(self) -> int:
        return len(self.start)

    def parameters(self) -> int:
        k, m = self.emit.shape
        return (k - 1) + k * (k - 1) + k * (m - 1)


def _batches(seqs: list[np.ndarray], size: int = 512, flags: list[np.ndarray] | None = None) -> list[tuple]:
    """Sequences padded into batches of similar length, for vectorised
    passes; with `flags`, each batch also carries them, padded alike."""
    order = sorted(range(len(seqs)), key=lambda i: len(seqs[i]))
    out = []
    for begin in range(0, len(order), size):
        chosen = order[begin:begin + size]
        length = max(len(seqs[i]) for i in chosen)
        obs = np.zeros((len(chosen), length), dtype=np.int64)
        mask = np.zeros((len(chosen), length), dtype=bool)
        extra = np.zeros((len(chosen), length), dtype=bool)
        for row, i in enumerate(chosen):
            obs[row, :len(seqs[i])] = seqs[i]
            mask[row, :len(seqs[i])] = True
            if flags is not None:
                extra[row, :len(seqs[i])] = flags[i]
        out.append((obs, mask, extra) if flags is not None else (obs, mask))
    return out


def _forward_backward(model: HMM, obs: np.ndarray, mask: np.ndarray, backward: bool = True):
    """Scaled forward-backward over a padded batch: posteriors, expected
    transitions and the batch's log-likelihood."""
    n, length = obs.shape
    k = model.phases
    emitted = model.emit.T[obs]  # n × L × K
    alpha = np.zeros((n, length, k))
    scale = np.ones((n, length))
    a = model.start[None, :] * emitted[:, 0]
    scale[:, 0] = a.sum(axis=1)
    alpha[:, 0] = a / scale[:, 0, None]
    for t in range(1, length):
        a = (alpha[:, t - 1] @ model.trans) * emitted[:, t]
        live = mask[:, t]
        s = np.where(live, a.sum(axis=1), 1.0)
        scale[:, t] = s
        alpha[:, t] = np.where(live[:, None], a / s[:, None], 0.0)
    log_likelihood = float(np.log(scale[mask]).sum())
    if not backward:
        return None, None, log_likelihood
    beta = np.ones((n, length, k))
    xi = np.zeros((k, k))
    for t in range(length - 2, -1, -1):
        live = mask[:, t + 1]
        weighted = emitted[:, t + 1] * beta[:, t + 1]
        beta[:, t] = np.where(live[:, None], (weighted @ model.trans.T) / scale[:, t + 1, None], 1.0)
        pairs = alpha[:, t, :, None] * model.trans[None] * weighted[:, None, :] / scale[:, t + 1, None, None]
        xi += pairs[live].sum(axis=0)
    gamma = alpha * beta * mask[:, :, None]
    return gamma, xi, log_likelihood


def fit_hmm(seqs: list[np.ndarray], phases: int, symbols: int, seed: int = 0,
            restarts: int = 3, iterations: int = 200, tolerance: float = 1e-5) -> HMM:
    """Baum–Welch from several random starts; the most likely fit wins."""
    batches = _batches(seqs)
    best: HMM | None = None
    for restart in range(restarts):
        rng = np.random.default_rng(seed * 1009 + restart)
        model = HMM(
            start=np.full(phases, 1 / phases),
            trans=rng.dirichlet(np.ones(phases) * 5, size=phases),
            emit=rng.dirichlet(np.ones(symbols), size=phases),
            log_likelihood=-math.inf,
        )
        previous = -math.inf
        for _ in range(iterations):
            start = np.zeros(phases)
            trans = np.zeros((phases, phases))
            emit = np.zeros((symbols, phases))
            total = 0.0
            for obs, mask in batches:
                gamma, xi, ll = _forward_backward(model, obs, mask)
                total += ll
                start += gamma[:, 0].sum(axis=0)
                trans += xi
                np.add.at(emit, obs[mask], gamma[mask])
            model.log_likelihood = total
            # A small pseudo-count keeps every probability positive, so a
            # held-out call of a rare tool is never impossible.
            model.start = (start + 1e-3) / (start + 1e-3).sum()
            model.trans = (trans + 1e-3) / (trans + 1e-3).sum(axis=1, keepdims=True)
            model.emit = ((emit.T + 1e-3) / (emit.T + 1e-3).sum(axis=1, keepdims=True))
            if total - previous < tolerance * abs(total):
                break
            previous = total
        model.log_likelihood = sum(_forward_backward(model, o, m, backward=False)[2] for o, m in batches)
        if best is None or model.log_likelihood > best.log_likelihood:
            best = model
    return best  # type: ignore[return-value]


def log_likelihood(model: HMM, seqs: list[np.ndarray]) -> float:
    return sum(_forward_backward(model, o, m, backward=False)[2] for o, m in _batches(seqs))


def phases(seqs: list[list[Call]], max_phases: int = 6, folds: int = 3, heldout_limit: int = 50_000,
           seed: int = 0) -> tuple[list[dict], list[dict], list[dict], list[dict]]:
    """Hidden phases of the sessions, for 1 to max_phases phases.

    Returns the model comparison, and for every number of phases from 2 the
    phases (share of calls, failures, dwell, place, tools), the transitions
    between them, and their share of calls by place in the session. Held-out
    sessions are scored while the calls are few enough for folds to be cheap;
    beyond, BIC alone, which then needs no help.
    """
    tools = sorted({c[0] for seq in seqs for c in seq})
    symbol = {t: i for i, t in enumerate(tools)}
    encoded = [np.array([symbol[c[0]] for c in seq], dtype=np.int64) for seq in seqs if seq]
    failed = [np.array([c[1] for c in seq], dtype=bool) for seq in seqs if seq]
    calls = sum(len(s) for s in encoded)
    if not calls:
        return [], [], [], []
    folds = min(folds, len(encoded)) if calls <= heldout_limit else 0
    fits, phase_rows, transition_rows, place_rows = [], [], [], []
    for k in range(1, max_phases + 1):
        model = fit_hmm(encoded, k, len(tools), seed=seed + k)
        heldout = None
        if folds >= 2:
            bits, n = 0.0, 0
            for fold in range(folds):
                train = [s for i, s in enumerate(encoded) if i % folds != fold]
                test = [s for i, s in enumerate(encoded) if i % folds == fold]
                held = fit_hmm(train, k, len(tools), seed=seed + 100 * fold + k, restarts=2)
                bits -= log_likelihood(held, test) / math.log(2)
                n += sum(len(s) for s in test)
            heldout = bits / n
        params = model.parameters()
        fits.append({
            "phases": k, "log_likelihood": model.log_likelihood, "parameters": params, "calls": calls,
            "aic": -2 * model.log_likelihood + 2 * params,
            "bic": -2 * model.log_likelihood + params * math.log(max(calls, 1)),
            "heldout_bits": heldout,
        })
        if k >= 2:
            p, t, place = _describe(model, encoded, failed, tools)
            phase_rows += [{"phases": k, **row} for row in p]
            transition_rows += [{"phases": k, **row} for row in t]
            place_rows += [{"phases": k, **row} for row in place]
    best_bic = min(fits, key=lambda f: f["bic"])["phases"]
    scored = [f for f in fits if f["heldout_bits"] is not None]
    best_heldout = min(scored, key=lambda f: f["heldout_bits"])["phases"] if scored else None
    for f in fits:
        f["chosen_by"] = (["BIC"] if f["phases"] == best_bic else []) + (["held-out sessions"] if f["phases"] == best_heldout else [])
    return fits, phase_rows, transition_rows, place_rows


def _describe(model: HMM, encoded: list[np.ndarray], failed: list[np.ndarray], tools: list[str]):
    """Each phase by its posterior weight on the calls; phases numbered by
    their mean place in the session, the earliest first."""
    k = model.phases
    weight = np.zeros(k)
    fail = np.zeros(k)
    place_sum = np.zeros(k)
    by_place = np.zeros((10, k))
    first = np.zeros(k)
    last = np.zeros(k)
    for obs, mask, flags in _batches(encoded, flags=failed):
        gamma, _, _ = _forward_backward(model, obs, mask)
        lengths = mask.sum(axis=1)
        where = (np.arange(obs.shape[1])[None, :] + 0.5) / lengths[:, None]
        weight += gamma[mask].sum(axis=0)
        fail += gamma[mask & flags].sum(axis=0)
        place_sum += (gamma * where[:, :, None])[mask].sum(axis=0)
        np.add.at(by_place, np.minimum((where[mask] * 10).astype(int), 9), gamma[mask])
        first += gamma[:, 0].sum(axis=0)
        last += gamma[np.arange(len(lengths)), lengths - 1].sum(axis=0)
    mean_place = place_sum / np.maximum(weight, 1e-12)
    order = np.argsort(mean_place)
    number = {int(old): new + 1 for new, old in enumerate(order)}
    sessions = len(encoded)
    phase_rows = []
    for old in order:
        top = [i for i in np.argsort(-model.emit[old])[:6] if model.emit[old, i] >= 0.02]
        phase_rows.append({
            "phase": number[int(old)],
            "share": float(weight[old] / weight.sum()),
            "failed": float(fail[old] / max(weight[old], 1e-12)),
            "dwell": float(1 / max(1 - model.trans[old, old], 1e-12)),
            "place": float(mean_place[old]),
            "starts": float(first[old] / sessions),
            "ends": float(last[old] / sessions),
            "tools": [tools[i] for i in top],
            "probabilities": [float(model.emit[old, i]) for i in top],
        })
    transition_rows = [
        {"source": number[i], "target": number[j], "p": float(model.trans[i, j])}
        for i in range(k) for j in range(k)
    ]
    totals = by_place.sum(axis=1)
    place_rows = [
        {"decile": d, "phase": number[j], "share": float(by_place[d, j] / totals[d]) if totals[d] else 0.0}
        for d in range(10) for j in range(k)
    ]
    return phase_rows, transition_rows, place_rows
