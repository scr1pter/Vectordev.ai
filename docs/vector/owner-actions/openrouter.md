# OpenRouter activation — owner actions

Status: built behind `FREE_MODELS_ENABLED=false`; production activation is pending the actions below. No account was created, terms accepted, purchase made, key read, privacy setting changed or message sent by the implementation agent. Account-specific endpoint viability has **not** been verified. The public metadata was checked on 25 September 2026.

## Checklist

1. Create or select the single OpenRouter account owned by Vector. Do not create extra accounts or keys to evade account limits.
2. Decide whether to make the optional one-time $10 credit purchase. This is not a request to fund model usage: these routes only permit zero-price models and endpoints. Without that historical purchase, the published allowance is 50 requests/day; with it, 1,000/day, subject to OpenRouter's current account rules. Both have a 20 requests/minute limit. Confirm the actual account values with `/api/v1/key`.
3. In that account's privacy settings, disable training for paid and free models, OpenRouter use of inputs, and prompt/chat logging. Keep the settings private; record that they were checked, never a screenshot containing a key.
4. Send the draft below and obtain written confirmation for the shared, no-charge allowance, the applicable provider terms, and any account exemption or enterprise agreement. The code remains off until this is resolved. This is a legal review gate, not a claim that the feature is forbidden.
5. Add `OPENROUTER_API_KEY` to the Vercel server environment. Add the existing KV/Upstash URL/token, `VECTOR_ABUSE_SECRET`, `VECTOR_CLI_TOKEN_SECRET`, account configuration and `CRON_SECRET` there. Do not put any value in Git, an app build, a ticket, a URL or a support reply. Use the existing desktop/account setup in [desktop-cli-vault.md](desktop-cli-vault.md).
6. Choose `FREE_MODELS_DAILY_PER_USER` and optionally `FREE_MODELS_MINUTE_PER_USER`. If omitted, the daily default is one tenth of the verified account limit, rounded down, with a minimum of 1 and maximum of 20; that is 5 on a 50/day account and 20 on a 1,000/day account. The minute default is 4. A coding task consumes multiple model requests, so these are onboarding allowances, not task guarantees. Failed admitted requests can consume a local fairness counter.
7. Approve the separate legal-copy draft. Prompts, code and tool output travel to OpenRouter and its chosen endpoint. No-training and no-retention are different claims; do not promise zero retention for every candidate.
8. In a controlled deployment, enable the flag, invoke the authenticated refresh route, inspect the resulting public catalog, and run the harmless acceptance below. The daily cron is 03:17 UTC. Catalogs expire after 30 hours; absence, staleness, invalid metadata or unavailable KV fails closed.
9. If every check passes, deploy the same reviewed code/configuration to production. If any check fails, set `FREE_MODELS_ENABLED=false`; the public endpoint returns an empty catalog and the free-model section disappears. OpenRouter PKCE and ordinary API-key providers continue to work independently.

## Owner-run acceptance with the actual account

Run this locally under the owner's control; report only model IDs, HTTP status, endpoint availability, reset times and whether the balance changed. Never send the implementation agent a key or request headers.

- Confirm `/api/v1/models/user` includes each selected free model after privacy settings are applied.
- Submit a harmless text/tool-calling prompt with `data_collection: "deny"`, the curated provider allowlist and zero `max_price` for prompt, completion, request and image. Test each candidate; remove any with no eligible endpoint. Do not relax the privacy or price constraints to make it pass.
- Confirm model fallbacks remain within the returned free catalog and no paid model, paid plugin or generated-media route is requested. Verify before/after balance with the account UI.
- Check the public `/api/free-models/models` response includes no key. Test a signed-in desktop, `vector run`, TUI and Vectorscope using a deliberately small local cap.
- At the cap, verify reset time and Connect OpenRouter. Complete PKCE on the user's own account, continue the same conversation, and confirm the shared counter is no longer used. Disconnect and confirm the user key is removed.
- Test missing KV, revoked Vector identity, expired catalog, upstream 402/429 before and during streaming, cancellation, and OFF after an earlier ON session. These paths also have isolated automated coverage; this step validates the actual deployed configuration.

## Current candidate set and unresolved provider coverage

The live public catalog contained 22 models with zero prompt/completion prices, 14 explicit free variants with both tools and tool choice, and 7 candidates after exclusions. Expired preview IDs from the earlier brief are no longer selected. This is a dated observation; daily refresh computes the current list.

| Candidate                  | Endpoint   | Public policy metadata                      | Owner review                                                                   |
| -------------------------- | ---------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| Cohere North Mini Code     | Cohere     | No training; retention up to 30 days        | Confirm OpenRouter-specific terms override any conflicting older linked policy |
| Laguna S 2.1 / XS 2.1      | Poolside   | No training; retention duration unspecified | Confirm commercial end-user coverage and retention                             |
| Qwen3.8 27B                | ModelRun   | No training or prompt retention             | Confirm third-party use is covered by the OpenRouter arrangement               |
| Dots3-Note Preview         | AtlasCloud | No training; retention duration unspecified | Confirm terms and retention                                                    |
| Ling 3.0 Flash Sante / Fin | NovitaAI   | No training or prompt retention             | Confirm applicable commercial model/provider terms                             |

NVIDIA, Stealth, Thinking Machines, Liquid and Google endpoints remain excluded. Google's unpaid-service terms permit use of submitted content for product improvement; the exact tier behind the free endpoints was not established, so exclusion is conservative. An unknown endpoint policy is also excluded. Public metadata is not a substitute for the written coverage review.

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
- [Public models API](https://openrouter.ai/api/v1/models) and [provider-policy metadata](https://openrouter.ai/api/frontend/all-providers): dated candidate data.
- [Google API terms](https://ai.google.dev/gemini-api/terms), [Modular terms](https://www.modular.com/legal/terms), [Cohere terms](https://cohere.com/terms-of-use), [Poolside legal](https://poolside.ai/legal), [AtlasCloud privacy](https://www.atlascloud.ai/privacy), [Novita terms](https://novita.ai/legal/terms-of-service): provider review inputs, not legal approval.
