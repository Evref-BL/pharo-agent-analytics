-- From spans to calls: one row per tool call an agent made, whatever the
-- components it crossed, ordered within its session.
--
-- A call through PLexus is a PLexus server span, the client span PLexus
-- forwarded it with, and the image's server span, all in one trace. A call
-- made to an image directly is the image's server span alone. A call that an
-- image's tool_call dispatched is an image span under another image span: it
-- is a call of its own, marked dispatched.
--
-- An image may repeat its ids from one start to the next, and a filter may
-- replace them by hashes made on each machine, so spans are only ever joined
-- within one trace, one session and one week.
--
-- Order within a session comes from the spans' start times when the exporter
-- kept them; when a filter kept only the week, from the offset in its session
-- the filter recorded (pharo_agent_telemetry.session.offset_ms), then from
-- PLexus's count of the session's calls. `order_ms` is either, in
-- milliseconds, so the time between two calls is a difference of it.

CREATE OR REPLACE VIEW plexus_server AS
SELECT * FROM spans
WHERE scope_name = '@evref-bl/plexus' AND kind = 'server' AND method = 'tools/call';

CREATE OR REPLACE VIEW plexus_client AS
SELECT * FROM spans
WHERE scope_name = '@evref-bl/plexus' AND kind = 'client' AND method = 'tools/call';

CREATE OR REPLACE VIEW image_server AS
SELECT * FROM spans
WHERE scope_name = 'mcp-pharo' AND kind = 'server' AND method = 'tools/call';

-- An image span is dispatched when its parent is another image span of its trace.
CREATE OR REPLACE VIEW image_calls AS
SELECT im.*,
       EXISTS (
           SELECT 1 FROM image_server outer_call
           WHERE outer_call.trace_id = im.trace_id AND outer_call.span_id = im.parent_span_id
             AND outer_call.week = im.week AND outer_call.session_id IS NOT DISTINCT FROM im.session_id
       ) AS dispatched
FROM image_server im;

CREATE OR REPLACE VIEW calls_unordered AS
-- Through PLexus: the image's top span of the same trace, when PLexus forwarded the call.
SELECT
    px.doc_id                                          AS call_id,
    px.session_id,
    px.week,
    px.start_time,
    px.time_precise,
    coalesce(px.offset_ms, im.offset_ms,
             CASE WHEN px.time_precise THEN epoch_ms(px.start_time) END) AS order_ms,
    px.call_index,
    'plexus'                                           AS entry,
    FALSE                                              AS dispatched,
    coalesce(im.tool, px.tool)                         AS tool,
    coalesce(im.tool_origin, CASE WHEN NOT coalesce(px.forwarded, FALSE) THEN 'plexus' END) AS tool_origin,
    CASE WHEN im.doc_id IS NOT NULL THEN im.status ELSE px.status END AS status,
    coalesce(im.status_message, px.status_message)     AS status_message,
    px.status                                          AS plexus_status,
    im.status                                          AS image_status,
    coalesce(im.error_type, px.error_type)             AS error_type,
    im.error_kind,
    im.error_code,
    px.plexus_error_code,
    px.request_id,
    pc.server_address,
    pc.server_port,
    coalesce(px.forwarded, FALSE)                      AS forwarded,
    im.doc_id IS NOT NULL                              AS reached_image,
    px.duration_ms,
    im.duration_ms                                     AS image_duration_ms,
    px.plexus_client                                   AS host,
    px.plexus_client_version                           AS host_version,
    px.service_version                                 AS plexus_version,
    im.service_version                                 AS mcp_version,
    im.runtime_version                                 AS pharo_version,
    px.os_type,
    coalesce(px.environment, im.environment)           AS environment,
    coalesce(px.eval_variant, im.eval_variant)         AS eval_variant,
    im.advertised,
    im.dispatch_path,
    coalesce(im.arguments, px.plexus_arguments)        AS arguments,
    coalesce(im.unknown_arguments, px.plexus_unknown)  AS unknown_arguments,
    im.options,
    im.input_bytes,
    im.output_bytes,
    im.budget_exceeded,
    im.result_count,
    im.result_more,
    im.test_outcome,
    im.test_count,
    im.tool_refs,
    im.schema_violations,
    im.schema_keywords,
    im.schema_paths,
    im.exception_type
FROM plexus_server px
LEFT JOIN plexus_client pc
       ON pc.trace_id = px.trace_id AND pc.parent_span_id = px.span_id
      AND pc.week = px.week AND pc.session_id IS NOT DISTINCT FROM px.session_id
LEFT JOIN image_calls im
       ON im.trace_id = px.trace_id AND NOT im.dispatched
      AND im.week = px.week AND im.session_id IS NOT DISTINCT FROM px.session_id
      AND (pc.span_id IS NULL OR im.parent_span_id = pc.span_id OR im.parent_span_id IS NULL)
-- Ids that repeat could pair one PLexus span with several: keep the image span PLexus's client span is the parent of.
QUALIFY row_number() OVER (PARTITION BY px.doc_id
                           ORDER BY (im.parent_span_id = pc.span_id) DESC NULLS LAST, im.doc_id) = 1

UNION ALL

-- Straight to an image, or dispatched by its tool_call: image spans no PLexus server span of their trace holds.
SELECT
    im.doc_id, im.session_id, im.week, im.start_time, im.time_precise,
    coalesce(im.offset_ms, CASE WHEN im.time_precise THEN epoch_ms(im.start_time) END), NULL,
    CASE WHEN im.dispatched THEN 'dispatch' ELSE 'image' END,
    im.dispatched,
    im.tool, im.tool_origin, im.status, im.status_message, NULL, im.status,
    im.error_type, im.error_kind, im.error_code, NULL, im.request_id, NULL, NULL,
    TRUE, TRUE,
    im.duration_ms, im.duration_ms,
    im.mcp_client, im.mcp_client_version,
    NULL, im.service_version, im.runtime_version, im.os_type,
    im.environment, im.eval_variant,
    im.advertised, im.dispatch_path,
    im.arguments, im.unknown_arguments, im.options,
    im.input_bytes, im.output_bytes, im.budget_exceeded,
    im.result_count, im.result_more, im.test_outcome, im.test_count, im.tool_refs,
    im.schema_violations, im.schema_keywords, im.schema_paths, im.exception_type
FROM image_calls im
WHERE im.dispatched OR NOT EXISTS (
    SELECT 1 FROM plexus_server px
    WHERE px.trace_id = im.trace_id AND px.week = im.week
      AND px.session_id IS NOT DISTINCT FROM im.session_id
);

-- Ordered within the session. A call that names no session is a session of its own.
-- Versions are also given as major.minor, the grain hosts and Pharo are compared at.
CREATE OR REPLACE TABLE calls AS
SELECT *,
       nullif(regexp_extract(host_version, '(\d+\.\d+)', 1), '')  AS host_release,
       nullif(regexp_extract(pharo_version, '(\d+\.\d+)', 1), '') AS pharo_release,
       row_number() OVER session_order                    AS seq,
       count(*) OVER (PARTITION BY session_id)            AS session_calls,
       -- A refused argument (-32602) is not an error on a server span, by the conventions, but it is a failed call.
       (status = 'error' OR error_type IS NOT NULL OR error_kind IS NOT NULL
        OR plexus_error_code IS NOT NULL)                 AS failed
FROM (SELECT * REPLACE (coalesce(session_id, 'call ' || call_id) AS session_id) FROM calls_unordered)
WINDOW session_order AS (PARTITION BY session_id ORDER BY order_ms NULLS LAST, call_index NULLS LAST, call_id);

-- One row per session.
CREATE OR REPLACE TABLE sessions AS
SELECT
    session_id,
    min(week)                                             AS week,
    count(*)                                              AS calls,
    count(*) FILTER (WHERE failed)                        AS failed_calls,
    (max(order_ms) - min(order_ms))                       AS span_ms,
    bool_and(time_precise)                                AS time_precise,
    arg_max(host, host IS NOT NULL)                       AS host,
    arg_max(host_version, host_version IS NOT NULL)       AS host_version,
    arg_max(mcp_version, mcp_version IS NOT NULL)         AS mcp_version,
    arg_max(plexus_version, plexus_version IS NOT NULL)   AS plexus_version,
    arg_max(pharo_version, pharo_version IS NOT NULL)     AS pharo_version,
    arg_max(pharo_release, pharo_release IS NOT NULL)     AS pharo_release,
    arg_max(host_release, host_release IS NOT NULL)       AS host_release,
    arg_max(os_type, os_type IS NOT NULL)                 AS os_type,
    arg_max(environment, environment IS NOT NULL)         AS environment,
    bool_or(entry = 'plexus')                             AS through_plexus
FROM calls
GROUP BY session_id;
