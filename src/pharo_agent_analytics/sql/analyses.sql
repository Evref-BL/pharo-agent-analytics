-- The analyses, each a table the report reads. Every one is computed per
-- facet: all calls, and the calls of each agent host, MCP release, PLexus
-- release and environment, so comparing releases or hosts is choosing a
-- facet, never a new query.
--
-- Calls of one session are not independent (a retry storm is one cause, not
-- twenty), so a rate is given per session as well as per call, and its
-- interval is the session's.

-- Wilson score interval of k successes in n, at 95 %.
CREATE OR REPLACE MACRO wilson_low(k, n) AS CASE WHEN n = 0 THEN NULL ELSE
    ((k / n) + 1.9208 / n - 1.96 * sqrt((k / n) * (1 - k / n) / n + 0.9604 / (n * n))) / (1 + 3.8416 / n) END;
CREATE OR REPLACE MACRO wilson_high(k, n) AS CASE WHEN n = 0 THEN NULL ELSE
    ((k / n) + 1.9208 / n + 1.96 * sqrt((k / n) * (1 - k / n) / n + 0.9604 / (n * n))) / (1 + 3.8416 / n) END;

-- What an agent asked for, in order: the calls it made, not those an image's tool_call dispatched.
CREATE OR REPLACE TABLE steps AS
SELECT
    c.*,
    coalesce(host || coalesce(' ' || host_release, ''), 'unknown host')  AS host_label,
    lag(tool)    OVER w AS prev_tool,
    lag(failed)  OVER w AS prev_failed,
    lead(tool)   OVER w AS next_tool,
    lead(failed) OVER w AS next_failed,
    order_ms - lag(order_ms) OVER w AS gap_ms,
    row_number() OVER w AS step,
    count(*) OVER (PARTITION BY session_id) AS session_steps
FROM calls c
WHERE NOT dispatched AND tool IS NOT NULL
WINDOW w AS (PARTITION BY session_id ORDER BY seq);

-- Each step once per facet it belongs to.
CREATE OR REPLACE TABLE faceted AS
SELECT s.*, f.facet, f.facet_value
FROM steps s,
     LATERAL (VALUES ('all', 'all'),
                     ('host', s.host_label),
                     ('MCP', s.mcp_version),
                     ('PLexus', s.plexus_version),
                     ('Pharo', s.pharo_release),
                     ('environment', s.environment)) f(facet, facet_value)
WHERE f.facet_value IS NOT NULL;

CREATE OR REPLACE TABLE facets AS
SELECT facet, facet_value, count(*) AS calls, count(DISTINCT session_id) AS sessions,
       min(week) AS first_week, max(week) AS last_week
FROM faceted GROUP BY ALL;

-- Volume and failure per period: a day when the spans kept their time and
-- span a few months at most, else a week.
CREATE OR REPLACE TABLE period AS
SELECT CASE WHEN bool_and(time_precise) AND max(start_time) - min(start_time) <= INTERVAL 120 DAY
            THEN 'day' ELSE 'week' END AS unit
FROM steps;

CREATE OR REPLACE TABLE a_weekly AS
SELECT facet, facet_value,
       date_trunc((SELECT unit FROM period), start_time) AS week,
       count(*) AS calls,
       count(DISTINCT session_id) AS sessions,
       count(*) FILTER (WHERE failed) AS failed,
       count(DISTINCT session_id) FILTER (WHERE failed) AS sessions_with_failure
FROM faceted GROUP BY ALL;

-- Each tool: use, failure (per call and per session), how it failed, time and size.
CREATE OR REPLACE TABLE a_tools AS
WITH per_session AS (
    SELECT facet, facet_value, tool, session_id, bool_or(failed) AS any_failed, count(*) AS calls
    FROM faceted GROUP BY ALL
)
SELECT
    f.facet, f.facet_value, f.tool,
    any_value(f.tool_origin) AS origin,
    count(*) AS calls,
    count(*) FILTER (WHERE f.failed) AS failed,
    count(DISTINCT f.session_id) AS sessions,
    (SELECT count(*) FILTER (WHERE any_failed) FROM per_session p
      WHERE p.facet = f.facet AND p.facet_value = f.facet_value AND p.tool = f.tool) AS sessions_failed,
    count(*) FILTER (WHERE f.error_kind = 'input_schema') AS input_schema,
    count(*) FILTER (WHERE f.error_kind = 'domain') AS domain,
    count(*) FILTER (WHERE f.error_kind = 'tool_result') AS tool_result,
    count(*) FILTER (WHERE f.error_kind = 'json_rpc') AS json_rpc,
    count(*) FILTER (WHERE f.error_kind = 'exception') AS exception,
    count(*) FILTER (WHERE f.plexus_error_code IS NOT NULL) AS refused_by_plexus,
    count(*) FILTER (WHERE f.failed AND f.error_kind IS NULL AND f.plexus_error_code IS NULL) AS other_failure,
    quantile_cont(f.duration_ms, 0.5) AS p50_ms,
    quantile_cont(f.duration_ms, 0.9) AS p90_ms,
    count(*) FILTER (WHERE f.budget_exceeded) AS budget_exceeded,
    count(*) FILTER (WHERE f.advertised = FALSE) AS unadvertised,
    count(*) FILTER (WHERE len(f.unknown_arguments) > 0) AS unknown_arguments
FROM faceted f
GROUP BY f.facet, f.facet_value, f.tool;

ALTER TABLE a_tools ADD COLUMN session_failure_low DOUBLE;
ALTER TABLE a_tools ADD COLUMN session_failure_high DOUBLE;
UPDATE a_tools SET session_failure_low = wilson_low(sessions_failed::DOUBLE, sessions::DOUBLE),
                   session_failure_high = wilson_high(sessions_failed::DOUBLE, sessions::DOUBLE);

-- The directly-follows graph of sessions: which call follows which, with the
-- time between them. Start and end are nodes of their own. It is the
-- first-order Markov chain's counts: `share` is P(target | source), the
-- chain's transition probability.
CREATE OR REPLACE TABLE a_dfg AS
SELECT *, count / sum(count) OVER (PARTITION BY facet, facet_value, source) AS share FROM (
SELECT facet, facet_value,
       coalesce(prev_tool, '▶') AS source, tool AS target,
       count(*) AS count, count(DISTINCT session_id) AS sessions,
       count(*) FILTER (WHERE failed) AS target_failed,
       count(*) FILTER (WHERE prev_failed) AS source_failed,
       quantile_cont(gap_ms, 0.5) AS median_gap_ms
FROM faceted GROUP BY ALL
UNION ALL
SELECT facet, facet_value, tool, '■', count(*), count(DISTINCT session_id),
       0, count(*) FILTER (WHERE failed), NULL
FROM faceted WHERE next_tool IS NULL GROUP BY ALL);

-- The same, the tool as used in one session being the object: the calls that
-- named it (discovery) and that called it, in order. Shows whether a found
-- tool is then called, and how a tool's calls go after a failure.
CREATE OR REPLACE TABLE tool_use_events AS
SELECT facet, facet_value, session_id, step, tool AS object_tool,
       CASE WHEN failed THEN 'failed' ELSE 'ok' END AS activity
FROM faceted
UNION ALL
SELECT facet, facet_value, session_id, step, ref, 'named by ' || tool
FROM (SELECT *, unnest(tool_refs) AS ref FROM faceted WHERE tool_refs IS NOT NULL)
WHERE ref <> '_OTHER' AND ref <> tool;

CREATE OR REPLACE TABLE a_tool_use_dfg AS
WITH ordered AS (
    SELECT *, lag(activity) OVER (PARTITION BY facet, facet_value, session_id, object_tool ORDER BY step, activity DESC) AS prev
    FROM tool_use_events
)
SELECT *, count / sum(count) OVER (PARTITION BY facet, facet_value, tool, source) AS share FROM (
SELECT facet, facet_value, object_tool AS tool, coalesce(prev, '▶') AS source, activity AS target,
       count(*) AS count, count(DISTINCT session_id) AS sessions
FROM ordered GROUP BY ALL);

-- Session variants: the sequence of tools, repeats folded (a run of the same
-- tool is one step, marked ×), as a string.
CREATE OR REPLACE TABLE a_variants AS
WITH runs AS (
    SELECT facet, facet_value, session_id, step, tool, failed,
           CASE WHEN prev_tool IS DISTINCT FROM tool THEN 1 ELSE 0 END AS starts
    FROM faceted
), grouped AS (
    SELECT *, sum(starts) OVER (PARTITION BY facet, facet_value, session_id ORDER BY step) AS run
    FROM runs
), collapsed AS (
    SELECT facet, facet_value, session_id, run, any_value(tool) AS tool, count(*) AS n, bool_or(failed) AS any_failed
    FROM grouped GROUP BY ALL
), variants AS (
    SELECT facet, facet_value, session_id,
           string_agg(tool || CASE WHEN n > 1 THEN '×' ELSE '' END, ' → ' ORDER BY run) AS variant,
           count(*) AS length,
           bool_or(any_failed) AS any_failed
    FROM collapsed GROUP BY ALL
)
SELECT facet, facet_value, variant, length,
       count(*) AS sessions, count(*) FILTER (WHERE any_failed) AS sessions_failed
FROM variants GROUP BY ALL;

-- After a failed call, what the agent did next, and whether the same tool
-- later succeeded in the session. The arguments' shape is their names and
-- options (never their values): a retry with the same shape repeated the
-- call as far as the spans can tell.
CREATE OR REPLACE TABLE recoveries AS
WITH next AS (
    SELECT f.*,
           lead(arguments) OVER w AS next_arguments,
           lead(options) OVER w AS next_options
    FROM faceted f
    WINDOW w AS (PARTITION BY facet, facet_value, session_id ORDER BY step)
)
SELECT f.facet, f.facet_value, f.session_id, f.step, f.tool,
       coalesce(f.error_kind, CASE WHEN f.plexus_error_code IS NOT NULL THEN 'refused by PLexus' END,
                CASE WHEN f.error_type = 'tool_error' THEN 'tool_result' END, 'other') AS error_kind,
       CASE
           WHEN f.next_tool IS NULL THEN 'ended the session'
           WHEN f.next_tool = f.tool
                AND list_sort(coalesce(f.next_arguments, [])) = list_sort(coalesce(f.arguments, []))
                AND list_sort(coalesce(f.next_options, [])) = list_sort(coalesce(f.options, [])) THEN 'same call again'
           WHEN f.next_tool = f.tool THEN 'same tool, other arguments'
           WHEN f.next_tool = 'evaluate' THEN 'fell back to evaluate'
           WHEN f.next_tool IN ('tool_search', 'tool_get') THEN 'looked for a tool'
           ELSE 'another tool'
       END AS next_action,
       f.next_tool = f.tool AND NOT f.next_failed AS next_succeeded,
       (SELECT min(later.step) FROM faceted later
         WHERE later.facet = f.facet AND later.facet_value = f.facet_value
           AND later.session_id = f.session_id AND later.tool = f.tool
           AND later.step > f.step AND NOT later.failed) AS recovered_at
FROM next f
WHERE f.failed;

CREATE OR REPLACE TABLE a_recovery AS
SELECT facet, facet_value, error_kind, next_action,
       CASE WHEN recovered_at IS NOT NULL THEN 'the tool worked later' ELSE 'the tool never worked again' END AS outcome,
       count(*) AS failures, count(DISTINCT session_id) AS sessions,
       quantile_cont(recovered_at - step, 0.5) AS median_calls_to_success
FROM recoveries GROUP BY ALL;

-- Calls from a failure until its tool works, or until the session ends
-- without it: two competing outcomes, for cumulative incidence curves.
CREATE OR REPLACE TABLE a_recovery_times AS
SELECT facet, facet_value, error_kind,
       coalesce(recovered_at, session_steps + 1) - step AS calls,
       recovered_at IS NOT NULL AS recovered,
       count(*) AS failures
FROM (SELECT r.*, s.session_steps FROM recoveries r
      JOIN (SELECT DISTINCT facet, facet_value, session_id, session_steps FROM faceted) s USING (facet, facet_value, session_id))
GROUP BY ALL;

-- Runs of the same tool failing call after call: how long they go on, and how they end.
CREATE OR REPLACE TABLE a_failure_runs AS
WITH marked AS (
    SELECT facet, facet_value, session_id, step, tool, failed, next_tool, next_failed,
           CASE WHEN prev_tool IS DISTINCT FROM tool OR NOT coalesce(prev_failed, FALSE) THEN 1 ELSE 0 END AS starts
    FROM faceted
), runs AS (
    SELECT *, sum(starts) OVER (PARTITION BY facet, facet_value, session_id ORDER BY step) AS run FROM marked
), failing AS (
    SELECT facet, facet_value, session_id, run, any_value(tool) AS tool, count(*) AS length,
           arg_max(CASE WHEN next_tool IS NULL THEN 'session ended'
                        WHEN next_tool = tool THEN 'the tool worked'
                        ELSE 'another tool' END, step) AS ending
    FROM runs WHERE failed GROUP BY ALL
)
SELECT facet, facet_value, tool, length, ending, count(*) AS runs, count(DISTINCT session_id) AS sessions
FROM failing GROUP BY ALL;

-- When an answer said more results existed: what came next.
CREATE OR REPLACE TABLE a_more_results AS
SELECT facet, facet_value, tool,
       CASE WHEN next_tool IS NULL THEN 'ended the session'
            WHEN next_tool = tool THEN 'asked the same tool again'
            ELSE 'another tool' END AS next_action,
       count(*) AS calls, count(DISTINCT session_id) AS sessions
FROM faceted WHERE result_more
GROUP BY ALL;

-- From the first compile to the first passing test run in a session.
CREATE OR REPLACE TABLE a_compile_to_green AS
WITH firsts AS (
    SELECT facet, facet_value, session_id, any_value(session_steps) AS session_steps,
           min(step) FILTER (WHERE tool = 'method_compile' AND NOT failed) AS compiled,
           min(step) FILTER (WHERE test_outcome = 'passed') AS green_any
    FROM faceted GROUP BY ALL
), green_after AS (
    SELECT f.*, (SELECT min(step) FROM faceted g
                 WHERE g.facet = f.facet AND g.facet_value = f.facet_value AND g.session_id = f.session_id
                   AND g.test_outcome = 'passed' AND g.step > f.compiled) AS green
    FROM firsts f WHERE compiled IS NOT NULL
)
SELECT facet, facet_value,
       coalesce(green, session_steps + 1) - compiled AS calls,
       green IS NOT NULL AS reached,
       count(*) AS sessions
FROM green_after GROUP BY ALL;

-- How predictable the next call is after each tool: entropy of what follows, in bits.
CREATE OR REPLACE TABLE a_next_entropy AS
WITH pairs AS (
    SELECT facet, facet_value, tool, coalesce(next_tool, '■') AS next, count(*) AS n
    FROM faceted GROUP BY ALL
), totals AS (
    SELECT facet, facet_value, tool, sum(n) AS total, count(*) AS successors FROM pairs GROUP BY ALL
)
SELECT p.facet, p.facet_value, p.tool, t.total AS calls, t.successors,
       -sum((p.n / t.total) * log2(p.n / t.total)) AS entropy_bits
FROM pairs p JOIN totals t USING (facet, facet_value, tool)
GROUP BY p.facet, p.facet_value, p.tool, t.total, t.successors;

-- Where calls break a tool's input schema: which tool, which place, which rule.
CREATE OR REPLACE TABLE a_schema AS
SELECT facet, facet_value, tool, path, keyword, count(*) AS calls, count(DISTINCT session_id) AS sessions
FROM (SELECT facet, facet_value, tool, session_id,
             unnest(CASE WHEN len(schema_paths) > 0 THEN schema_paths ELSE ['(none named)'] END) AS path,
             unnest(CASE WHEN len(schema_keywords) > 0 THEN schema_keywords ELSE ['(none named)'] END) AS keyword
      FROM faceted WHERE error_kind = 'input_schema')
GROUP BY ALL;

-- Argument names agents gave that the tool does not take: words they expect.
CREATE OR REPLACE TABLE a_unknown_arguments AS
SELECT facet, facet_value, tool, name, count(*) AS calls, count(DISTINCT session_id) AS sessions,
       count(*) FILTER (WHERE failed) AS failed
FROM (SELECT *, unnest(unknown_arguments) AS name FROM faceted WHERE len(unknown_arguments) > 0)
GROUP BY ALL;

-- Options in use, per tool.
CREATE OR REPLACE TABLE a_options AS
SELECT facet, facet_value, tool, option, count(*) AS calls, count(DISTINCT session_id) AS sessions,
       count(*) FILTER (WHERE failed) AS failed
FROM (SELECT *, unnest(options) AS option FROM faceted WHERE len(options) > 0)
GROUP BY ALL;

-- Discovery: what a search found, and whether a tool it named was called after.
CREATE OR REPLACE TABLE a_discovery AS
WITH searches AS (
    SELECT f.*,
           EXISTS (SELECT 1 FROM faceted later
                    WHERE later.facet = f.facet AND later.facet_value = f.facet_value
                      AND later.session_id = f.session_id AND later.step > f.step
                      AND later.step <= f.step + 5
                      AND list_contains(f.tool_refs, later.tool)) AS followed
    FROM faceted f
    WHERE f.tool IN ('tool_search', 'tool_get')
)
SELECT facet, facet_value, tool,
       CASE WHEN result_count IS NULL THEN 'not counted'
            WHEN result_count = 0 THEN 'nothing'
            WHEN result_count = 1 THEN '1'
            WHEN result_count < 6 THEN '2-5'
            WHEN result_count < 21 THEN '6-20'
            ELSE '21+' END AS found,
       coalesce(result_more, FALSE) AS more,
       followed,
       count(*) AS calls, count(DISTINCT session_id) AS sessions
FROM searches GROUP BY ALL;

-- evaluate as a fallback: what came just before it.
CREATE OR REPLACE TABLE a_evaluate AS
SELECT facet, facet_value,
       coalesce(prev_tool, '▶') AS before,
       coalesce(prev_failed, FALSE) AS before_failed,
       count(*) AS calls, count(DISTINCT session_id) AS sessions
FROM faceted WHERE tool = 'evaluate'
GROUP BY ALL;

-- Collocations: pairs that follow each other more than their frequencies
-- would make them by chance (lift), candidates for a fused tool or a richer answer.
CREATE OR REPLACE TABLE a_collocations AS
WITH pairs AS (
    SELECT facet, facet_value, prev_tool AS first, tool AS second, count(*) AS n, count(DISTINCT session_id) AS sessions
    FROM faceted WHERE prev_tool IS NOT NULL GROUP BY ALL
), firsts AS (
    SELECT facet, facet_value, first, sum(n) AS n_first FROM pairs GROUP BY ALL
), seconds AS (
    SELECT facet, facet_value, second, sum(n) AS n_second FROM pairs GROUP BY ALL
), totals AS (
    SELECT facet, facet_value, sum(n) AS total FROM pairs GROUP BY ALL
)
SELECT p.facet, p.facet_value, p.first, p.second, p.n AS count, p.sessions,
       p.n / f.n_first AS p_next,
       (p.n * t.total) / (f.n_first * s.n_second) AS lift
FROM pairs p
JOIN firsts f USING (facet, facet_value, first)
JOIN seconds s USING (facet, facet_value, second)
JOIN totals t USING (facet, facet_value);

-- Test runs: outcomes, and red to green within a session.
CREATE OR REPLACE TABLE a_tests AS
WITH runs AS (
    SELECT facet, facet_value, session_id, step, test_outcome,
           lag(test_outcome) OVER (PARTITION BY facet, facet_value, session_id ORDER BY step) AS previous_outcome,
           lag(step) OVER (PARTITION BY facet, facet_value, session_id ORDER BY step) AS previous_step
    FROM faceted WHERE test_outcome IS NOT NULL
)
SELECT facet, facet_value, coalesce(previous_outcome, '▶') AS previous_outcome, test_outcome,
       count(*) AS runs, count(DISTINCT session_id) AS sessions,
       quantile_cont(step - previous_step, 0.5) AS median_calls_between
FROM runs GROUP BY ALL;

-- Time per tool, in powers of two of milliseconds.
CREATE OR REPLACE TABLE a_latency AS
SELECT facet, facet_value, tool,
       CAST(pow(2, floor(log2(greatest(duration_ms, 1)))) AS BIGINT) AS bin_ms,
       count(*) AS calls
FROM faceted WHERE duration_ms IS NOT NULL
GROUP BY ALL;

-- Answer sizes, in powers of two of bytes (a filter may have kept only those).
CREATE OR REPLACE TABLE a_output AS
SELECT facet, facet_value, tool,
       CASE WHEN output_bytes <= 0 THEN 0 ELSE CAST(pow(2, floor(log2(output_bytes))) AS BIGINT) END AS output_bytes,
       count(*) AS calls,
       count(*) FILTER (WHERE budget_exceeded) AS cut
FROM faceted WHERE output_bytes IS NOT NULL
GROUP BY ALL;

-- Sessions: how long, in calls and in minutes.
CREATE OR REPLACE TABLE a_sessions AS
SELECT facet, facet_value,
       session_steps AS calls,
       round((max(order_ms) - min(order_ms)) / 60000.0, 1) AS minutes,
       bool_or(failed) AS any_failed,
       count(DISTINCT tool) AS tools
FROM faceted GROUP BY facet, facet_value, session_id, session_steps;

-- What PLexus did for images, from its own spans.
CREATE OR REPLACE TABLE a_images AS
SELECT name AS operation, CASE WHEN status = 'error' THEN 'error' ELSE 'ok' END AS status, coalesce(error_type, '') AS error_type,
       count(*) AS spans, count(DISTINCT session_id) AS sessions,
       quantile_cont(duration_ms, 0.5) AS p50_ms, quantile_cont(duration_ms, 0.9) AS p90_ms
FROM spans WHERE name LIKE 'plexus.image.%'
GROUP BY ALL;

-- Releases compared per tool: the share of sessions in which the tool failed,
-- as it came and as it would be with every release seeing the same mix of
-- agent hosts (direct standardisation), since hosts fail differently and
-- their mix moves from one release to the next. `covered` is the share of
-- that mix the release saw: below 1, a host is missing from it.
CREATE OR REPLACE TABLE a_releases AS
WITH session_tool AS (
    SELECT session_id, tool, host_label, any_value(mcp_version) AS mcp_version,
           any_value(plexus_version) AS plexus_version, bool_or(failed) AS failed
    FROM steps GROUP BY ALL
), by_release AS (
    SELECT 'MCP' AS component, mcp_version AS release, * EXCLUDE (mcp_version, plexus_version)
    FROM session_tool WHERE mcp_version IS NOT NULL
    UNION ALL
    SELECT 'PLexus', plexus_version, * EXCLUDE (mcp_version, plexus_version)
    FROM session_tool WHERE plexus_version IS NOT NULL
), mix AS (
    SELECT component, tool, host_label,
           count(*)::DOUBLE / sum(count(*)) OVER (PARTITION BY component, tool) AS weight
    FROM by_release GROUP BY component, tool, host_label
), cells AS (
    SELECT component, release, tool, host_label, count(*) AS n, count(*) FILTER (WHERE failed) AS k
    FROM by_release GROUP BY ALL
)
SELECT c.component, c.release, c.tool,
       sum(c.n) AS sessions, sum(c.k) AS sessions_failed,
       sum(c.k)::DOUBLE / sum(c.n) AS rate,
       wilson_low(sum(c.k)::DOUBLE, sum(c.n)::DOUBLE) AS rate_low,
       wilson_high(sum(c.k)::DOUBLE, sum(c.n)::DOUBLE) AS rate_high,
       sum(m.weight * c.k / c.n) / sum(m.weight) AS standardised_rate,
       sum(m.weight) AS covered,
       count(DISTINCT c.host_label) AS hosts
FROM cells c JOIN mix m USING (component, tool, host_label)
GROUP BY c.component, c.release, c.tool;

-- How calls failed, in their own words: the error code, the exception's
-- class, and the JSON-RPC error's message (the one the client was answered
-- with) with its numbers and quoted parts blanked, so that one message is one
-- row whatever it quoted. Absent when a filter dropped them.
CREATE OR REPLACE TABLE a_errors AS
SELECT facet, facet_value, tool,
       coalesce(error_kind, CASE WHEN plexus_error_code IS NOT NULL THEN 'refused by PLexus' END, 'other') AS error_kind,
       coalesce(error_code, plexus_error_code) AS code,
       exception_type,
       left(regexp_replace(regexp_replace(status_message, '''[^'']*''|"[^"]*"|`[^`]*`', '…', 'g'), '[0-9]+', '#', 'g'), 240) AS message,
       count(*) AS calls, count(DISTINCT session_id) AS sessions
FROM faceted
WHERE failed
GROUP BY ALL;
