# Owner-run live efficiency check

No paid model calls were made during this integration. Offline scripts execute fixed tool calls against a local fake provider; they cannot establish model quality, real prompt-cache warmth, or a live price/speed advantage. The prior archive still has `decisiveClaimPermitted: false`.

These commands consume your provider allowance or credits. Run them yourself only when ready to spend approximately $1 per matched round (actual usage can vary). Use your normal CLI sign-ins; do not copy, print, or inspect credential stores. Keep generated transcripts and logs private. The benchmark code launches the CLIs normally and does not open their credential files.

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

The historical `behavior-evaluation-v12` result was 15/18 required scenarios. Its runnable scenario definitions and validators were not present in the supplied repository/handoff; archived numerical projections are insufficient to reconstruct them faithfully. Recover the original frozen evaluator from the private archive before claiming to rerun that exact gate; pin its scenario/validator hashes and compare the final engine to its baseline without weakening checks. The original 15/18 score has not been superseded.

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
