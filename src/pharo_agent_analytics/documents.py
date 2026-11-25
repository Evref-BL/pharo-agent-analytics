"""Spans as documents, whatever exported them.

Every source ends up as one JSON document per span: `@timestamp` (its start),
`duration_ms`, `trace_id`, `span_id`, `parent_span_id`, `name`, `kind`,
`status`, `status_message`, `scope`, `resource`, `attributes`, `events`, and
an `_id`: one span per document, OTLP's field names at the top level, as an
import of a collector's files may index them.

- OTLP JSON, as a collector's file exporter writes it or an OTLP/HTTP request
  carries it: `otlp_documents`.
- Elasticsearch documents of that shape, or of the OpenTelemetry Collector's
  Elasticsearch exporter in its default `otel` mapping: `hit_document`.
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


def requests_in(value: Any) -> Iterator[dict[str, Any]]:
    """The OTLP export requests a JSON value holds: itself, or one a trace store wrapped."""
    if isinstance(value, dict):
        if "resourceSpans" in value:
            yield value
        elif "batches" in value:
            yield {"resourceSpans": value["batches"]}
        else:
            for key in ("result", "trace", "data"):
                if isinstance(value.get(key), (dict, list)):
                    yield from requests_in(value[key])
    elif isinstance(value, list):
        for each in value:
            yield from requests_in(each)


def kind_name(kind: Any) -> str:
    """A span kind, as OTLP's number or any exporter's name (`Server`, `SPAN_KIND_SERVER`)."""
    if isinstance(kind, int) or (isinstance(kind, str) and kind.isdigit()):
        number = int(kind)
        return KINDS[number] if 0 <= number < len(KINDS) else "unspecified"
    name = str(kind or "").lower().removeprefix("span_kind_")
    return name if name in KINDS else "unspecified"


def status_name(code: Any) -> str:
    if isinstance(code, int) or (isinstance(code, str) and code.isdigit()):
        number = int(code)
        return STATUSES[number] if 0 <= number < len(STATUSES) else "unset"
    name = str(code or "").lower().removeprefix("status_code_")
    return name if name in STATUSES else "unset"


def otlp_documents(request: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """The documents of one OTLP JSON ExportTraceServiceRequest."""
    for resource_spans in request.get("resourceSpans", []):
        resource = plain_attributes((resource_spans.get("resource") or {}).get("attributes"), (ARCHIVE_ATTRIBUTE,))
        for scope_spans in resource_spans.get("scopeSpans", resource_spans.get("instrumentationLibrarySpans", [])):
            scope = scope_spans.get("scope") or scope_spans.get("instrumentationLibrary") or {}
            for span in scope_spans.get("spans", []):
                if not (span.get("traceId") and span.get("spanId") and span.get("startTimeUnixNano")):
                    continue
                attributes = plain_attributes(span.get("attributes"), (DURATION_ATTRIBUTE,))
                duration = next(
                    (plain_value(pair.get("value")) for pair in span.get("attributes", []) if pair.get("key") == DURATION_ATTRIBUTE),
                    None,
                )
                if not isinstance(duration, (int, float)) and span.get("endTimeUnixNano"):
                    duration = (int(span["endTimeUnixNano"]) - int(span["startTimeUnixNano"])) / 1e6
                status = span.get("status") or {}
                events = [
                    {"name": event.get("name"), "attributes": plain_attributes(event.get("attributes"))}
                    for event in span.get("events", [])
                ]
                document = {
                    "@timestamp": iso_time(span["startTimeUnixNano"]),
                    **({"duration_ms": duration} if isinstance(duration, (int, float)) else {}),
                    "trace_id": span["traceId"],
                    "span_id": span["spanId"],
                    **({"parent_span_id": span["parentSpanId"]} if span.get("parentSpanId") else {}),
                    "name": span.get("name"),
                    "kind": kind_name(span.get("kind", 0)),
                    "status": status_name(status.get("code", 0)),
                    **({"status_message": status["message"]} if status.get("message") else {}),
                    "scope": {"name": scope.get("name"), "version": scope.get("version")},
                    "resource": resource,
                    "attributes": attributes,
                    **({"events": events} if events else {}),
                }
                yield {"_id": document_id(document), **document}


def json_documents(value: Any) -> Iterator[dict[str, Any]]:
    for request in requests_in(value):
        yield from otlp_documents(request)


def archive_documents(lines: Iterable[str]) -> tuple[list[dict[str, Any]], int]:
    """The documents of OTLP JSON lines, and how many lines were not a request."""
    documents, malformed = [], 0
    for line in lines:
        if not line.strip():
            continue
        try:
            documents.extend(json_documents(json.loads(line)))
        except (ValueError, TypeError, KeyError, AttributeError):
            malformed += 1
    return documents, malformed


def hit_document(hit: dict[str, Any]) -> dict[str, Any]:
    """An Elasticsearch hit as a document, its `_id` kept: the import's shape, or the Collector exporter's `otel` mapping."""
    source = hit["_source"]
    resource = source.get("resource")
    if isinstance(resource, dict) and isinstance(resource.get("attributes"), dict):
        status = source.get("status") or {}
        duration = source.get("duration")
        scope = source.get("scope") or {}
        source = {
            "@timestamp": source.get("@timestamp"),
            **({"duration_ms": duration / 1e6} if isinstance(duration, (int, float)) else {}),
            "trace_id": source.get("trace_id"),
            "span_id": source.get("span_id"),
            **({"parent_span_id": source["parent_span_id"]} if source.get("parent_span_id") else {}),
            "name": source.get("name"),
            "kind": kind_name(source.get("kind")),
            "status": status_name(status.get("code") if isinstance(status, dict) else status),
            **({"status_message": status["message"]} if isinstance(status, dict) and status.get("message") else {}),
            "scope": {"name": scope.get("name"), "version": scope.get("version")},
            "resource": resource["attributes"],
            "attributes": source.get("attributes") or {},
        }
    return {"_id": hit["_id"], **source}
