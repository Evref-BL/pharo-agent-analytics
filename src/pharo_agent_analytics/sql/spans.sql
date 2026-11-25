-- One row per span, its attributes in typed columns. Every source is loaded
-- through documents (see documents.py), so this is the only place that knows
-- the attributes' names. `attributes` keeps them all, as they came, for any
-- attribute a later release adds before it gets a column.

CREATE TABLE IF NOT EXISTS spans (
    doc_id                VARCHAR PRIMARY KEY,
    start_time            TIMESTAMP,     -- when it started, as precise as its exporter kept it
    week                  TIMESTAMP,     -- the week it started in (its Monday)
    time_precise          BOOLEAN,       -- false when a filter kept only the week (the time is then the week's Monday)
    duration_ms           DOUBLE,
    trace_id              VARCHAR,
    span_id               VARCHAR,
    parent_span_id        VARCHAR,
    name                  VARCHAR,
    kind                  VARCHAR,
    status                VARCHAR,
    status_message        VARCHAR,       -- for a JSON-RPC error, its message
    scope_name            VARCHAR,
    scope_version         VARCHAR,
    -- resource
    service_name          VARCHAR,
    service_version       VARCHAR,
    os_type               VARCHAR,
    runtime_name          VARCHAR,
    runtime_version       VARCHAR,
    runtime_description   VARCHAR,
    environment           VARCHAR,
    eval_variant          VARCHAR,
    filter_version        VARCHAR,
    -- both components
    session_id            VARCHAR,
    offset_ms             BIGINT,        -- a filter's: after the first span of its session it saw
    method                VARCHAR,
    request_id            VARCHAR,
    tool                  VARCHAR,
    error_type            VARCHAR,
    -- PLexus
    plexus_client         VARCHAR,
    plexus_client_version VARCHAR,
    call_index            BIGINT,
    forwarded             BOOLEAN,
    plexus_arguments      VARCHAR[],
    plexus_unknown        VARCHAR[],
    plexus_error_code     VARCHAR,
    image_save            BOOLEAN,
    server_address        VARCHAR,       -- the image PLexus forwarded to
    server_port           BIGINT,
    -- MCP, in the image
    protocol_version      VARCHAR,
    tool_origin           VARCHAR,
    dispatch_path         VARCHAR,
    advertised            BOOLEAN,
    mcp_client            VARCHAR,
    mcp_client_version    VARCHAR,
    arguments             VARCHAR[],
    unknown_arguments     VARCHAR[],
    options               VARCHAR[],
    input_bytes           BIGINT,
    output_bytes          BIGINT,
    budget_exceeded       BOOLEAN,
    result_count          BIGINT,
    result_more           BOOLEAN,
    test_outcome          VARCHAR,
    test_count            BIGINT,
    tool_refs             VARCHAR[],
    error_kind            VARCHAR,
    error_code            VARCHAR,
    schema_violations     BIGINT,
    schema_keywords       VARCHAR[],
    schema_paths          VARCHAR[],
    exception_type        VARCHAR,
    attributes            JSON,          -- every attribute as it came, content included when captured
    events                JSON
);
