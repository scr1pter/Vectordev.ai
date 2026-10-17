# Subagent orchestration footprint

These are offline request-footprint estimates from real CLIs pointed at a local scripted provider. No paid model calls or real credentials were used. A scripted response cannot establish model quality, real cache warmth, or a live cost/speed advantage. The existing live behavior gate remains unmet.

## Baseline and provenance

The original `before-explore.json` and `before-general.json` were captured before changing the task engine, using the `bdec3b29e` implementation plus the design-only commit. Both runtimes performed the same fixture operations, every scripted step was consumed, and the untouched invoice tests passed. Each file starts a fresh simulated cache and then runs two sessions per runtime. The first is cold; the second can reuse prefixes from the first.

| Original foreground scenario            | Vector cold | Claude Code cold | Vector second session | Claude Code second session |
| --------------------------------------- | ----------: | ---------------: | --------------------: | -------------------------: |
| Explore, parent fix and verification    |     $0.0644 |          $0.2137 |               $0.0257 |                    $0.1037 |
| General worker fix, parent verification |     $0.0680 |          $0.2213 |               $0.0244 |                    $0.1005 |

These figures are modeled USD, not invoices. The original scripts used implicit Vector foreground execution. The revised scripts explicitly request `background: false` for these two cases so they continue to measure the same topology after the default changes. This adds a few serialized tokens. Matched before/after reports use the revised harness on both source revisions; the original reports remain as provenance.

`baseline-explore.json` and `baseline-general.json` are the immutable baseline rerun: the revised harness at `44d81a5be` drove a separate, dependency-installed checkout at exactly `bdec3b29e`. All eight cells were valid. Explore measured $0.0645 cold / $0.0258 second-session for Vector and $0.2137 / $0.1037 for Claude Code; General measured $0.0681 / $0.0245 and $0.2213 / $0.1005 respectively. The later `baseline-*-verified.json` reruns use the same request-generating scripts with the stricter successful-verification receipt check and are the selected baseline cells for the final comparison.

`router-smoke-invalid.json` preserves an early harness validation failure: the actor router incorrectly required a task ID from foreground results, although Claude Code returns the report directly. The operation scripts and fixture checks completed, but those cells were invalid under that router. The router now requires IDs only for background launches. They must not be selected as final comparison evidence.

## Final matched results

The selected final reports are `final-*-attempt-2.json`, pinned to clean source `947d8ca859103504351d0073363951b6de9122a4`. This merge includes integration `f99cbc4f1`: the final task-management provider schema, cancellation and relay fixes, internal foreground command fix, Node-compatible repeated-output digest, artifact cleanup, and CLI cost regressions. Its Engine, Core, Schema, and executable footprint harness match integration `f99cbc4f1`. The later integration merge `7fc99001a` adds account/marketing changes with no changes to those runtime or request-generating paths.

All **12 final Vector cells** are valid under the scripted fixture protocol. Baseline `bdec3b29e` uses the same request-generating harness and strict verification receipts in `baseline-*-verified.json`. The **12 Claude Code cells** are reused from `candidate-*-attempt-1.json`: the executable harness, fixture operations, frozen rates, CLI version, and cache simulation are unchanged. Bun was 1.3.14 and Claude Code was 2.1.215. These are paired scenario comparisons, not simultaneous runs or live-model measurements.

Post-study follow-ups through `8a909b79a` add Windows path handling, private Bun configuration materialization, rejected-request CLI teardown, browser CSP hashing, and config-source trust checks for filesystem aliases. The footprint harness and task/provider schemas are unchanged. Its successful macOS fixtures use inline configuration and do not exercise the alias or rejected-request paths. The archived measurements remain measurements of `947d8ca85`, not of these follow-up commits; no matrix was rerun for them. See the [validation record](validation.md) for separate test and build evidence.

Every dollar below is a modeled offline estimate. Each pair is **cold / second session** within a fresh simulated-cache run. Request counts are the same in both sessions of each selected cell pair.

| Scenario | Vector before | Vector final | Claude Code | Final requests, Vector / Claude |
| --- | ---: | ---: | ---: | ---: |
| Foreground Explore | $0.064479 / $0.025787 | $0.069746 / $0.027384 | $0.213727 / $0.103717 | 8 / 8 |
| Foreground General | $0.068077 / $0.024535 | $0.074975 / $0.026182 | $0.221268 / $0.100459 | 8 / 8 |
| Concurrent readers | Unavailable in this control protocol | $0.090900 / $0.048538 | $0.273633 / $0.152177 | 13 / 13 |
| Dependency handoff | Unavailable in this control protocol | $0.103823 / $0.046184 | $0.287256 / $0.154997 | 13 / 13 |
| Steer in flight | Unavailable in this control protocol | $0.086853 / $0.038060 | $0.219759 / $0.112285 | 10 / 9 |
| Stop in flight | Unavailable in this control protocol | $0.074233 / $0.031871 | $0.205239 / $0.108563 | 8 / 8 |

The controls increase the matched foreground estimate: Explore rises **8.2% cold / 6.2% second-session** and General **10.1% / 6.7%**. Request counts stay unchanged. The parent's stable system/tool prefix grows by approximately **1,064 estimated tokens**: system context rises from 3,487 to 3,575 and tools from 5,443 to 6,419. The unchanged 97-token initial message gives first-request input of 9,027 before and 10,091 after. The task definition grows from 1,685 to 2,203 tokens, and `task_manage` adds 458 tokens. General children also receive the 458-token management definition; Explore's read-only tool set and prefix stay unchanged. This upgrade does not establish a cost reduction against the previous Vector implementation.

For the new workflows, the old engine lacks `task_manage`; those baseline cells were not run and have no equivalent completion/cost result. The new cells verify useful behavior, not a lower cost against an unavailable baseline. Dependency adapters differ as described below, and Claude Code's prerequisite-wait turn is counted. Vector's completion-notification responses are also counted, including the extra request in the steering case. Small input differences between sessions reflect interleaving and notification timing. No result here supports a live cheaper/faster claim or passes the historical model-behavior gate.

## Retained attempts and schema validation

`candidate-*-attempt-1.json` pins `bcce917eb`, a clean merge of integration candidate `287b0fc43` with the strict harness and baseline archives. All 24 candidate cells satisfied the scripted fixture protocol. Those Vector cells are superseded by the final reports; their Claude Code cells remain the matching comparator described above.

`final-*-attempt-1.json` pins `1616de5756afce9fc1131130fb9933943eae26b9`, which includes integration `a41ac1f61`. All 12 Vector cells satisfied the scripted fixture protocol. A subsequent review found that the provider's projection of the top-level `task_manage` union advertised only the first action, `list`. The scripted provider could still emit the other valid tool calls, so passing fixture scripts did not prove that a real model could discover those actions from the advertised schema. This is why attempt 1 remains archived but is not the selected final footprint.

Integration `f99cbc4f1` replaced that public union with a flat object while preserving strict runtime validation. A separate actual-registered-tool regression checks all five actions in the OpenAI Chat, OpenAI Responses, and Anthropic wire schemas and rejects nine malformed runtime payloads. The final matrix was rerun after that correction; the management definition shrank from 519 to 458 estimated tokens. Scripted execution checks and provider-schema checks establish different properties; neither establishes live model quality.

The final dependency case contains 13 requests per session versus 12 in the earlier candidate. The additional completion-notification request is retained and charged in the final estimate. No earlier or failed attempt was discarded or replaced to improve the selected result.

## Revised scenarios

- `delegate-explore` and `delegate-general`: the original foreground workloads with explicit mode selection.
- `delegate-multi`: two concurrent background readers, event-driven waits, then a parent fix and independent verification.
- `delegate-dependency`: a reader hands its finding to a dependent editor, then the parent verifies. Vector uses its dependency edge; Claude Code's adapter waits for the prerequisite and passes the observed result into the next brief. This topology difference is declared and all its turns are counted.
- `delegate-steer`: hold one synthetic provider response until the parent receives a message-admission receipt; the child's next request must actually contain the correction. Then complete and independently verify.
- `delegate-stop`: stop a reader while its second provider request is in flight, retain the first read, then finish and verify in the parent. The interrupted response contributes input but no generated output to the estimate.

The fake provider routes independent scripts by each child's original brief and observed session identity. It does not use a global step cursor or identify children by a different toolset. Barriers are event-driven, with no status polling or model-generated waiting turns. Parent and child operations can interleave freely. Every request, including side/title requests and extra notification turns, contributes to the report.

A cell is valid only if the CLI exits successfully, all required script steps are consumed, management tools succeed, required dependency/steer evidence reaches the child, every scripted success-verification step returns a passing test receipt, the independent fixture tests pass, and protected test files are unchanged. The fixture's initial failing test is explicitly allowed. The `baseline-*-verified.json` reruns use this stricter receipt check; earlier archives are retained. Invalid cells remain in the JSON, and the harness exits unsuccessfully. Missing runtime adapters are unavailable, not zero-cost successes. The Codex inline delegate adapter remains a different topology and the new management scenarios are unavailable there.

## Reproduction

Use two clean source checkouts with dependencies installed, one at `bdec3b29e` and one at final source `947d8ca85` (integration `f99cbc4f1` runtime-equivalent). Keep the harness checkout fixed while changing only `--engine-root`. Run one command at a time on an idle machine for reproducible timing. The final archived matrix ran serially alongside the early portion of an engine test suite, so its timing and RSS are diagnostic only. Each report records source revisions, CLI versions, frozen rates, request counts, logical actor counts, validity and fixture verification.

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

Machine load exceeded 25 during part of development, and the final matrix shared the machine with an engine test run. Timing/RSS samples in these archives are diagnostic only; no speed or memory advantage is claimed. The owner-run checks are in `script/agent-eval/live-efficiency.md`.
