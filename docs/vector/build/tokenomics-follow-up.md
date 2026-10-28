# Tokenomics follow-up

Checked on 2026-10-28 against `main` at `b3669a6b`, using the remaining-work list in `self-evolving:docs/vector/build/tokenomics-audit.md`. This record distinguishes an instruction fix from work that still needs evidence. It makes no speed, cost, or cache-hit claim.

## Implemented

Standard task-size guidance no longer asks for a to-do list merely because work has multiple steps. It now reserves tracking for substantial milestones or a user-requested plan. This agrees with the existing `todowrite` policy, which says that routine investigation, editing, verification, or multiple files alone do not justify tracking.

Files: `packages/core/src/task-size.ts` and the existing regression coverage in `packages/core/test/task-size.test.ts`. Light still skips tracking; Thorough still plans with the to-do list. Task classification and available tools are unchanged.

Validation: the focused task-size file passes all 19 tests (452 assertions), run from `packages/core` with `bun test --timeout 30000 test/task-size.test.ts`. This checks instruction and classification behavior, not model token savings.

## Remaining evidence and decisions

| Audit recommendation | Current state and next gate |
| --- | --- |
| First-request cache reuse | The API-key path already puts stable prompt parts first in one system block (`packages/engine/src/session/llm/request.ts`). Check a release build's first-request cached-token counts across two sessions before changing serialization. Offline estimates cannot establish real cache hits. |
| Paid cache warm-up and 24-hour retention | Neither is enabled by this follow-up. Warm-up adds a model request; retention depends on provider/model support and changes the caching policy. Define supported models and the intended opt-in/configuration behavior before implementation. Do not silently add spend. |
| Shorter task descriptions and reduced narration | The audit requires a live behavior check before further prompt trimming. Preserve the current delegation and completion rules until that check has a result. |
| API-key WebSocket rollout and incremental tool definitions | Production remains on its existing transport default. Validate provider compatibility, reconnection, complete tool availability, and release-path behavior before changing it. Upload-byte savings alone do not establish model-cost savings. |
| Desktop session titles | The app creates a session without a title; the engine sets a provisional title and later may generate one. Removing that model call needs an explicit title policy and the app's required before/after session baseline. |
| Node startup preconnection and stream stalls | Node-compatible connection warming and bounded cloud-stream inactivity handling still need transport-level design and tests. Do not introduce duplicate provider requests or retry partially completed tool work. |
| Memory | Profile the current desktop/release build. Old offline measurements are not a baseline for this build. |
| Default effort, cheaper subagent models, reasoning retention | Keep existing behavior pending matched quality/cost measurements and the separate multi-agent work. The audit does not establish that lower effort is cheaper. |
| Published CLI | Publishing remains an owner action; a source change cannot update the installed CLI. |

The cheapest next evidence is a scoped offline request-footprint run, followed by owner-budgeted live cache and behavior checks. Preserve the API, release channel, task size, model, and effort in each report. Do not present an offline replay as a live quality or performance result.
