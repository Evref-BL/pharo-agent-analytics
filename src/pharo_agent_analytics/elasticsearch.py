"""Reading the spans an import indexed, with a key that may only read them.

Pages through a point in time with search_after, so the read is consistent
and costs the cluster no scroll context; any number of spans streams through
in pages, never all held at once.
"""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Any

from .documents import hit_document

PAGE = 5_000


class ElasticsearchError(RuntimeError):
    pass


class Elasticsearch:
    def __init__(self, url: str, api_key: str, ca_file: str | None = None, timeout: float = 60):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.context = ssl.create_default_context(cafile=ca_file) if ca_file else None

    def request(self, method: str, path: str, body: Any = None) -> Any:
        request = urllib.request.Request(
            f"{self.url}/{path.lstrip('/')}",
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"ApiKey {self.api_key}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout, context=self.context) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # Elasticsearch's answer names the index and the privilege; it never quotes a span.
            raise ElasticsearchError(f"{method} {path}: {error.code} {error.read()[:300]!r}") from None

    def documents(self, index: str, since: str | None = None) -> Iterator[dict[str, Any]]:
        """Every span document of `index` (a pattern), from the week `since` (ISO date) on."""
        pit = self.request("POST", f"{index}/_pit?keep_alive=2m")["id"]
        query: dict[str, Any] = {"range": {"@timestamp": {"gte": since}}} if since else {"match_all": {}}
        after = None
        try:
            while True:
                body: dict[str, Any] = {
                    "size": PAGE,
                    "query": query,
                    "pit": {"id": pit, "keep_alive": "2m"},
                    "sort": [{"_shard_doc": "asc"}],
                    "track_total_hits": False,
                }
                if after is not None:
                    body["search_after"] = after
                page = self.request("POST", "_search", body)
                pit = page.get("pit_id", pit)
                hits = page["hits"]["hits"]
                if not hits:
                    return
                yield from (hit_document(hit) for hit in hits)
                after = hits[-1]["sort"]
        finally:
            try:
                self.request("DELETE", "_pit", {"id": pit})
            except ElasticsearchError:
                pass
