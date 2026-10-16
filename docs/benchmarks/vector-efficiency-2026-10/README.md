# October 2026 efficiency integration: offline evidence

The integrated code sends less data and removes one headless title request per scripted Vector task. All completed comparisons retain the scripted work. These are offline transport and process measurements, not a live model quality evaluation or proof that Vector is generally cheaper, faster, or lighter than another agent. The earlier [live archive](../vector-codex-2026-10/README.md) remains unfavorable to Vector; this work does not supersede it.

## Method and provenance

The baseline is `c46b66efabb67ee5cb00d18391fb7a401fd8154b`, the fetched `origin/main` at integration start. The integrated command-line runtime is frozen at `6f7f3c2ea3091c8f30edfce4b429b82f42a43d1b`, including the reviewed security, Cloud, helper accounting, prompt, continuation, snapshot, startup, shell-binding, CLI approval, grep read-permission, and exact-filename enumeration changes. Later commits present during these runs change test fixtures, documentation, or separate benchmark tooling only. The subsequent browser terminal WebAssembly asset fix does not change the command-line execution measured here. Per-run checkout revisions, harness revisions, timestamps, machine load, and report hashes are in `manifest.json`.

Both checkouts run through the same `script/agent-eval/footprint.ts` harness. HTTP has three repetitions of four scenarios, four runtimes, and two fresh sessions: 192 cells total. Each runtime's modeled cache persists across its scenarios and sessions within one repetition, then resets for the next repetition. Session 2 is a fresh process and home with a warmed simulated provider cache; it is not a resumed chat. WebSocket measurements repeat the 12-turn investigation three times for Vector Responses and Codex, with two sessions per checkout: 24 cells.

The harness runs actual CLI processes and actual local tools against a loopback fake model server. It uses throwaway homes and placeholder keys; Codex receives an otherwise empty environment and never reads the owner's normal home or sign-in. No paid model calls were made. Runtime versions are in `raw/runtime-versions.json`: Bun 1.3.14, Claude Code 2.1.215, Codex CLI 0.162.0-alpha.17.2, macOS 27.0.1 arm64. Vector runs from source, while the comparison CLIs are installed distributions, so these are not matched packaging measurements.

For each cell, the fake model emits a fixed sequence. `solo-fix` runs tests, reads, edits, reruns tests, and answers. The two delegate scenarios exercise exploration or general work plus parent verification. Vector and Claude use their real delegation tools; this Codex fixture executes the corresponding operations inline, so delegate rows do not compare equal orchestration topologies. `long-loop` is a 12-turn investigation that deliberately stops before editing: it has no final green-test requirement. The three fix scenarios each run a separate final fixture check. All 144 HTTP final checks passed. No missing scripted step is accepted as success.

The HTTP runs captured 816 baseline requests and 768 integrated requests. The 48-request difference is the headless title request removed from each Vector cell; the five solo, eight delegated, and twelve investigation work turns remain. Request-body review found unchanged scripted operations and answers after normalizing temporary paths, no lost conversation history, and the same offered tool names. Task and shell descriptions are shorter, with the background-task option retained. Conditional Cloud tools are absent from these fixtures, so this archive does not attribute any byte reduction to their conditional loading.

Both transports use the same final harness, including native UTF-8 byte measurement, the plural WebSocket environment flag, reconstruction of previous input before classifying inherited CodeMode tools, and synthetic stored API auth for the fake Vector WebSocket endpoint. The synthetic auth is necessary to install Vector's transport wrapper. Earlier reports that only requested WebSocket mode but actually used HTTP, plus one incomplete Codex pilot, are retained under `invalid/` and excluded from all medians. Earlier exploratory and pre-final runs remain in the local evidence archive; only the twelve named final reports enter these tables.

The footprint, prompt-cache, and task source files have identical hashes across all twelve canonical runs; those hashes are recorded in the manifest. Excluded reports under `invalid/` predate the byte-meter correction and count UTF-16 units in their historical `sentBytes` fields.

`raw/` contains measured JSON reports, including per-request costs, every RSS sample, exit status, unplayed count, and applicable final fixture results. It excludes raw request bodies, headers, credentials, and real user transcripts. Independent local review used the separately preserved request captures. `analyze.py` rebuilds all per-cell medians in `summary.json` from three repetitions and refuses failed or incomplete cells. It does not contact a provider.

## Results

The tables below use the median of three repetitions per exact cell. Session 2 is shown for compactness; `summary.json` includes both sessions and every scenario. All canonical raw reports measure UTF-8 JSON payload bytes directly, excluding headers, transport framing, and compression. Independent reconstruction from preserved captures verified all 1,890 request sizes: 1,590 HTTP sizes also match `Content-Length`, and 300 WebSocket payloads include their `response.create` envelope. `payload-sizes.json` records those independently checked sizes. Cache and token estimates retain their character-based model.

### Warm solo task: comparison runtimes

| Runtime          | Requests | UTF-8 payload bytes |           Modeled USD | Wall seconds | First primary seconds | Peak RSS MiB |
| ---------------- | -------: | ------------------: | --------------------: | -----------: | --------------------: | -----------: |
| Vector Messages  |    6 → 5 |   207,361 → 193,909 | $0.023459 → $0.020625 |  8.35 → 3.21 |           3.87 → 1.68 |    573 → 720 |
| Claude Code      |    5 → 5 |   610,652 → 610,652 | $0.081438 → $0.081438 |  1.06 → 0.50 |           0.66 → 0.37 |    326 → 336 |
| Vector Responses |    6 → 5 |   204,151 → 190,197 | $0.012924 → $0.010985 |  7.44 → 3.02 |           4.00 → 1.58 |    576 → 718 |
| Codex            |    5 → 5 |   306,439 → 306,439 | $0.016810 → $0.016810 |  1.35 → 0.75 |           0.36 → 0.18 |    157 → 152 |

Each arrow is baseline → integration. Comparison CLI versions and scripted payloads stay unchanged; their timing variation illustrates machine noise.

The measured warm-solo Vector memory peaks increased: Messages rose from 573 to 720 MiB, and Responses from 576 to 718 MiB. This run does not support a claim that the integrated runtime is lighter. Timing also improved for the unchanged comparison CLIs, so the lower Vector wall times cannot all be attributed to code changes.

### Addendum, 16 October 2026: Vector warm-solo memory after the speed-memory changes

A later offline A/B used the same harness, unchanged since harness revision `2bc9c6224`, on `solo-fix` for Vector on both APIs with two sessions. It measured three revisions three times each, rotating their order in every repetition: the baseline `c46b66efa`, the integration branch `a077cd0fc`, and the `speed-memory` branch `4f8f5708a`. That branch loads feature-only packages such as the MCP SDK, the GitLab SDK and the PowerShell grammar on first use, imports only the platform modules it uses, builds each layer node once, hands a released file lock to the next fiber of the same process, and changes model catalog refreshes; the difference below is not attributed to individual commits. The figures describe that branch before it merges with the other tracks; the merged revision needs its own measurement. Each revision ran from source with its frozen dependencies on Bun 1.3.14, macOS 27.0.1 arm64, 8 cores. One-minute load averages at run starts were 2.8 to 4.1. All 36 cells exited cleanly with every scripted step played, and all 36 final fixture checks passed. The reports, their hashes and the run order are in [`addendum-2026-10-16/`](addendum-2026-10-16/manifest.json); `summarize.py` there recomputes these medians.

| Runtime          | Session |  Requests |    Baseline MiB | Integration MiB | speed-memory MiB |
| ---------------- | ------: | --------: | --------------: | --------------: | ---------------: |
| Vector Messages  |       2 | 6 → 5 → 5 | 724 (684 – 780) | 767 (755 – 838) |  521 (515 – 545) |
| Vector Responses |       2 | 6 → 5 → 5 | 721 (701 – 771) | 764 (725 – 775) |  517 (504 – 539) |
| Vector Messages  |       1 | 6 → 5 → 5 | 745 (693 – 765) | 767 (765 – 773) |  518 (503 – 527) |
| Vector Responses |       1 | 6 → 5 → 5 | 724 (715 – 782) | 771 (677 – 772) |  528 (527 – 530) |

Peak process-tree RSS, median of three with the range in parentheses.

The 573 and 576 MiB baseline peaks in the table above did not reproduce: this run's baseline medians are 721 to 745 MiB, so the earlier baseline figures were low samples of a noisy measure, and the rise from baseline to integration is smaller here, about 6% on session 2. The `speed-memory` peaks are 31 to 33% below the integration branch's and 27 to 31% below this run's baseline. Session 2 medians of the first primary request were 1.42, 1.22 and 0.86 seconds, and of wall time 2.77, 2.20 and 1.78 seconds, for baseline, integration and `speed-memory` on Messages; Responses was within 0.03 seconds of each. These runs included no comparison CLI to show machine noise, so the timings are not a speed claim. This addendum compares Vector revisions only. The comparison rows above remain the only measurements of other agents, and Vector's lowest peak here is still well above theirs.

### All Vector scenarios, warm session

| API       | Scenario         | Requests | UTF-8 payload bytes |           Modeled USD | Wall seconds | Tail milliseconds |
| --------- | ---------------- | -------: | ------------------: | --------------------: | -----------: | ----------------: |
| Messages  | solo-fix         |    6 → 5 |   207,361 → 193,909 | $0.023459 → $0.020625 |  8.35 → 3.21 |         951 → 578 |
| Messages  | delegate-explore |    9 → 8 |   246,340 → 228,706 | $0.029199 → $0.026053 |  8.39 → 3.58 |         671 → 485 |
| Messages  | delegate-general |    9 → 8 |   226,644 → 211,462 | $0.027780 → $0.024817 |  8.77 → 3.21 |         667 → 468 |
| Messages  | long-loop        |  13 → 12 |   517,698 → 489,425 | $0.051404 → $0.047429 | 11.48 → 3.66 |         593 → 430 |
| Responses | solo-fix         |    6 → 5 |   204,151 → 190,197 | $0.012924 → $0.010985 |  7.44 → 3.02 |         622 → 539 |
| Responses | delegate-explore |    9 → 8 |   245,462 → 227,482 | $0.017214 → $0.015376 | 10.11 → 3.52 |         667 → 489 |
| Responses | delegate-general |    9 → 8 |   223,692 → 208,476 | $0.016538 → $0.015108 |  7.61 → 3.41 |         688 → 499 |
| Responses | long-loop        |  13 → 12 |   564,391 → 534,885 | $0.029921 → $0.028062 | 13.50 → 3.79 |         648 → 389 |

### First primary request in a new solo session

| Runtime       | State      | Session 1 modeled cache / input tokens | Session 2 modeled cache / input tokens |
| ------------- | ---------- | -------------------------------------: | -------------------------------------: |
| vector        | baseline   |                              0 / 9,710 |                          9,333 / 9,710 |
| vector        | integrated |                              0 / 9,183 |                          8,806 / 9,183 |
| vector-openai | baseline   |                              0 / 8,914 |                          8,576 / 8,914 |
| vector-openai | integrated |                              0 / 8,348 |                          7,936 / 8,348 |
| claude-code   | baseline   |                             0 / 29,857 |                        20,838 / 29,857 |
| claude-code   | integrated |                             0 / 29,857 |                        20,838 / 29,857 |
| codex         | baseline   |                             0 / 13,591 |                        11,776 / 13,591 |
| codex         | integrated |                             0 / 13,591 |                        11,776 / 13,591 |

The smaller Vector prefix also has fewer cached tokens in absolute terms; read counts alone do not measure efficiency. These are API-key simulations, not signed-in cache observations.

### Genuine WebSocket long-loop, warm session

| Runtime       | Requests | UTF-8 payload bytes |           Modeled USD | Wall seconds | Peak RSS MiB |
| ------------- | -------: | ------------------: | --------------------: | -----------: | -----------: |
| vector-openai |  13 → 12 |   564,523 → 265,248 | $0.029921 → $0.028023 |  5.75 → 3.90 |    828 → 781 |
| codex         |  13 → 13 |     85,918 → 85,922 | $0.038742 → $0.038720 |  1.32 → 1.23 |    161 → 162 |

Vector payload falls 53.0%. Baseline Vector sends the full growing input on every WebSocket work request; integrated Vector sends one new input item after the first request. The final reconstructed input still contains 35 items in both cases. Baseline also makes one HTTP title side call, included in the totals. Codex includes one WebSocket prewarm plus twelve work requests and ends with 40 reconstructed input items. Every working request in this table was verified as WebSocket from captures; no transport flag was treated as proof. Cost is computed on reconstructed full context, never on the smaller incremental frame.

### Warm solo process phases

| Runtime       | Startup peak MiB | Active peak MiB |     Tail peak MiB |
| ------------- | ---------------: | --------------: | ----------------: |
| vector        |        553 → 626 |       542 → 666 |         458 → 720 |
| vector-openai |        474 → 628 |       494 → 684 |         576 → 718 |
| claude-code   |        293 → 297 |       326 → 336 | 294 → unavailable |
| codex         |         101 → 92 |       143 → 145 |         149 → 152 |

## Cache and cost limits

Tokens are estimated as characters divided by four. The cache model places tool definitions before system/instruction text, then conversation items. Messages uses declared breakpoints and a modeled five-minute cache write/read policy; Responses uses common prefixes with a 1,024-token minimum and 128-token steps. These are simulation assumptions, not provider billing observations. The request classification of parent versus child uses tool signatures; total task cost includes every captured request regardless of that heuristic.

Messages rates are fixed at $3 input, $3.75 cache write, $0.30 cache read, and $15 output per million estimated tokens. Responses uses the historical matched-live archive's $2 input, $0.10 cache read, and $10 output rates. Compare runtime costs only within the same API/rate family. A lower offline cost does not establish live quality, real cached-token behavior, or current retail pricing.

These Vector runs use the API-key path, whose provider instructions were already stable. They do not measure the ChatGPT sign-in prefix fix. Source tests verify stable instructions and preservation of per-session context in developer items, but the owner's live check must establish first-request `cached_tokens` across fresh signed-in sessions. `fixedTokensPerRequest` in raw reports counts top-level system text plus tools; Responses developer/system items are in `input`, so this field must not be described as all fixed context. Total input cost includes those items.

## Timing and memory limits

Process-tree RSS is sampled every 100 ms using PID identity, summed over descendants. Shared pages may be counted more than once and brief peaks may be missed. Phase peaks and total peak are medians of each run's maxima, not one synthetic process. A phase with no positive RSS observation is unavailable (`null`), not zero usage; the summary includes observed trial and sample counts. Startup means before the first captured request, active means between requests, and tail begins at the final captured request.

The tables use the first **primary** request by aligning request classification with request timestamps. Raw `timeToFirstRequestMs` may instead be a title or prewarm request. `postTerminalMs` measures from the last fake request to process exit; because the server emits the terminal event immediately, it is an approximation of end-of-run overhead, not a production network or per-token latency measurement.

Runs share a development machine with bounded concurrent checks. Runs initially alternated baseline and integration. The first two integrated HTTP repetitions were then repeated after the final filename-admission fix; those replacements enter the medians, while the earlier successful runs are preserved separately. WebSocket pairs remained alternated. Order was not randomized. The recorded one-minute machine load at run boundaries ranged from 8.0 to 29.8; the slowest integrated Vector first-primary request was 1.92 seconds. These data do not establish elimination of startup stalls or a general memory improvement. The installed comparison CLIs also varied in wall time despite identical task payloads. Controlled idle-machine repetitions and packaged builds are needed before making a speed claim.

## Reproduce without paid calls

Install the same runtime versions, prepare baseline and integration checkouts with their frozen dependencies, then run the integration's harness against each checkout. Use a fresh report name for each of three repetitions:

```sh
bun --no-env-file script/agent-eval/footprint.ts \
  --engine-root /absolute/path/to/checkout \
  --runtime vector,vector-openai,claude-code,codex \
  --codex /absolute/path/to/codex \
  --openai-model gpt-6.1-sol --codex-model gpt-6.1-sol \
  --sessions 2 --out /private/output/report.json --dump /private/output/requests
```

For transport measurements, use `--runtime vector-openai,codex --scenario long-loop --ws` with the remaining arguments unchanged. Keep request dumps private. Regenerate the checked-in medians with `python3 docs/benchmarks/vector-efficiency-2026-10/analyze.py`.

## Remaining live and behavior checks

[The owner-run guide](../../../script/agent-eval/live-efficiency.md) supplies the matched nine-runs-per-runtime comparison, cache-key A/B, HTTP/WebSocket controls, and transport log collection. Those commands use the owner's normal sign-in and spend credits; they were not run here. `reasoning.context: "all_turns"` has no supported option in this runtime, so the guide explicitly requires a reviewed body-hook experiment before that A/B can be run.

The exact historical `behavior-evaluation-v12` 18-scenario evaluator was recovered from the owner's private benchmark archive, including its scenarios, collector, gate, fixtures, and completion record. Its recorded 15/18 result has not been superseded. The owner-run guide documents the recovered evaluator separately from the nine-task matched comparison. Prompt-seam, ordering, cancellation, and fixture checks passed, but fixed scripted replay cannot replace live agent behavior evaluation.

The [derived checkpoint adapter](../../../script/agent-eval/behavior-v12/README.md) preserves the original scenarios and rubric while using each checkout's native runtime with fresh source and dependency bindings. Its 36 offline paired episodes and six multi-turn rehearsals passed capture, source, shell, and durable-consumption checks; every synthetic episode keeps `behavioralPass: null`. The adapter uses HTTP in place of the historical collector's WebSocket path and therefore cannot establish a transport or speed comparison. Prepare a fresh study from the final clean checkout, complete its offline checks, and obtain the owner's live-provider approval before running either live block. No paid behavior rerun was performed.

The App traffic fixture is a separate measurement: its corrected integrated count is 10 requests / 39,002 bytes (two history reads and eight metadata reads, no directory bootstrap), compared with the earlier 83-request / 6.52 MB baseline. The Vectorscope fixture has zero added refresh requests. Those counts test refresh behavior, not actual provider tokens or end-to-end application speed.
