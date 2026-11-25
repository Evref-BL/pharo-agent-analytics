"""Writing the calls as OCEL 2.0, in its SQLite and JSON forms.

The tables are built in DuckDB (sql/ocel.sql); this only lays them out the
way the standard does, so pm4py, Celonis, ocpa and the OCEL tools read them.
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

import duckdb

from .store import sql

EPOCH = "1970-01-01 00:00:00"

#: Event attributes and their OCEL types; every event type carries them all.
EVENT_ATTRIBUTES = {
    "status": "string",
    "error_kind": "string",
    "error_type": "string",
    "plexus_error_code": "string",
    "entry": "string",
    "dispatched": "boolean",
    "duration_ms": "float",
    "output_bytes": "integer",
    "budget_exceeded": "boolean",
    "result_count": "integer",
    "result_more": "boolean",
    "test_outcome": "string",
    "test_count": "integer",
    "seq": "integer",
    "host_duration_ms": "float",
    "agent_ms": "float",
}
SQLITE_TYPES = {"string": "TEXT", "boolean": "INTEGER", "integer": "INTEGER", "float": "REAL", "time": "TEXT"}


def build(connection: duckdb.DuckDBPyConnection) -> None:
    connection.execute(sql("ocel"))


def type_maps(types: list[str]) -> dict[str, str]:
    """Each type's table suffix: its letters and digits, made unique."""
    maps, used = {}, set()
    for name in types:
        base = "".join(part.capitalize() for part in re.split(r"[^A-Za-z0-9]+", name) if part) or "Type"
        candidate, n = base, 1
        while candidate.lower() in used:
            n += 1
            candidate = f"{base}{n}"
        used.add(candidate.lower())
        maps[name] = candidate
    return maps


def write_sqlite(connection: duckdb.DuckDBPyConnection, path: Path) -> None:
    path.unlink(missing_ok=True)
    out = sqlite3.connect(path)
    try:
        out.executescript(
            """
            CREATE TABLE event (ocel_id TEXT PRIMARY KEY, ocel_type TEXT);
            CREATE TABLE object (ocel_id TEXT PRIMARY KEY, ocel_type TEXT);
            CREATE TABLE event_object (ocel_event_id TEXT, ocel_object_id TEXT, ocel_qualifier TEXT,
                PRIMARY KEY (ocel_event_id, ocel_object_id, ocel_qualifier));
            CREATE TABLE object_object (ocel_source_id TEXT, ocel_target_id TEXT, ocel_qualifier TEXT,
                PRIMARY KEY (ocel_source_id, ocel_target_id, ocel_qualifier));
            CREATE TABLE event_map_type (ocel_type TEXT PRIMARY KEY, ocel_type_map TEXT);
            CREATE TABLE object_map_type (ocel_type TEXT PRIMARY KEY, ocel_type_map TEXT);
            """
        )
        event_types = [row[0] for row in connection.execute("SELECT DISTINCT type FROM ocel_events ORDER BY 1").fetchall()]
        event_maps = type_maps(event_types)
        columns = ", ".join(f'"{name}" {SQLITE_TYPES[kind]}' for name, kind in EVENT_ATTRIBUTES.items())
        for name, suffix in event_maps.items():
            out.execute("INSERT INTO event_map_type VALUES (?, ?)", (name, suffix))
            out.execute(f'CREATE TABLE "event_{suffix}" (ocel_id TEXT PRIMARY KEY, ocel_time TEXT, {columns})')
        rows = connection.execute(
            f"SELECT id, type, strftime(time, '%Y-%m-%d %H:%M:%S.%f'), {', '.join(EVENT_ATTRIBUTES)} FROM ocel_events"
        ).fetchall()
        out.executemany("INSERT INTO event VALUES (?, ?)", [(row[0], row[1]) for row in rows])
        placeholders = ", ".join("?" for _ in range(len(EVENT_ATTRIBUTES) + 2))
        for name, suffix in event_maps.items():
            out.executemany(
                f'INSERT INTO "event_{suffix}" VALUES ({placeholders})',
                [(row[0], row[2], *row[3:]) for row in rows if row[1] == name],
            )

        object_types = [row[0] for row in connection.execute("SELECT DISTINCT type FROM ocel_objects ORDER BY 1").fetchall()]
        object_maps = type_maps(object_types)
        attributes_of = {
            kind: [row[0] for row in connection.execute(
                "SELECT DISTINCT a.name FROM ocel_object_attributes a JOIN ocel_objects o USING (id) WHERE o.type = ? ORDER BY 1",
                [kind],
            ).fetchall()]
            for kind in object_types
        }
        for name, suffix in object_maps.items():
            out.execute("INSERT INTO object_map_type VALUES (?, ?)", (name, suffix))
            extra = "".join(f', "{attribute}" TEXT' for attribute in attributes_of[name])
            out.execute(f'CREATE TABLE "object_{suffix}" (ocel_id TEXT, ocel_time TEXT, ocel_changed_field TEXT{extra})')
        objects = connection.execute("SELECT id, type FROM ocel_objects").fetchall()
        out.executemany("INSERT OR IGNORE INTO object VALUES (?, ?)", objects)
        values: dict[str, dict[str, str]] = {}
        for object_id, name, value in connection.execute("SELECT id, name, value FROM ocel_object_attributes").fetchall():
            values.setdefault(object_id, {})[name] = value
        for object_id, kind in objects:
            names = attributes_of[kind]
            out.execute(
                f'INSERT INTO "object_{object_maps[kind]}" VALUES (?, ?, NULL{", ?" * len(names)})',
                (object_id, EPOCH, *(values.get(object_id, {}).get(n) for n in names)),
            )
        out.executemany(
            "INSERT OR IGNORE INTO event_object VALUES (?, ?, ?)",
            connection.execute("SELECT event_id, object_id, qualifier FROM ocel_relations").fetchall(),
        )
        out.executemany(
            "INSERT OR IGNORE INTO object_object VALUES (?, ?, ?)",
            connection.execute("SELECT source_id, target_id, qualifier FROM ocel_object_relations").fetchall(),
        )
        out.commit()
    finally:
        out.close()


def write_json(connection: duckdb.DuckDBPyConnection, path: Path) -> None:
    event_types = [row[0] for row in connection.execute("SELECT DISTINCT type FROM ocel_events ORDER BY 1").fetchall()]
    object_types = [row[0] for row in connection.execute("SELECT DISTINCT type FROM ocel_objects ORDER BY 1").fetchall()]
    attribute_names = dict(
        connection.execute(
            "SELECT o.type, list(DISTINCT a.name ORDER BY a.name) FROM ocel_object_attributes a JOIN ocel_objects o USING (id) GROUP BY 1"
        ).fetchall()
    )
    relations: dict[str, list] = {}
    for event_id, object_id, qualifier in connection.execute("SELECT * FROM ocel_relations").fetchall():
        relations.setdefault(event_id, []).append({"objectId": object_id, "qualifier": qualifier})
    object_relations: dict[str, list] = {}
    for source, target, qualifier in connection.execute("SELECT * FROM ocel_object_relations").fetchall():
        object_relations.setdefault(source, []).append({"objectId": target, "qualifier": qualifier})
    object_values: dict[str, list] = {}
    for object_id, name, value in connection.execute("SELECT id, name, value FROM ocel_object_attributes").fetchall():
        object_values.setdefault(object_id, []).append({"name": name, "time": "1970-01-01T00:00:00Z", "value": value})

    events = []
    for row in connection.execute(
        f"SELECT id, type, strftime(time, '%Y-%m-%dT%H:%M:%S.%fZ'), {', '.join(EVENT_ATTRIBUTES)} FROM ocel_events ORDER BY time, id"
    ).fetchall():
        attributes = [
            {"name": name, "value": value}
            for name, value in zip(EVENT_ATTRIBUTES, row[3:], strict=True)
            if value is not None
        ]
        events.append({"id": row[0], "type": row[1], "time": row[2], "attributes": attributes,
                       "relationships": relations.get(row[0], [])})
    log = {
        "objectTypes": [
            {"name": kind, "attributes": [{"name": n, "type": "string"} for n in attribute_names.get(kind, [])]}
            for kind in object_types
        ],
        "eventTypes": [
            {"name": kind, "attributes": [{"name": n, "type": t} for n, t in EVENT_ATTRIBUTES.items()]}
            for kind in event_types
        ],
        "objects": [
            {"id": object_id, "type": kind, "attributes": object_values.get(object_id, []),
             "relationships": object_relations.get(object_id, [])}
            for object_id, kind in connection.execute("SELECT DISTINCT id, type FROM ocel_objects ORDER BY 2, 1").fetchall()
        ],
        "events": events,
    }
    path.write_text(json.dumps(log, ensure_ascii=False))
