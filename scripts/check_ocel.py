"""Read an OCEL file with pm4py and discover its object-centric DFG.

pm4py is AGPL-3.0: it is only a check, in its own dependency group, never
imported by the package.

    uv run --group check python scripts/check_ocel.py out/calls.ocel.sqlite
"""

import sys

import pm4py

path = sys.argv[1]
log = pm4py.read_ocel2_sqlite(path) if path.endswith(".sqlite") else pm4py.read_ocel2_json(path)
print(f"{len(log.events)} events, {len(log.objects)} objects, {len(log.relations)} event-object relations, {len(log.o2o)} object-object")
dfg = pm4py.discover_ocdfg(log)
for object_type, couples in dfg["edges"]["event_couples"].items():
    print(f"{object_type}: {len(couples)} directly-follows arcs")
