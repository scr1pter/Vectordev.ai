# OpenRouter free access — owner actions

Decision: use each user's own free OpenRouter account for the upcoming **1.99.99** release. Personal free-model discovery and setup work independently of `FREE_MODELS_ENABLED=false`. Leave the shared service off; do not add a shared key, activate KV for this feature, or purchase credits. The currently downloadable desktop **1.99.8** does not include this guarded setup.

No account was created, terms accepted, purchase made, key read, privacy setting changed or message sent by the implementation agent. Account-specific endpoint viability has **not** been verified. The candidate snapshot below was checked on 25 September 2026; it is not a promise of current availability.

On 2 October 2026, OpenRouter's [pricing page](https://openrouter.ai/pricing) listed Data Policy-Based Routing as unavailable on Free, while its [per-request ZDR documentation](https://openrouter.ai/docs/guides/features/zdr#per-request-zdr-enforcement) described `provider.zdr` without an account-tier qualification. These sources do not establish whether an unfunded account can use Vector's `data_collection: "deny"` and provider-list constraints. (Since 15 October 2026 included models no longer request `zdr: true`; see below.) Public endpoint metadata and passing fixture tests do not resolve that entitlement question. Keep the guards intact and treat rejected requests as unavailable; purchasing credits or upgrading is not an acceptable workaround.

## No-training policy: owner steps (15 October 2026)

The included-models policy changed from zero data retention to no training: providers may retain prompts under their own policies but must not train on them. Included and personal requests send `data_collection: "deny"`, the allowlisted provider `only` list, `require_parameters: true` and a zero `max_price`, and no longer send `zdr: true`. The allowlist names each model with the provider that may serve it: Cohere for North Mini Code and AtlasCloud for Dots3-Note Preview (see [No-training evidence per model](#no-training-evidence-per-model)). NovitaAI and ModelRun serve no free model today and were dropped until they are re-reviewed. Poolside is excluded because OpenRouter's free Laguna pages say free use may train on inputs. Codium is unchanged and still requests `zdr: true` on every request, so an account-wide ZDR setting is not needed for it.

In the OpenRouter account behind `OPENROUTER_FREE_API_KEY` (its privacy and provider-routing settings; the labels below are approximate):

1. Turn **off** the account-wide "ZDR endpoints only" restriction. With it on, OpenRouter refuses every included model, because none of their endpoints is zero data retention.
2. Keep training **disabled** for both free and paid endpoints ("may train on inputs" off), and keep "may publish prompts" off. Each request already sends `data_collection: "deny"`; these account settings are a second guard.
3. Keep prompt and input/output logging **off**, and keep OpenRouter's own use of inputs off.
4. Make sure Cohere and AtlasCloud are not ignored providers. If the account has an allowed-providers list, it must include `cohere` and `atlas-cloud`; OpenRouter answers 404 when an account allowlist and a request-level `only` list do not overlap.
5. Keep the account unfunded: no credit purchase, payment method, automatic top-up or BYOK provider key.

Before deploying, complete the per-model confirmations in [No-training evidence per model](#no-training-evidence-per-model). After deploying, force a refresh instead of waiting for the 03:17 UTC cron: in Vercel open the project → Settings → Cron Jobs and choose **Run** on `/api/free-models/refresh`, or send `GET https://vectordev.ai/api/free-models/refresh` with the header `Authorization: Bearer <CRON_SECRET>`. A good answer is `{"enabled":true,"updatedAt":…,"count":2}`. Then `https://vectordev.ai/api/free-models/models` should list `cohere/north-mini-code:free` and `dots-studio/dots-3-note-preview:free`. If nothing qualifies, the refresh publishes `{"enabled":false}` and the app hides the section. Finally send one harmless prompt to each model from a signed-in desktop and confirm it answers and the account balance is unchanged. A refusal shows "temporarily unavailable" and never falls back to a paid endpoint; if that happens, recheck steps 1 to 4. One unreadable endpoint list drops only that model from a refresh; a failed `/models` or `/models/user` read keeps the stored catalog and answers 503.

## No-training evidence per model

OpenRouter's public endpoint and provider data has no training field, and provider-level records do not describe free endpoints reliably: the 25 September records listed Poolside as not training, while its free Laguna pages say free use may train on inputs. The allowlist (`NO_TRAINING_ENDPOINTS` in `packages/core/src/free-model-catalog.ts`) therefore names each model with the provider that may serve it, and a new free model is never offered until it is added. `data_collection: "deny"` remains a second guard, but it rests on OpenRouter's own data-policy records.

| Model                                  | Provider                   | Evidence recorded on 15 October 2026                                                                                                                                                                                                                                                   | Owner confirmation before deploy                                                                                       |
| -------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `cohere/north-mini-code:free`          | Cohere (`cohere`)          | Public endpoint list: one endpoint, tag `cohere`, zero price, tools, no training field. Provider-level record of 25 September (its source now returns 404): no training, retention up to 30 days. No check of this model's free terms is recorded.                                     | Open: confirm this model's free terms, and that OpenRouter-specific terms override any conflicting older linked policy |
| `dots-studio/dots-3-note-preview:free` | AtlasCloud (`atlas-cloud`) | Public endpoint list: one endpoint, tag `atlas-cloud/fp8`, zero price, tools, no training field; free until 31 December 2026. Provider-level record of 25 September (its source now returns 404): no training, retention unspecified. No check of this model's free terms is recorded. | Open: confirm this model's free terms and retention                                                                    |

A text fetch of OpenRouter's public model pages on 15 October 2026 showed no data-policy statement for either model, but it showed none for Laguna S 2.1 either, so such a fetch is not evidence either way. Before deploy, open each model's free page on OpenRouter and the provider's terms in a browser, look for any statement that free use may train on inputs or outputs, and record the date and result in this table. Remove a pair whose free use may train. To add a model later, record the same evidence here first, then add its pair to `NO_TRAINING_ENDPOINTS`. Until the confirmations are recorded, public copy says "on Vector's allowlist", never "reviewed".

## Selected setup: personal free accounts

1. Each user connects their own OpenRouter account through **Connect OpenRouter** in Vector, saves their API key in Settings → Providers, or sets `OPENROUTER_API_KEY` in the engine environment. A project-only `provider.openrouter.options.apiKey` value is insufficient for guarded free access; migrate it to the provider connection or environment without committing or printing it. A shared Vector account or shared OpenRouter credential is not needed for model routing. See [connection instructions](../FREE-MODELS.md).
2. Keep that OpenRouter account free: no credit purchase, payment method, automatic top-ups, paid upstream provider keys in OpenRouter's BYOK settings, or default/enforced paid plugins. Check the account's settings directly; Vector cannot remove account-level payment arrangements on the user's behalf.
3. Select an eligible model under **Free models inside of Vector → Your OpenRouter account**. The scope is the allowlisted explicit `:free` models with online, tool-capable, zero-price endpoints from the provider allowlisted for each, read from each model's public `/api/v1/models/{author}/{slug}/endpoints` list. Discovery matches model ID and endpoint tag. It is not a list of every free model.
4. Keep zero-price routing, `data_collection: "deny"`, the allowlisted provider list, and the protections against paid plugins and paid model/provider fallbacks. Missing eligibility, an unavailable endpoint, and exhausted limits must stop the request. Do not relax the constraints to make a request succeed.
5. OpenRouter currently lists up to 50 requests/day and 20 requests/minute without buying credits. A coding task can require many requests. Wait for a reset when limits are reached; do not purchase a higher allowance or create accounts to evade limits. See the [current upstream policy](https://openrouter.ai/docs/api_reference/limits).
6. Review the user's OpenRouter privacy settings and downstream policies. Providers may retain prompts and outputs under their own policies; Vector requests that they are not used for training. This routing restriction does not cover Vector's local history, OpenRouter account logging, or every external tool/service. An account restricted to ZDR endpoints only gets no included models, because none of their endpoints is zero data retention. Keep other independently configured providers/tools distinct from free model access.

Before describing personal access as verified, the owner must exercise the reviewed candidate with their own unfunded account and an eligible model. Confirm that a harmless prompt succeeds under the unchanged privacy and zero-price constraints, and that the account balance is unchanged. Report only the model ID, success or rejection, and the balance result; keep credentials and request headers private. A rejection keeps live availability unverified and must not trigger paid routing, a credit purchase, or relaxed privacy settings.

## Optional future shared service — not part of this activation

The remaining checklist is retained for a separately authorized future shared allowance. It is not a prerequisite for personal access and does not authorize any service activation, expenditure, or message. The shared catalog's legacy `/api/frontend/all-providers` metadata source returned HTTP 404 on 2 October 2026. Repair and revalidate that dependency before considering activation; the personal no-training selection does not depend on it.

1. Create or select the single OpenRouter account owned by Vector. Do not create extra accounts or keys to evade account limits.
2. Keep the account unfunded with no payment method, automatic top-ups, paid plugins, or paid upstream BYOK credentials. A credit purchase is not authorized. Confirm the actual free account limits with `/api/v1/key` without making an inference request.
3. In that account's privacy settings, disable training for paid and free models, OpenRouter use of inputs, and prompt/chat logging. Keep the settings private; record that they were checked, never a screenshot containing a key.
4. Send the draft below and obtain written confirmation for the shared, no-charge allowance, the applicable provider terms, and any account exemption or enterprise agreement. The code remains off until this is resolved. This is a legal review gate, not a claim that the feature is forbidden.
5. Add `OPENROUTER_API_KEY` to the Vercel server environment. Add the existing KV/Upstash URL/token, `VECTOR_ABUSE_SECRET`, `VECTOR_CLI_TOKEN_SECRET`, account configuration and `CRON_SECRET` there. Do not put any value in Git, an app build, a ticket, a URL or a support reply. Use the existing desktop/account setup in [desktop-cli-vault.md](desktop-cli-vault.md).
6. Choose `FREE_MODELS_DAILY_PER_USER` and optionally `FREE_MODELS_MINUTE_PER_USER` within the verified free account allowance. A coding task consumes multiple model requests, so these would be onboarding allowances, not task guarantees. Failed admitted requests can consume a local fairness counter.
7. Approve the separate legal-copy draft. Prompts, code and tool output travel to OpenRouter and its chosen endpoint. No-training and no-retention are different claims; do not promise zero retention for every candidate.
8. In a controlled deployment, enable the flag, invoke the authenticated refresh route, inspect the resulting public catalog, and run the harmless acceptance below. The daily cron is 03:17 UTC. Catalogs expire after 30 hours; absence, staleness, invalid metadata or unavailable KV fails closed.
9. Only after a separate owner decision and passing checks, deploy the reviewed shared configuration. If any check fails, keep `FREE_MODELS_ENABLED=false`; the shared endpoint returns an empty catalog. The guarded personal OpenRouter section and connection methods continue to work independently.

## Future shared-service acceptance with the actual account

This is not part of the current personal-account rollout. If a shared pilot is separately authorized, run it locally under the owner's control; report only model IDs, HTTP status, endpoint availability, reset times and whether the balance changed. Never send the implementation agent a key or request headers.

- Confirm `/api/v1/models/user` includes each selected free model after privacy settings are applied.
- Submit a harmless text/tool-calling prompt with `data_collection: "deny"`, the curated provider allowlist and zero `max_price` for prompt, completion, request and image. Test each candidate; remove any with no eligible endpoint. Do not relax the privacy or price constraints to make it pass.
- Confirm model fallbacks remain within the returned free catalog and no paid model, paid plugin or generated-media route is requested. Verify before/after balance with the account UI.
- Check the public `/api/free-models/models` response includes no key. Test a signed-in desktop, `vector run`, TUI and Vectorscope using a deliberately small local cap.
- At the cap, verify reset time and Connect OpenRouter. Complete PKCE on the user's own account, continue the same conversation, and confirm the shared counter is no longer used. Disconnect and confirm the user key is removed.
- Test missing KV, revoked Vector identity, expired catalog, upstream 402/429 before and during streaming, cancellation, and OFF after an earlier ON session. These paths also have isolated automated coverage; this step validates the actual deployed configuration.

## Historical shared candidates and unresolved provider coverage

The 25 September 2026 snapshot contained 22 models with zero prompt/completion prices, 14 explicit free variants with both tools and tool choice, and 7 candidates after exclusions. This historical shared-catalog snapshot is not the current selection or a claim that shared refresh currently works. Its legacy metadata dependency remains unresolved.

| Candidate                  | Endpoint   | Public policy metadata                      | Owner review                                                                                              |
| -------------------------- | ---------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Cohere North Mini Code     | Cohere     | No training; retention up to 30 days        | Confirm OpenRouter-specific terms override any conflicting older linked policy                            |
| Laguna S 2.1 / XS 2.1      | Poolside   | No training; retention duration unspecified | Excluded since 15 October 2026: free use may train on inputs                                              |
| Qwen3.8 27B                | ModelRun   | No training or prompt retention             | Confirm third-party use is covered by the OpenRouter arrangement; off the allowlist since 15 October 2026 |
| Dots3-Note Preview         | AtlasCloud | No training; retention duration unspecified | Confirm terms and retention                                                                               |
| Ling 3.0 Flash Sante / Fin | NovitaAI   | No training or prompt retention             | Confirm applicable commercial model/provider terms; off the allowlist since 15 October 2026               |

The historical shared catalog excluded NVIDIA, Stealth, Thinking Machines, Liquid and Google endpoints. The exact tier behind Google's free endpoints was not established, so that exclusion was conservative. Unknown endpoint policies were also excluded. These observations are not current personal-routing rules or a substitute for a future shared-service coverage review.

## Ready-to-send draft — not sent

Subject: Written confirmation for a no-charge free-model allowance in Vector

Hello OpenRouter team,

Vector is a commercial desktop coding agent with a CLI. We want to offer a small, no-charge onboarding allowance using only your explicit free model variants, followed by your PKCE connection flow so users continue directly on their own OpenRouter accounts. We do not sell this allowance, expose a general-purpose public API, or route it to paid models. The shared route requires a Vector account, applies persistent per-user limits, and respects the account-wide allowance.

Please confirm whether this arrangement is permitted under sections 5 and 7 of your terms and whether an Enterprise Access Agreement is needed. Is an exemption or higher free-account limit available for this use case? We will not create additional accounts to avoid limits.

We disable training and logging, set `data_collection: "deny"`, and restrict routing to reviewed zero-price endpoints. Please confirm which provider terms cover commercial end-user access for Cohere, Poolside, ModelRun, AtlasCloud and NovitaAI, including any differing retention policies. We would also appreciate clarification on the tier and data policy used by Google's free endpoints, which are currently excluded.

Please identify any required end-user notices or flow-down terms. We can provide our proposed notices before activation.

Thank you,
Vector

## Sources

- [OpenRouter terms](https://openrouter.ai/terms), updated 31 August 2026: sections 5, 6.2 and 7 require the coverage and logging review above. Section 7 includes “reselling API access to Models”.
- [Enterprise terms](https://openrouter.ai/terms-of-service-enterprise): separate signed-order coverage must be confirmed by OpenRouter.
- [Limits and account counters](https://openrouter.ai/docs/api_reference/limits): free account capacity and 402/429 behavior.
- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection): privacy, provider allowlists and zero-price ceilings.
- Per-model endpoint list, `https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints`: current discovery source for included and personal models, matched by model ID and endpoint tag. It is public and does not publish a training flag, hence the per-model allowlist.
- [Public models API](https://openrouter.ai/api/v1/models): current model metadata. The historical shared candidate snapshot used `/api/frontend/all-providers`, which now returns 404; it is not a working source for this rollout.
- [Google API terms](https://ai.google.dev/gemini-api/terms), [Modular terms](https://www.modular.com/legal/terms), [Cohere terms](https://cohere.com/terms-of-use), [Poolside legal](https://poolside.ai/legal), [AtlasCloud privacy](https://www.atlascloud.ai/privacy), [Novita terms](https://novita.ai/legal/terms-of-service): provider review inputs, not legal approval.
