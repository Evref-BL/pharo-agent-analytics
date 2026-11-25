# Sources

What the project builds on, read 2026-11-25. Versions are those of that day.

## Object-centric process mining

- OCEL 2.0 specification (Berti et al., 2024): events, objects, qualified
  event-to-object and object-to-object relations, changing object attributes,
  and the SQLite, XML and JSON forms. https://arxiv.org/abs/2403.01975,
  https://www.ocel-standard.org/
- OCED, the IEEE Task Force's successor standard: a core model of events,
  objects and qualified relations; not ratified as of late 2025.
  https://www.tf-pm.org/resources/oced-standard, https://arxiv.org/abs/2410.14495
- Convergence, divergence and deficiency when flattening onto one case
  notion (van der Aalst, SEFM 2019). https://link.springer.com/10.1007/978-3-030-30446-1_1
- Object-centric directly-follows graphs (Berti and van der Aalst).
  https://arxiv.org/abs/2209.09725
- Object-centric Petri nets (van der Aalst and Berti, 2020).
  https://arxiv.org/abs/2010.02047
- Object-centric variants (Adams et al., ICPM 2022). https://arxiv.org/abs/2208.03235
- Object-centric performance, synchronisation and lagging time (Park et al.).
  https://arxiv.org/abs/2204.10662
- Event knowledge graphs and derived entities (Esser and Fahland, 2021):
  the model behind `tool use`. https://arxiv.org/abs/2005.14552
- Process and causal discovery on LLM-agent trajectories (Fournier et al.,
  2025). https://arxiv.org/abs/2505.20127
- Graphs of SWE-agent and OpenHands trajectories: resolved runs localise,
  patch and validate; unresolved ones backtrack (Liu et al.).
  https://arxiv.org/abs/2512.02393
- Scale of the libraries: pm4py loads a 7.4M-event OCEL in about 11 minutes;
  ocpa times out on large logs (Khayatbashi et al.). https://arxiv.org/abs/2412.00393
- OpenTelemetry's MCP conventions: span names, `mcp.method.name`,
  `error.type`, and a refused argument not an error on the server's span.
  https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md

## Agents and their tools

- SWE-agent and the agent-computer interface: an edit succeeds 90.5 % of the
  time, 57.2 % after one failed edit. https://arxiv.org/abs/2405.15793
- CRITICTOOL, errors made by the model versus the environment, and
  recovery behaviours. https://arxiv.org/abs/2506.13977
- MAST, a taxonomy of multi-agent failures. https://arxiv.org/abs/2503.13657
- TRAIL, trace-level error localisation. https://arxiv.org/abs/2505.08638
- MCP tool descriptions: rewriting them raised success and the number of
  steps; the case for counter-metrics. https://arxiv.org/abs/2602.14878
- Trajectory length and failure reverse once task difficulty is accounted
  for. https://arxiv.org/abs/2604.02547
- Anthropic, writing tools for agents, and tool search.
  https://www.anthropic.com/engineering/writing-tools-for-agents,
  https://www.anthropic.com/engineering/advanced-tool-use
- Clio: aggregate insight with minimum counts per cluster.
  https://arxiv.org/abs/2412.13678

## API usability

- Error and success measures per API session (Macvean et al., PPIG 2016).
  https://ppig.org/files/2016-PPIG-27th-Macvean.pdf
- StopMotion: comparing successive attempts to find API misunderstandings.
  https://research.google/pubs/discovering-api-usability-problems-at-scale/

## Statistics

- Interval estimation for a proportion: Wilson over Wald (Brown, Cai and
  DasGupta, 2001). https://projecteuclid.org/euclid.ss/1009213286
- Funnel plots for comparing rates (Spiegelhalter, 2005). https://doi.org/10.1002/sim.1970
- Competing risks: censoring a competing outcome overstates the event
  (lifelines, Aalen–Johansen). https://lifelines.readthedocs.io/en/latest/fitters/univariate/AalenJohansenFitter.html
- Direct standardisation of rates. https://documentation.sas.com/doc/en/statcdc/14.2/statug/statug_stdrate_details14.htm
- Simpson's paradox. https://plato.stanford.edu/entries/paradox-simpson/
- Markov models of navigation: one step back is usually enough (Singer et
  al., 2014). https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4094564/

## Tools

| | Version | Use here |
| --- | --- | --- |
| DuckDB | 2.0.1 | the store and every analysis |
| pm4py | 2.7.23.15, AGPL-3.0 | a check that the event log reads, outside the package |
| Rust4PM (`process_mining`, `r4pm`) | 0.7.1, MIT or Apache-2.0 | a permissive option for discovery at scale |
| ocpa | 1.3.4, stale | not used |
| Observable Plot, D3 | 0.6.19, 7.9.2 | the charts |
| @viz-js/viz | 3.31.0, Graphviz 16.1 | process map layout |
| d3-sankey | 0.12.3 | the alluvial |
| Vite | 8.3.8 | the static report |
| Observable Framework | 1.13.4, one release in 19 months, DuckDB-WASM 1.1 | not used |
| Evidence | moved to server-side SQL | not used |
| Kibana 8.8 | Vega and Lens cannot pair a span with the next one | the dashboard stays for counts |
