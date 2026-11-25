-- The calls as an object-centric event log (OCEL 2.0).
--
-- An event is a call; its type is the tool called, its time the call's start.
-- When a filter kept only the week of a span and its offset in its session,
-- the time is the week's Monday plus that offset: true within a session,
-- meaningless across sessions. So every object whose life is worth mining
-- lives inside one session: the session itself, each tool as used in it ("tool use"), each
-- place in a tool's input it broke ("input path"). The objects shared across
-- sessions (the tool, the agent host, a release) carry attributes and
-- relations only, never a sequence.

CREATE OR REPLACE TABLE ocel_events AS
SELECT
    call_id                                                    AS id,
    tool                                                       AS type,
    CASE WHEN time_precise THEN start_time
         ELSE week + to_milliseconds(coalesce(order_ms - min(order_ms) OVER (PARTITION BY session_id), seq)) END AS time,
    status, error_kind, error_type, plexus_error_code, entry, dispatched,
    duration_ms, output_bytes, budget_exceeded, result_count, result_more,
    test_outcome, test_count, seq
FROM calls
WHERE tool IS NOT NULL;

CREATE OR REPLACE TABLE ocel_relations AS
-- the session a call is in
SELECT call_id AS event_id, 'session:' || session_id AS object_id, 'in' AS qualifier FROM calls WHERE tool IS NOT NULL
UNION ALL
-- the tool it calls, as used in this session
SELECT call_id, 'tool use:' || session_id || '/' || tool, 'calls' FROM calls WHERE tool IS NOT NULL
UNION ALL
-- the tools a discovery call names
SELECT call_id, 'tool use:' || session_id || '/' || ref, 'names'
FROM (SELECT call_id, session_id, unnest(tool_refs) AS ref FROM calls WHERE tool IS NOT NULL)
WHERE ref <> '_OTHER'
UNION ALL
-- the places of its input it broke
SELECT call_id, 'input path:' || session_id || '/' || tool || path, 'breaks'
FROM (SELECT call_id, session_id, tool, unnest(schema_paths) AS path FROM calls WHERE tool IS NOT NULL);

CREATE OR REPLACE TABLE ocel_objects AS
SELECT DISTINCT
    object_id AS id,
    split_part(object_id, ':', 1) AS type
FROM ocel_relations
UNION ALL
SELECT DISTINCT 'tool:' || tool, 'tool' FROM calls WHERE tool IS NOT NULL
UNION ALL
SELECT DISTINCT 'host:' || host || coalesce(' ' || host_release, ''), 'agent host' FROM sessions WHERE host IS NOT NULL
UNION ALL
SELECT DISTINCT 'release:MCP ' || mcp_version, 'release' FROM sessions WHERE mcp_version IS NOT NULL
UNION ALL
SELECT DISTINCT 'release:PLexus ' || plexus_version, 'release' FROM sessions WHERE plexus_version IS NOT NULL
UNION ALL
SELECT DISTINCT 'release:Pharo ' || pharo_release, 'release' FROM sessions WHERE pharo_release IS NOT NULL;

CREATE OR REPLACE TABLE ocel_object_relations AS
SELECT DISTINCT 'tool use:' || session_id || '/' || tool AS source_id, 'tool:' || tool AS target_id, 'of' AS qualifier
FROM calls WHERE tool IS NOT NULL
UNION
SELECT DISTINCT 'tool use:' || c.session_id || '/' || ref, 'tool:' || ref, 'of'
FROM (SELECT session_id, unnest(tool_refs) AS ref FROM calls) c
WHERE ref <> '_OTHER'
UNION
SELECT DISTINCT 'session:' || session_id || '' , 'tool use:' || session_id || '/' || tool, 'uses'
FROM calls WHERE tool IS NOT NULL
UNION
SELECT DISTINCT 'input path:' || session_id || '/' || tool || path, 'tool use:' || session_id || '/' || tool, 'of'
FROM (SELECT session_id, tool, unnest(schema_paths) AS path FROM calls WHERE tool IS NOT NULL)
UNION
SELECT 'session:' || session_id, 'host:' || host || coalesce(' ' || host_release, ''), 'runs on'
FROM sessions WHERE host IS NOT NULL
UNION
SELECT 'session:' || session_id, 'release:MCP ' || mcp_version, 'served by' FROM sessions WHERE mcp_version IS NOT NULL
UNION
SELECT 'session:' || session_id, 'release:PLexus ' || plexus_version, 'served by' FROM sessions WHERE plexus_version IS NOT NULL
UNION
SELECT 'session:' || session_id, 'release:Pharo ' || pharo_release, 'runs in' FROM sessions WHERE pharo_release IS NOT NULL;

-- Object attributes, each at the start of time since none changes.
CREATE OR REPLACE TABLE ocel_object_attributes AS
SELECT 'session:' || session_id AS id, 'host' AS name, host AS value FROM sessions WHERE host IS NOT NULL
UNION ALL SELECT 'session:' || session_id, 'os', os_type FROM sessions WHERE os_type IS NOT NULL
UNION ALL SELECT 'session:' || session_id, 'environment', environment FROM sessions WHERE environment IS NOT NULL
UNION ALL SELECT 'session:' || session_id, 'calls', CAST(calls AS VARCHAR) FROM sessions
UNION ALL
SELECT DISTINCT 'tool:' || tool, 'origin', tool_origin FROM calls WHERE tool IS NOT NULL AND tool_origin IS NOT NULL
UNION ALL
SELECT DISTINCT 'release:MCP ' || mcp_version, 'component', 'MCP' FROM sessions WHERE mcp_version IS NOT NULL
UNION ALL
SELECT DISTINCT 'release:PLexus ' || plexus_version, 'component', 'PLexus' FROM sessions WHERE plexus_version IS NOT NULL;
