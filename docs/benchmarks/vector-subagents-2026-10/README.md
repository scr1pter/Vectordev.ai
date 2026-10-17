# Subagent orchestration footprint

These are offline request-footprint estimates from real CLIs pointed at a local scripted provider. No paid model calls or real credentials were used. A scripted response cannot establish model quality, real cache warmth, or a live cost/speed advantage. The existing live behavior gate remains unmet.

## Baseline and provenance

The original `before-explore.json` and `before-general.json` were captured before changing the task engine, using the `bdec3b29e` implementation plus the design-only commit. Both runtimes performed the same fixture operations, every scripted step was consumed, and the untouched invoice tests passed. Each file starts a fresh simulated cache and then runs two sessions per runtime. The first is cold; the second can reuse prefixes from the first.

| Original foreground scenario            | Vector cold | Claude Code cold | Vector second session | Claude Code second session |
| --------------------------------------- | ----------: | ---------------: | --------------------: | -------------------------: |
| Explore, parent fix and verification    |     $0.0644 |          $0.2137 |               $0.0257 |                    $0.1037 |
| General worker fix, parent verification |     $0.0680 |          $0.2213 |               $0.0244 |                    $0.1005 |

These figures are modeled USD, not invoices. The original scripts used implicit Vector foreground execution. The revised scripts explicitly request `background: false` for these two cases so they continue to measure the same topology after the default changes. This adds a few serialized tokens. Matched before/after reports use the revised harness on both source revisions; the original reports remain as provenance.

`baseline-explore.json` and `baseline-general.json` are the immutable baseline rerun: the revised harness at `44d81a5be` drove a separate, dependency-installed checkout at exactly `bdec3b29e`. All eight cells were valid. Explore measured $0.0645 cold / $0.0258 second-session for Vector and $0.2137 / $0.1037 for Claude Code; General measured $0.0681 / $0.0245 and $0.2213 / $0.1005 respectively. These are the matched baseline cells for the final comparison.

`router-smoke-invalid.json` preserves an early harness validation failure: the actor router incorrectly required a task ID from foreground results, although Claude Code returns the report directly. The operation scripts and fixture checks completed, but those cells were invalid under that router. The router now requires IDs only for background launches. They must not be selected as final comparison evidence.

## Revised scenarios

- `delegate-explore` and `delegate-general`: the original foreground workloads with explicit mode selection.
- `delegate-multi`: two concurrent background readers, event-driven waits, then a parent fix and independent verification.
- `delegate-dependency`: a reader hands its finding to a dependent editor, then the parent verifies. Vector uses its dependency edge; Claude Code's adapter waits for the prerequisite and passes the observed result into the next brief. This topology difference is declared and all its turns are counted.
- `delegate-steer`: hold one synthetic provider response until the parent receives a message-admission receipt; the child's next request must actually contain the correction. Then complete and independently verify.
- `delegate-stop`: stop a reader while its second provider request is in flight, retain the first read, then finish and verify in the parent. The interrupted response contributes input but no generated output to the estimate.

The fake provider routes independent scripts by each child's original brief and observed session identity. It does not use a global step cursor or identify children by a different toolset. Barriers are event-driven, with no status polling or model-generated waiting turns. Parent and child operations can interleave freely. Every request, including side/title requests and extra notification turns, contributes to the report.

A cell is valid only if the CLI exits successfully, all required script steps are consumed, management tools succeed, required dependency/steer evidence reaches the child, every scripted success-verification step returns a passing test receipt, the independent fixture tests pass, and protected test files are unchanged. The fixture's initial failing test is explicitly allowed. The `baseline-*-verified.json` reruns use this stricter receipt check; earlier archives are retained. Invalid cells remain in the JSON, and the harness exits unsuccessfully. Missing runtime adapters are unavailable, not zero-cost successes. The Codex inline delegate adapter remains a different topology and the new management scenarios are unavailable there.

## Reproduction

Use two clean source checkouts with dependencies installed, one at `bdec3b29e` and one at the final candidate. Keep the harness checkout fixed while changing only `--engine-root`. Run one command at a time on an idle machine. Each report records source revisions, CLI versions, frozen rates, request counts, logical actor counts, validity and fixture verification.

```sh
bun --no-env-file script/agent-eval/footprint.ts --runtime vector,claude-code \
  --scenario delegate-explore --sessions 2 --engine-root "$VECTOR_BASELINE" \
  --out "$VECTOR_BENCH_WORK/before-explore.json"
bun --no-env-file script/agent-eval/footprint.ts --runtime vector,claude-code \
  --scenario delegate-explore --sessions 2 --engine-root "$VECTOR_CANDIDATE" \
  --out "$VECTOR_BENCH_WORK/after-explore.json"
```

Repeat with `delegate-general`. Run each new scenario against the candidate and Claude Code with the same command shape. The old baseline has no `task_manage`, so it cannot complete those new workflows; absence is a feature gap, not a cheaper equivalent result. Keep every failed attempt and the reason for any rerun. Request dumps are optional; they contain only the isolated fake-provider fixtures, but should still be reviewed before sharing.

The harness assumes approximately four characters per token and uses frozen Sonnet 4.5 list rates. It simulates prefix matching, but not provider routing, cache TTL, model-specific tokenization, or concurrent cache-write visibility. Different request ordering can change estimates slightly. OpenAI and Anthropic figures use different APIs/rates and must not be compared as a price contest. A stable prefix test is not evidence of a live cache hit.

Machine load exceeded 25 during part of development. Timing/RSS samples in these archives are diagnostic only; no speed or memory advantage is claimed. The owner-run checks are in `script/agent-eval/live-efficiency.md`.
