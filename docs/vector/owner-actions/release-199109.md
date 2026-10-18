# Desktop 1.99.109: owner steps

Desktop 1.99.109 builds from one main commit, like every release. The npm CLI stays at 1.99.99 (`vectorRequiredCliVersion`), so Windows WSL servers keep the 1.99.99 engine and GitHub reviews keep running CLI 1.99.99 until you publish a new CLI.

## Before you release the desktop

1. **The website deploys with the push to main.** Desktop 1.99.109 needs it: the in-app billing window and in-app account deletion call new vectordev.ai routes, and the free-model catalog moves to `vector:free-models:catalog:v4:policy`. Wait for the Vercel deploy of the release commit to finish.
2. **Refresh the free models.** Vercel, Settings, Cron Jobs, **Run** on `/api/free-models/refresh`. Expect `"enabled": true` with about 9 models: North Mini Code, Dots3-Note Preview and Xing4.0 (no training), the may-train ones (Laguna S and XS, LFM2.5, Inkling, Inkling Small) and the Free Models Router. Then check:
   - `https://vectordev.ai/api/free-models/models` lists no-training models only (what 1.99.108 and CLI 1.99.99 see);
   - `https://vectordev.ai/api/free-models/models?disclosure=may-train-v1` adds the may-train ones.
3. **Free-model limits in Vercel (Production):** `FREE_MODELS_DAILY_PER_USER=50`, `FREE_MODELS_MINUTE_PER_USER=10`, then redeploy. The account-wide limit is 1,000 free requests a day because $10 of credits was bought; keep that OpenRouter account's balance from ever going negative (no auto top-up, no card, no paid BYOK keys, no paid plugins).
4. **OpenRouter privacy settings** (the account behind `OPENROUTER_FREE_API_KEY`): free models from providers that may train ON; paid models that may train OFF; providers that may publish prompts OFF; "ZDR endpoints only" OFF; prompt logging OFF. Do not ignore cohere, atlas-cloud, poolside, liquid, thinkingmachines or phala. Optionally ignore nvidia.
5. **Legal review.** The privacy policy and terms (dated October 17, 2026) now describe free models that may train, the shared allowance, and say "repository" for local files. Review them before the release is announced.

## After the release

6. **Try it.** In a signed-in 1.99.109: say "hi" (one short reply, no tools), ask for a small change (it just does it), send one prompt each to a no-training free model, a may-train model (accept the notice) and the Free Models Router, and confirm the OpenRouter balance does not change.
7. **Stripe, when you connect it** (test mode first): run `bun scripts/setup-model-plans.ts`, then `--apply`, from `packages/web`, and put the printed `STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID` in Vercel beside the other Stripe values. Follow `codium-payments.md` for the test run. `MODEL_PLANS_ENABLED` stays false until then.
8. **CLI.** GitHub reviews, the terminal and WSL servers get the Vectorscope fixes, task sizing, the free-model consent flags and the shell checks only with a new CLI release (npm needs your 2FA). Publishing it is a separate decision.
9. **CI with Redis.** `packages/web/test/free-models-api.test.ts` runs in `vector-free-models.yml`; it could not run locally.

## Changes people will notice

- Per-repository spend caps are gone: one overall limit per run, day and month. A repository's own `budget.run` is ignored with a one-time notice.
- Settings lost Project rules, Appearance, Editor, Chat, Voice and Personalization. Vector is always dark and follows the computer's language; anyone on Light switches to dark.
- A repository with its own settings asks once whether to trust it; clones ask, repositories created in Vector do not.
