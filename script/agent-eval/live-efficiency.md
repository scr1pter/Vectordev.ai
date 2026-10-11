# Owner-run live efficiency check

No paid model calls were made during this integration. Offline scripts execute fixed tool calls against a local fake provider; they cannot establish model quality, real prompt-cache warmth, or a live price/speed advantage. The prior archive still has `decisiveClaimPermitted: false`.

These commands consume your provider allowance or credits. Run them yourself only when ready to spend approximately $1 per matched round (actual usage can vary). Use your normal CLI sign-ins; do not copy, print, or inspect credential stores. Keep generated transcripts and logs private. The matched-run and current nine-task commands below launch the CLIs normally and do not open their credential files. The recovered historical evaluator uses the derived final-source adapter described below, which delegates sign-in to the runtime.

## Prepare the exact final revision

From a clean checkout of the released main commit, record the revision and installed CLI versions. The source launcher below uses that checkout's engine, so an older globally installed Vector cannot silently enter the comparison. Install dependencies first with `bun install --frozen-lockfile` if needed.

```sh
git rev-parse HEAD
bun --version
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --version
export VECTOR_BENCH_SOURCE="$PWD"
export VECTOR_BENCH_WORK="$(mktemp -d -t vector-live-efficiency)"
cp docs/benchmarks/vector-codex-2026-10/harness/{runner.ts,tasks.ts,score.ts,meter.ts,runner-self-test.ts,extra-behavior.test.ts} "$VECTOR_BENCH_WORK/"
```

Connect Vector to OpenAI using **Sign in with ChatGPT** in its normal UI. Confirm the normal Codex CLI is signed in too. Both sides use `gpt-6.1-sol`, medium effort. Live runs intentionally inherit normal account configuration for sign-in, unlike the isolated offline harness. Record and hold user settings, plugins, custom agent rules and enabled tools constant; do not call these pristine environments. Do not run a paid probe merely to check setup. The runners report unavailable authentication, quota and model failures separately; retain those failures and do not replace them with selectively successful attempts.

Create configurations without handling credentials:

```sh
bun -e '
const root = process.env.VECTOR_BENCH_SOURCE
const work = process.env.VECTOR_BENCH_WORK
if (!root || !work) throw new Error("Set the two benchmark paths first")
const configuration = {
  vector: {
    command: process.execPath,
    prefix: ["run", "--conditions=browser", `${root}/packages/engine/src/index.ts`],
    model: "openai/gpt-6.1-sol", variant: "medium",
    extraArgs: ["--print-logs", "--log-level", "INFO"],
    env: { VECTOR_DISABLE_WEBSOCKETS: "0", VECTOR_CONFIG_CONTENT: JSON.stringify({ provider: { openai: { options: { setCacheKey: true } } } }) },
  },
  codex: {
    command: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    model: "gpt-6.1-sol", effort: "medium",
  },
  timeoutSeconds: 600,
  metadata: { purpose: "Owner-authorized live comparison", revision: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim() },
}
await Bun.write(`${work}/key-on.json`, JSON.stringify(configuration, null, 2))
configuration.vector.env.VECTOR_CONFIG_CONTENT = JSON.stringify({ provider: { openai: { options: { setCacheKey: false } } } })
await Bun.write(`${work}/key-off.json`, JSON.stringify(configuration, null, 2))
configuration.vector.env.VECTOR_CONFIG_CONTENT = JSON.stringify({ provider: { openai: { options: { setCacheKey: true } } } })
configuration.vector.env.VECTOR_DISABLE_WEBSOCKETS = "1"
await Bun.write(`${work}/http.json`, JSON.stringify(configuration, null, 2))
'
cd "$VECTOR_BENCH_WORK"
bun ./runner-self-test.ts
```

## Matched nine runs per runtime

Three archived tasks repeated three times give nine fresh sessions for each runtime. The runner alternates execution order. Keep the same machine, effort, fixtures, deadlines, tools and checks. Avoid unrelated builds during timing measurements.

```sh
bun runner.ts --config key-on.json --repeat 3 --tasks bugfix-idempotent-webhooks,feature-retry-schedule,refactor-structured-logging --run-id final-key-on
```

Each following command is a **separate paid round**. Run all cells when comparing an option; do not compare a handpicked fast run with a median.

```sh
bun runner.ts --config key-off.json --repeat 3 --tasks bugfix-idempotent-webhooks,feature-retry-schedule,refactor-structured-logging --run-id final-key-off
bun runner.ts --config http.json --repeat 3 --tasks bugfix-idempotent-webhooks,feature-retry-schedule,refactor-structured-logging --run-id final-http
```

Report pass rate and protected-file violations before latency or estimated cost. Include all failures, wall time, sampled process-tree RSS, per-session token categories, and both median and spread. Subscription usage is API-equivalent cost, not a billing invoice. Preserve title/helper spend. Do not compare Claude Code live; that comparison remains offline only.

## Cache and transport evidence

Vector emits bounded `openai transport` diagnostic records in the captured stderr: `selected`, `request_sent`, `terminal`, `failure`, transport, continuation mode, bytes and elapsed time. They exclude credentials and request content. Confirm the sign-in runs actually selected WebSocket and later requests sent `continuation: incremental`; report full resend/fallback cases too. An HTTP run must select HTTP. Use the recorded logs, not the environment flag alone, as evidence.

The runner captures each Vector `step_finish` event. For **each new session**, record the first provider turn's input tokens and `tokens.cache.read`, then all later turns separately. Keep first-request warmth separate from within-session cache share. Codex's aggregate turn totals alone do not establish its first-request `cached_tokens`; obtain per-request usage through the CLI's supported diagnostics if available, otherwise label that field unavailable. Do not infer a cache hit from a byte-identical prefix or previous_response_id.

The shipped code restores `prompt_cache_key` by default, with `setCacheKey: false` as the A/B opt-out above. The ChatGPT sign-in path separates stable instructions from a per-session developer item; the API-key path was already stable. Keep the sign-in path consistent across comparisons.

## Reasoning context experiment

`reasoning.context: "all_turns"` is **not enabled by this release**, and the current SDK exposes no supported option for it. There is no working production flag to claim or invoke. Before a paid A/B, implement and offline-test a narrowly scoped experimental request-body hook on a separate worktree, prove the resulting GPT-6 request contains the field on both HTTP and WebSocket paths, and keep the unmodified cell as control. Then repeat the nine-run command with separate configurations and fresh run IDs. Do not silently inject it into only one comparison or enable it globally without a measured quality/cost benefit. This experiment remains an owner-authorized follow-up, not a completed result.

## Behavioral gate

The original frozen evaluator was recovered on the handoff machine at:

```text
/Users/Krishna/.codex/benchmarks/vector-codex-20261007-7deUGe/round4/diagnosis/prompt-consolidation-proposal/behavior-evaluation-v12
```

Its `scenarios.json`, `rubric-v4.json`, `execution-plan.json`, `collector.ts`, `broker.ts`, actor sources, fixtures and completed reviews are present. Preserve this directory and its referenced sibling studies/source snapshots; it is not a standalone repository command. The original candidate result remains **15/18**, against a historical baseline of **14/18**. No final-code live rerun has superseded it.

The 18 candidate cells are the six original families (`general-unavailable`, `plan-only`, `nested-specialist`, `blocked-todos`, `complex-delegation-launch`, `failed-resume`) across `gpt-6.1-sol`, `gpt-6-astra` and `gpt-6-luna`, at medium effort. Matching both source arms produces 36 episodes. The gate requires every applicable criterion in all 18 candidate episodes to pass, with no critical candidate violation or candidate-only behavioral regression. Missing evidence is inconclusive, never a pass. Two independent blinded reviewers judge complete episodes; root adjudication covers every failure, inconclusive and disagreement plus the frozen positive sample before unblinding. This is a capped behavioral checkpoint screen, not proof of completed implementations or end-to-end task quality.

These recovered input hashes identify the original gate:

| File | SHA-256 |
| --- | --- |
| `scenarios.json` | `931bc371f73acca8e9fd6013abe6b1531d9021608b58622793acacb6d66137cb` |
| `rubric-v4.json` | `0d19d40cb9e2ccdb45caed3f2fd9f4f7239dd3395d9cffd74a43a52b53b78e5a` |
| `completion.json` | `7e10211f8835a657ae4d79c101d068311f72d217007c08357fa124638be51159` |

The exact historical live entry points, from that directory, were `bun run broker.ts --execute-first-block` and then `bun run broker.ts --execute-second-block`. The supplied `execute-first-block.sh` and `execute-second-block.sh` wrap them with macOS `caffeinate`. The first block runs six episodes, capped at 18 sends; the remaining 30 require a separate protocol-feasibility review and are capped at 90 sends. Each episode permits at most three turns, with a 120-second request timeout. Preserve all attempts and protocol failures; do not automatically retry or select successful replacements.

**Do not run those archived live commands as a final-code check.** They bind old V4/V11 source paths, import the archived V8 transport, require Bun 1.3.14, pin October 10 request shapes and completed run IDs, and directly read a configured OAuth credential file before connecting to the ChatGPT WebSocket endpoint. Changing an environment variable does not select the final checkout. The recorded study made 49 provider requests and estimated **$1.34958074 API-equivalent cost** using its frozen rates; actual subscription billing is unknown. That historical amount is not a current price or a promised rerun cost.

The repository now includes a [derived final-source adapter and exact preparation/live commands](behavior-v12/README.md). It runs the original native seeds and checkpoint policies through the selected checkout's engine, freezes original scenarios/rubric, source and fixture bytes, and preserves the original response, shell, source-consumption and blinded-review validators. Its declared transport change uses each source runtime's own OpenAI HTTP integration instead of the archived V8 WebSocket broker; the harness never reads credentials or authorization headers. The owner signs into a fresh CLI-only data directory normally, then explicitly starts the two live blocks after offline/protocol review. Both final candidate and original V4 baseline run all 18 cells. The historical gate remains unmet until the complete new live evidence passes blinded review.

Prepare from the clean final `VECTOR_BENCH_SOURCE` commit, and review all declared adapter differences before spending. Rebind actual request shapes and dates without weakening scenario checks. The old request contract required candidate cache-key omission, whereas the integrated code restores that key; the adapter records the current emitted shape instead of pretending that the old wire contract remains current. Its offline 36-cell preflight and six-cell rehearsal validate instrumentation with scripted responses, never model quality. Preserve every failed study and attempt; do not replace unsuccessful cells selectively.

The archived broker also implements `--check` (frozen integrity only), `--preflight <fresh-run-id>` (36 scripted loopback episodes) and `--rehearse-first-block <fresh-run-id>` (six synthetic WebSocket episodes). Their non-live branches do not read the configured real credentials or contact the provider, but they still target historical sources; preflight/rehearsal write artifacts. Use the derived adapter's separate commands for final-code preparation, offline checks and owner-run live blocks through the normal runtime. Passing synthetic responses cannot establish the 18/18 model-behavior gate. The archive itself was inspected read-only during this integration; none of these commands was executed.

The current repository's separate nine-task objective suite can be run manually as an additional paid check (it does not replace the historical 18-scenario gate):

```sh
cd "$VECTOR_BENCH_SOURCE"
cat > "$VECTOR_BENCH_WORK/vector-source" <<'SH'
#!/bin/sh
exec bun run --conditions=browser "$VECTOR_BENCH_SOURCE/packages/engine/src/index.ts" "$@"
SH
chmod 700 "$VECTOR_BENCH_WORK/vector-source"
VECTOR_EVAL_ENGINE="$VECTOR_BENCH_WORK/vector-source" bun script/agent-eval/run.ts --runtime vector --model openai/gpt-6.1-sol --tasks all --repeat 2 --keep --out "$VECTOR_BENCH_WORK/current-behavior.json"
```

Local prompt seams, real-runtime edit-before-check ordering, cancellation, title usage, fixture completion and terminal-usage tests are part of the offline validation. Their passing results do not establish live behavioral parity. Do not publish a "cheaper/faster than Codex" claim unless the matched live data and quality gates support it.
