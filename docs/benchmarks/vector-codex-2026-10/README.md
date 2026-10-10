# October 2026 Vector/Codex benchmark archive

This archive preserves existing evidence, including unfavorable, failed and incomplete results. Benchmarking was stopped at the user's request. The export did not run a benchmark, contact a model provider, or change the external originals.

Start with `summary.json`. The original matched comparison favored Codex on median time, estimated API-equivalent cost and sampled process-tree memory. Later changes improve specific operations, but this record does not establish a general Vector speed/cost advantage. The final code integration has a passing engine typecheck and three targeted regression checks; unresolved historical review/prompt failures remain explicit.

## Data and provenance

`data/*.metrics.json` contains compact numerical projections grouped by original experiment directory. Each record names its source relative to the external archive and includes the original SHA-256 and byte count. Arrays preserve source indexes and lengths. `data/manifest.json` lists exported files, hashes and omissions. `export.py` documents the allowlist and can regenerate these projections from an authorized local copy of the originals.

Missing fields are omitted, not zero or success. Null cost stays unknown. A report and its summaries may repeat the same trials; do not add their counts together. Source hashes bind bytes, not validity or independence. The concise summary's current integration status is coordinator-reported; its named log files remain external.

Excluded material includes credentials, private runtime directories, session transcripts, request/response bodies and headers, raw tool events, arbitrary free-text reports, binary/build copies, node_modules, fixture checkouts and machine-specific configuration. Some nonnumeric status labels are represented by hashes. The originals remain in the external `vector-codex-20261007-7deUGe` archive for authorized investigation.

## Reproducible harness sources

`harness/` preserves portable original/frozen synthetic task definitions, scoring, metering, runners, self-checks and experiment/analysis scripts. `harness-manifest.json` records original hashes, exact copies and omitted sources. Scripts containing machine-specific home paths, credential-like literals or private-state collectors were omitted. Some auxiliary experiment scripts consequently need omitted local setup or dependencies; the primary original and frozen runner/task/score/meter sets are retained together.

**Live runners consume provider credits and are manual only. This archive adds no CI job or automatic benchmark invocation.** No included script was executed during export. Runtime credentials must come from the operator's normal CLI/environment setup; no credential values are included. Keep newly generated raw logs private and apply the exporter before publishing data.

For a future explicitly authorized run, use a disposable copy of a harness directory, install Bun and Git, configure the Vector/Codex executables, and adapt `harness/config.example.json`. The original runner accepts:

```sh
bun runner.ts --config config.json --repeat 1 --tasks bugfix-idempotent-webhooks --run-id explicit-manual-run
```

The frozen round3/round4 sets have the same entrypoint. `runner-self-test.ts` exercises local subprocess capture and cleanup; `analysis.ts` processes a newly produced raw report. The exported projections intentionally omit data needed to regenerate the original HTML reports; they are public evidence, not full raw execution bundles. Historical pricing constants and model names are preserved as historical inputs and must be reviewed before any future run.
