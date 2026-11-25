-- One row per span, its attributes in typed columns. Every source is loaded
-- through documents (see documents.py), so this is the only place that knows
-- the attributes' names. `attributes` keeps them all, as they came, for any
-- attribute a later release adds before it gets a column.

CREATE TABLE IF NOT EXISTS spans (
    doc_id                VARCHAR PRIMARY KEY,
    week                  TIMESTAMP,     -- the week the span started in (its Monday)
    duration_ms           DOUBLE,
    trace_id              VARCHAR,
    span_id               VARCHAR,
    parent_span_id        VARCHAR,
    name                  VARCHAR,
    kind                  VARCHAR,
    status                VARCHAR,
    scope_name            VARCHAR,
    scope_version         VARCHAR,
    -- resource
    service_name          VARCHAR,
    service_version       VARCHAR,
    os_type               VARCHAR,
    runtime_name          VARCHAR,
    runtime_version       VARCHAR,
    environment           VARCHAR,
    eval_variant          VARCHAR,
    filter_version        VARCHAR,
    -- both components
    session_id            VARCHAR,
    offset_ms             BIGINT,        -- after the first span of its session the participant's agent saw
    method                VARCHAR,
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
    attributes            JSON
);
