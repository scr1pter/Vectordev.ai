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

[The owner-run guide](../../../script/agent-eval/live-efficiency.md) supplies the matched nine-runs-per-runtime comparison, cache-key A/B, HTTP/WebSocket controls, and transport log collection. Those commands use the owner's normal sign-in and spend credits; they were not run here. `reasoning.context` had no supported option in the runtime measured above. The [follow-up](#follow-up-tokenomics-final-2026-10-15) adds an opt-in body hook for it, off by default, and the guide now gives the offline wire check plus the two-prompt comparison that could show an effect; no result exists for it yet.

The exact historical `behavior-evaluation-v12` 18-scenario evaluator was recovered from the owner's private benchmark archive, including its scenarios, collector, gate, fixtures, and completion record. Its recorded 15/18 result has not been superseded. The owner-run guide documents the recovered evaluator separately from the nine-task matched comparison. Prompt-seam, ordering, cancellation, and fixture checks passed, but fixed scripted replay cannot replace live agent behavior evaluation.

The [derived checkpoint adapter](../../../script/agent-eval/behavior-v12/README.md) preserves the original scenarios and rubric while using each checkout's native runtime with fresh source and dependency bindings. Its 36 offline paired episodes and six multi-turn rehearsals passed capture, source, shell, and durable-consumption checks; every synthetic episode keeps `behavioralPass: null`. The adapter uses HTTP in place of the historical collector's WebSocket path and therefore cannot establish a transport or speed comparison. Prepare a fresh study from the final clean checkout, complete its offline checks, and obtain the owner's live-provider approval before running either live block. No paid behavior rerun was performed.

The App traffic fixture is a separate measurement: its corrected integrated count is 10 requests / 39,002 bytes (two history reads and eight metadata reads, no directory bootstrap), compared with the earlier 83-request / 6.52 MB baseline. The Vectorscope fixture has zero added refresh requests. Those counts test refresh behavior, not actual provider tokens or end-to-end application speed.

## Follow-up: tokenomics-final (2026-10-15)

Branch `tokenomics-final` adds four engine commits to `a077cd0fc` (the integration measured above plus the terminal asset fix). Its measurements are in [`followup-2026-10-15/`](followup-2026-10-15/): twelve raw reports, `summary.json` and `manifest.json`. They are offline scripted replays like the tables above and carry the same limits; nothing here was measured against a live provider.

### What changed

- `4110a1b41` drops description lines that restate the tool's own parameter descriptions: grep's path and include bullets, read's offset bullet, three repeated webfetch bullets and its format list, and skill's closing sentence. Every fact and instruction remains in the definition the model receives. Each request that offers all four tools is 606 description characters shorter (Responses tool JSON 20,622 → 19,997 characters).
- `d11c951fa` sends a `vector run` prompt as typed. Every argument containing a space was wrapped in quotation marks with its inner quotes escaped, so a benchmarked task reached the model as `"\"...\""`, and the headless title carried the quotes. The live archive's Vector build (`d3ae064a2`) has the same code, so its benchmarked prompts arrived quoted too. A `--command`'s arguments keep the quoting their `$1`/`$2` placeholders need.
- `d602efa27` and `f28b8168c` add `VECTOR_EXPERIMENTAL_REASONING_CONTEXT`, which sets the documented `reasoning.context` field on OpenAI Responses reasoning requests to the GPT-5.6 family and GPT-6.1 Sol only. It is off by default. Each `openai transport` diagnostic records the requested mode, and a WebSocket terminal record the mode the response reports, so the owner's ordinary signed-in runs show gpt-6.1-sol's default. Offline wire check with the flag set: all five HTTP and all five WebSocket requests of a `solo-fix` session carried `reasoning.context: "all_turns"`, and the four WebSocket requests after the first still carried `previous_response_id`. No result for the field exists; see the [owner-run guide](../../../script/agent-eval/live-efficiency.md#reasoning-context-experiment).

### Method

`before` is `a077cd0fc` and `after` is `f28b8168c`. Both ran through the harness at `f28b8168c`, whose `footprint.ts` differs from the canonical runs' only by forwarding `VECTOR_EXPERIMENTAL_REASONING_CONTEXT` when it is set; it was unset, since every run used `env -i` and a throwaway HOME. Runs alternated before and after: three HTTP repetitions of four runtimes, four scenarios and two sessions (192 cells), then three WebSocket repetitions of `long-loop` for Vector Responses and Codex (24 cells). All twelve reports exited 0, every cell played its whole script, and all 144 HTTP final fixture checks passed. One-minute load at run starts ranged from 7.0 to 36.4. An earlier attempt that day, under load up to 170 and interrupted after three reports, is not used. Recompute the medians with `python3 docs/benchmarks/vector-efficiency-2026-10/analyze.py docs/benchmarks/vector-efficiency-2026-10/followup-2026-10-15 before after`.

Request-body review of the private captures, after normalizing temporary paths and IDs: Vector's bodies differ only in the four tool descriptions and the unquoted prompt, with the same request counts, offered tools, system text, instructions and parameters. Within every Vector cell, each request extends the previous request of the same agent byte for byte, so there are no per-request volatile bytes; across sessions, the first difference is the working directory in the environment block. Codex and Claude Code bodies differ only in run-specific identifiers and hashes and in the output their scripted commands returned (test timings, search result order).

### Results, warm session

| API       | Scenario         | Requests | UTF-8 payload bytes       | Modeled USD                   | First primary input tokens |
| --------- | ---------------- | -------: | ------------------------- | ----------------------------- | -------------------------: |
| Messages  | solo-fix         |        5 | 192,940 → 189,791 (−1.6%) | $0.019991 → $0.019745 (−1.2%) |              9,161 → 9,003 |
| Messages  | delegate-explore |        8 | 227,473 → 222,684 (−2.1%) | $0.024918 → $0.024552 (−1.5%) |              9,161 → 9,003 |
| Messages  | delegate-general |        8 | 210,225 → 205,212 (−2.4%) | $0.024083 → $0.023697 (−1.6%) |              9,161 → 9,003 |
| Messages  | long-loop        |       12 | 484,583 → 477,026 (−1.6%) | $0.045504 → $0.044933 (−1.3%) |              9,172 → 9,014 |
| Responses | solo-fix         |        5 | 189,312 → 186,167 (−1.7%) | $0.010922 → $0.011034 (+1.0%) |              8,326 → 8,167 |
| Responses | delegate-explore |        8 | 226,337 → 221,548 (−2.1%) | $0.014961 → $0.014731 (−1.5%) |              8,326 → 8,167 |
| Responses | delegate-general |        8 | 207,332 → 202,314 (−2.4%) | $0.014669 → $0.014568 (−0.7%) |              8,326 → 8,167 |
| Responses | long-loop        |       12 | 530,032 → 522,484 (−1.4%) | $0.026929 → $0.026760 (−0.6%) |              8,337 → 8,178 |
| Responses | long-loop, WS    |       12 | 264,851 → 257,347 (−2.8%) | $0.026645 → $0.027207 (+2.1%) |              8,337 → 8,178 |

Session 1 moves the same way and is in `summary.json`. Request counts are unchanged, and the unchanged Codex and Claude Code references stay within 110 bytes and $0.0001 of their before values.

Each Vector primary request sends 158 or 159 fewer estimated input tokens, and each explore subagent request 138 fewer. Modeled Messages cost, priced with declared breakpoints, falls in every cell. The Responses cache model, like OpenAI's prompt cache, counts cached tokens in 128-token steps, so a primary request's cached part shrinks by one step (its uncached part falls by 31 tokens) or by two (it rises by 97), depending on where its shared prefix ended. Averaged over arbitrary alignments that step contributes nothing, but these fixed scripts hit the +97 case in 48 of 198 HTTP and 36 of 72 WebSocket Responses requests. The +1.0% and +2.1% cells are that alignment, not more uncached content, and a different conversation length can reverse them. The smaller prefix is the only change in what is sent.

Wall time and peak RSS varied in both directions for unchanged CLIs as well as Vector and are not claims; per-run values are in `summary.json`.

### Tool definitions in these fixtures

Estimated tokens (characters / 4) of the primary agent's tool definitions on every request:

| Runtime          | Before |  After |
| ---------------- | -----: | -----: |
| Vector Messages  |  5,598 |  5,441 |
| Vector Responses |  5,077 |  4,919 |
| Codex            |  6,182 |  6,182 |
| Claude Code      | 20,791 | 20,791 |

The live archive's 23,344-against-9,510-character comparison used an earlier Codex build. Codex CLI 0.162.0-alpha.17.2 sends its tools for gpt-6.1-sol as an `additional_tools` input item of 25,347 characters, against Vector Responses' 19,997. This is a count of what the fixtures offer, not a cost or quality comparison. The remaining Vector text (task delegation rules, shell, todo and patch guidance, and the cross-referenced editing and batching guidance in the system prompt) is behavioral instruction rather than repetition; trimming it further would need the live behavior gate, so this follow-up does not.

The same captures show Codex sending `reasoning.effort: "low"` for gpt-6.1-sol when none is configured, while Vector sends `medium` by default. The matched live archive configured `medium` for both, so this default is not part of its measured gap. Whether Vector's default should change is a cost and quality decision for the owner; nothing here changes it.

### What this harness cannot show

The fake model's outputs are scripted, so the archive's remaining live gaps (output length, requests per task, and whether the model now sends an edit and its check in one response) cannot move here. Their fixes on the integrated branch (final-reply guidance, ordered edit-and-check execution, shorter task and shell descriptions) are covered by source tests, and their live effect needs the owner's matched comparison.

The recovered behavior gate's standalone freeze and evidence proofs (`script/agent-eval/behavior-v12/offline-proof.py`, 9 tests) pass on `f28b8168c`. Its 36-episode seeded preflight and rehearsal need the recovered E12 archive, which is stored under the owner's private Codex directory; this work may not read that directory, so they were not run. The recorded 15/18 result stands, and no paid behavior run was made.
