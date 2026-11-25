"""Spans as documents: the shape pharo-agent-telemetry-import indexes.

Every source ends up as one JSON document per span, with the fields the
import gives it in Elasticsearch (`@timestamp`, `duration_ms`, `trace_id`,
`span_id`, `parent_span_id`, `name`, `kind`, `status`, `scope`, `resource`,
`attributes`) and an `_id`. A collector's archive holds OTLP JSON export
requests instead; `otlp_documents` turns one into documents the same way the
import does.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime
from typing import Any

KINDS = ["unspecified", "internal", "server", "client", "producer", "consumer"]
STATUSES = ["unset", "ok", "error"]

#: The resource attribute a collector names its daily file by, not a fact about the span.
ARCHIVE_ATTRIBUTE = "fileexporter.path_segment"
#: The span attribute that says how long the span took, kept since its times are not.
DURATION_ATTRIBUTE = "span.duration_ms"


def plain_value(value: Any) -> Any:
    """An OTLP JSON AnyValue as a plain value."""
    if not isinstance(value, dict):
        return None
    if "stringValue" in value:
        return value["stringValue"]
    if "boolValue" in value:
        return value["boolValue"]
    if "intValue" in value:
        return int(value["intValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "arrayValue" in value:
        return [plain_value(each) for each in value["arrayValue"].get("values", [])]
    return None


def plain_attributes(pairs: Iterable[dict] | None, skip: tuple[str, ...] = ()) -> dict[str, Any]:
    attributes = {}
    for pair in pairs or []:
        value = plain_value(pair.get("value"))
        if value is not None and pair.get("key") not in skip:
            attributes[pair["key"]] = value
    return attributes


def iso_time(nanos: str | int) -> str:
    """Nanoseconds since the epoch as an ISO date with microseconds."""
    nanos = int(nanos)
    seconds, rest = divmod(nanos, 1_000_000_000)
    return datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{rest // 1000:06d}Z"


def document_id(document: dict[str, Any]) -> str:
    """Its trace and span ids, then a digest of all it holds, whatever the order of its keys."""
    digest = hashlib.sha256(
        json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()[:16]
    return f"{document['trace_id']}-{document['span_id']}-{digest}"


def otlp_documents(request: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """The documents of one OTLP JSON ExportTraceServiceRequest."""
    for resource_spans in request.get("resourceSpans", []):
        resource = plain_attributes((resource_spans.get("resource") or {}).get("attributes"), (ARCHIVE_ATTRIBUTE,))
        for scope_spans in resource_spans.get("scopeSpans", []):
            scope = scope_spans.get("scope") or {}
            for span in scope_spans.get("spans", []):
                if not (span.get("traceId") and span.get("spanId") and span.get("startTimeUnixNano")):
                    continue
                attributes = plain_attributes(span.get("attributes"), (DURATION_ATTRIBUTE,))
                duration = next(
                    (plain_value(pair.get("value")) for pair in span.get("attributes", []) if pair.get("key") == DURATION_ATTRIBUTE),
                    None,
                )
                document = {
                    "@timestamp": iso_time(span["startTimeUnixNano"]),
                    **({"duration_ms": duration} if isinstance(duration, (int, float)) else {}),
                    "trace_id": span["traceId"],
                    "span_id": span["spanId"],
                    **({"parent_span_id": span["parentSpanId"]} if span.get("parentSpanId") else {}),
                    "name": span.get("name"),
                    "kind": KINDS[span.get("kind", 0)] if 0 <= span.get("kind", 0) < len(KINDS) else "unspecified",
                    "status": STATUSES[(span.get("status") or {}).get("code", 0)]
                    if 0 <= (span.get("status") or {}).get("code", 0) < len(STATUSES)
                    else "unset",
                    "scope": {"name": scope.get("name"), "version": scope.get("version")},
                    "resource": resource,
                    "attributes": attributes,
                }
                yield {"_id": document_id(document), **document}


def archive_documents(lines: Iterable[str]) -> tuple[list[dict[str, Any]], int]:
    """The documents of an archive's lines, and how many lines were not a request."""
    documents, malformed = [], 0
    for line in lines:
        if not line.strip():
            continue
        try:
            documents.extend(otlp_documents(json.loads(line)))
        except (ValueError, TypeError, KeyError, AttributeError):
            malformed += 1
    return documents, malformed


def hit_document(hit: dict[str, Any]) -> dict[str, Any]:
    """An Elasticsearch hit as a document, its `_id` kept."""
    return {"_id": hit["_id"], **hit["_source"]}
