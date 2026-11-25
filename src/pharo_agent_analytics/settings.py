"""Where Elasticsearch is, the key that reads it, and the indices that hold the spans.

The environment wins, so a scheduled job sets its variables; on a machine, a
settings file holds them, out of the repository:
`$XDG_CONFIG_HOME/pharo-agent-analytics/elasticsearch.env` (`~/.config/...`
by default), lines of `NAME=value`.
"""

from __future__ import annotations

import base64
import binascii
import os
from pathlib import Path

NAMES = ("ELASTICSEARCH_URL", "ELASTICSEARCH_API_KEY", "ELASTICSEARCH_CA_FILE", "ELASTICSEARCH_INDEX")

#: The OpenTelemetry Collector's Elasticsearch exporter writes spans to these data streams.
DEFAULT_INDEX = "traces-*.otel-*"


def settings_file() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "pharo-agent-analytics" / "elasticsearch.env"


def read_file(path: Path) -> dict[str, str]:
    values = {}
    if path.is_file():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                name, value = line.split("=", 1)
                values[name.strip()] = value.strip().strip('"').strip("'")
    return values


def elasticsearch(path: Path | None = None) -> dict[str, str]:
    values = read_file(path or settings_file())
    for name in NAMES:
        if os.environ.get(name):
            values[name] = os.environ[name]
    return values


def key_problem(key: str) -> str | None:
    """Why a key cannot be what Elasticsearch takes, if it cannot: the `encoded` field, base64 of id:key."""
    try:
        decoded = base64.b64decode(key, validate=True).decode()
    except (binascii.Error, UnicodeDecodeError):
        decoded = ""
    if ":" not in decoded:
        return "ELASTICSEARCH_API_KEY must be the `encoded` field of the answer that made the key, not its `api_key` or `id`."
    return None
