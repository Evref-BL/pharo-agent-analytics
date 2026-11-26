"""The tools that exist, for those nobody called, from any catalog of them."""

import json

from pharo_agent_analytics import report

CATALOG = {
    "published": "2026-11-26",
    "releases": {"MCP": "v4.6.0", "PLexus": "v0.24.0", "Widgets": "abc123"},
    "sets": {
        "MCP tools": ["class_get"],
        "PLexus tools": ["image_list"],
        "Widgets tools": ["widget_list"],
        "Widgets words": ["widget", "prefix"],
        "project words": ["class", "get"],
    },
}


def test_every_project_of_a_catalog_names_its_tools(tmp_path):
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps(CATALOG))
    assert report.published_tools(catalog)["rows"] == [
        ["MCP", "class_get"], ["PLexus", "image_list"], ["Widgets", "widget_list"]]


def test_a_signed_catalog_is_read_as_its_payload(tmp_path):
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps({"payload": json.dumps(CATALOG), "signature": "c2lnbmVk"}))
    assert ["Widgets", "widget_list"] in report.published_tools(catalog)["rows"]


def test_a_list_of_names_has_no_component(tmp_path):
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps(["evaluate", "widget_list"]))
    assert report.published_tools(catalog)["rows"] == [[None, "evaluate"], [None, "widget_list"]]
