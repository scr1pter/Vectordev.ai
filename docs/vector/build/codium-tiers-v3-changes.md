# Codium tiers: changes on 27 Oct 2026 (supersede v2 where they conflict)

## 1. Why Claude Sonnet 5.5 and Opus 5.5
They were the Claude options in v2, so the top two paid plans include a Claude model. Sonnet is the middle Claude model on Max, and Opus is the largest on Ultra. Both have zero-data-retention (ZDR) routes on Vertex and Bedrock, as of 27 Oct. The owner has not yet approved them; Decision 5 in v2 still stands.

## 2. Add GPT-6 Astra to Max and Ultra
- Max: Astra added alongside Sonnet 5.5 and Sol Deep.
- Ultra: Astra added alongside Opus 5.5 and Sol Deepest.
- Status: NOT VERIFIED. The owner says OpenRouter gives ZDR for everything. On 27 Oct I checked the OpenRouter ZDR list and found no entry for GPT-6.1 Terra, and GPT-6.1 Sol had ZDR only on Azure. So before Astra is listed, confirm on https://openrouter.ai/api/v1/endpoints/zdr that it has a ZDR route, and record its price, context and hold. Until then it stays off the public page.

## 3. Remove top-ups
- No top-up purchases at launch.
- Consequence: the v2 perk "a top-up unlocks Sol, Kimi or Argon on Plus" is removed. Plus users who want Sol must move to Pro.
- Consequence: any model-usage rule that mentions top-up credits no longer applies.

## 4. More than model access
The owner's point: anyone can resell model access, and Vector is not a model company, so the plans need perks that are Vector's own. Current non-model perks: cloud agents (Max, Ultra), scheduled cloud runs, automatic PR reviews (Plus+), Second opinion (Pro+), Vector Labs and early releases (Ultra), first access to Vector Velocity (Max, Ultra), priority queue (Max+).

Candidates still to price and choose (none built):
- Roadmap voting: Max and Ultra vote on the next features. Near-zero cost.
- Vector Brain capacity: more learned skills and longer memory on paid plans. Low cost, local storage.
- Priority queue for cloud agents on Max and up. Low cost.
- Premium desktop themes and keybind packs. Near-zero cost, cheap to build.
- Ultra only: a short onboarding call each month. Costs the owner time, so cap it.
- Founder-named badge and profile mark for Founding members. Near-zero cost.

Rule: every perk must be something Vector can give without paying a model provider for it, or it must be priced into the plan's usage.

## 5. Open items
- Verify Astra's ZDR route, price and context (see section 2).
- Confirm Sonnet and Opus routes (already found, see section 1; re-check before launch).
- Choose which section 4 perks to build.

## 6. Owner decision, 27 Oct (later): @vector on Codium for every plan
- @vector (and /vector) in GitHub runs on Codium for every paid plan: Plus, Pro, Max and Ultra. No API key or repo secret is needed on any plan.
- Free users can still use @vector with their own API key as a repo secret (GitHub's computers are never sold).
- Max and Ultra add more: more runs at once, longer runs, scheduled overnight runs, the premium models (Sonnet/Opus/Astra), and the cloud-agent hours in the v3 table.
- The Codium usage of @vector runs comes out of the plan's normal percentage, with the plan's normal caps.
- Default trigger: "@vector" alongside "/vector" and "/vs" (the bot handle depends on the GitHub App name the owner registers).

## 7. Owner decision, 27 Oct (latest): @vector is the cloud-agents feature, limited per plan, built by Codex
- @vector is part of Codium's cloud agents and is limited per plan. Proposed defaults: Plus 5 h/mo (1 at once, 30-min runs), Pro 15 h (1, 45 min), Max 40 h (2, 45 min, 5 scheduled/day), Ultra 120 h (6, 120 min, 20 scheduled/day). Free works only with the user's own key.
- The owner hands the @vector build (GitHub triggers, workflow generator, run tokens, Run in GitHub from the app, scheduled runs, docs) to a Codex session on branch `vector-at-mention`. Brief: the session folder's codex-vector-mention-prompt.md.
- Claude's Codium build must NOT build the @vector/GitHub cloud-agent pieces. It keeps the entitlements, gateway, billing pipeline and the rest. Codex reads the plan through a new api/_lib/cloud-agents-entitlement.ts, which the Codium entitlements module should later back.
