-- Load documents (one JSON object per line) from $path into spans; a
-- document already there, by its id, is left as it is.

CREATE OR REPLACE MACRO attr(doc, key) AS (doc -> 'attributes') ->> ('$."' || key || '"');
CREATE OR REPLACE MACRO res(doc, key) AS (doc -> 'resource') ->> ('$."' || key || '"');
-- A list attribute, also when a single value came as a string.
CREATE OR REPLACE MACRO attr_list(doc, key) AS
    CASE json_type((doc -> 'attributes') -> ('$."' || key || '"'))
        WHEN 'ARRAY' THEN from_json((doc -> 'attributes') -> ('$."' || key || '"'), '["VARCHAR"]')
        WHEN 'VARCHAR' THEN [attr(doc, key)]
    END;

INSERT OR IGNORE INTO spans
SELECT
    doc ->> '_id',
    CAST(doc ->> '$."@timestamp"' AS TIMESTAMP),
    date_trunc('week', CAST(doc ->> '$."@timestamp"' AS TIMESTAMP)),
    -- A filter that keeps only the week says so, or leaves every span on a Monday at midnight.
    res(doc, 'pharo_agent_telemetry.filter.version') IS NULL
        AND CAST(doc ->> '$."@timestamp"' AS TIMESTAMP) <> date_trunc('week', CAST(doc ->> '$."@timestamp"' AS TIMESTAMP)),
    CAST(doc ->> 'duration_ms' AS DOUBLE),
    doc ->> 'trace_id',
    doc ->> 'span_id',
    doc ->> 'parent_span_id',
    doc ->> 'name',
    doc ->> 'kind',
    doc ->> 'status',
    doc ->> 'status_message',
    doc -> 'scope' ->> 'name',
    doc -> 'scope' ->> 'version',
    res(doc, 'service.name'),
    res(doc, 'service.version'),
    res(doc, 'os.type'),
    res(doc, 'process.runtime.name'),
    res(doc, 'process.runtime.version'),
    res(doc, 'process.runtime.description'),
    res(doc, 'deployment.environment.name'),
    res(doc, 'pharo_agent_evals.variant'),
    res(doc, 'pharo_agent_telemetry.filter.version'),
    attr(doc, 'session.id'),
    TRY_CAST(attr(doc, 'pharo_agent_telemetry.session.offset_ms') AS BIGINT),
    -- The span's name starts with the method too ("tools/call class_get"), when the attribute is absent.
    coalesce(attr(doc, 'mcp.method.name'),
             CASE WHEN (doc ->> 'name') LIKE '%/%' THEN split_part(doc ->> 'name', ' ', 1) END),
    attr(doc, 'jsonrpc.request.id'),
    attr(doc, 'gen_ai.tool.name'),
    attr(doc, 'error.type'),
    attr(doc, 'plexus.client.name'),
    attr(doc, 'plexus.client.version'),
    TRY_CAST(attr(doc, 'plexus.call.index') AS BIGINT),
    TRY_CAST(attr(doc, 'plexus.call.forwarded') AS BOOLEAN),
    attr_list(doc, 'plexus.argument.names'),
    attr_list(doc, 'plexus.argument.unknown_names'),
    attr(doc, 'plexus.error.code'),
    TRY_CAST(attr(doc, 'plexus.image.save') AS BOOLEAN),
    attr(doc, 'server.address'),
    TRY_CAST(attr(doc, 'server.port') AS BIGINT),
    attr(doc, 'mcp.protocol.version'),
    attr(doc, 'pharo.mcp.tool.origin'),
    attr(doc, 'pharo.mcp.dispatch_path'),
    TRY_CAST(attr(doc, 'pharo.mcp.tool.advertised') AS BOOLEAN),
    attr(doc, 'pharo.mcp.client.name'),
    attr(doc, 'pharo.mcp.client.version'),
    attr_list(doc, 'pharo.mcp.argument.names'),
    attr_list(doc, 'pharo.mcp.argument.unknown_names'),
    attr_list(doc, 'pharo.mcp.argument.options'),
    TRY_CAST(attr(doc, 'pharo.mcp.input.bytes') AS BIGINT),
    TRY_CAST(attr(doc, 'pharo.mcp.output.bytes') AS BIGINT),
    TRY_CAST(attr(doc, 'pharo.mcp.output_budget.exceeded') AS BOOLEAN),
    TRY_CAST(attr(doc, 'pharo.mcp.result.count') AS BIGINT),
    TRY_CAST(attr(doc, 'pharo.mcp.result.more') AS BOOLEAN),
    attr(doc, 'pharo.mcp.test.outcome'),
    TRY_CAST(attr(doc, 'pharo.mcp.test.count') AS BIGINT),
    attr_list(doc, 'pharo.mcp.tool.refs'),
    attr(doc, 'pharo.mcp.error.kind'),
    attr(doc, 'pharo.mcp.error.code'),
    TRY_CAST(attr(doc, 'pharo.mcp.error.schema.violation_count') AS BIGINT),
    attr_list(doc, 'pharo.mcp.error.schema.keywords'),
    attr_list(doc, 'pharo.mcp.error.schema.paths'),
    attr(doc, 'pharo.mcp.exception.type'),
    doc -> 'attributes',
    doc -> 'events',
    doc -> 'resource',
    attr(doc, 'gen_ai.tool.call.arguments'),
    attr(doc, 'gen_ai.tool.call.result'),
    attr(doc, 'gen_ai.operation.name'),
    coalesce(attr(doc, 'gen_ai.response.model'), attr(doc, 'gen_ai.request.model')),
    coalesce(attr(doc, 'gen_ai.provider.name'), attr(doc, 'gen_ai.system')),
    attr(doc, 'gen_ai.agent.name'),
    TRY_CAST(attr(doc, 'gen_ai.usage.input_tokens') AS BIGINT),
    TRY_CAST(attr(doc, 'gen_ai.usage.output_tokens') AS BIGINT),
    attr(doc, 'gen_ai.conversation.id')
FROM (SELECT json AS doc FROM read_ndjson_objects($path));
