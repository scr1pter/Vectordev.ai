# Models included with Vector

This describes the guarded personal-account setup, available from desktop and CLI **1.99.99** (the current downloads are desktop 1.99.106 and npm CLI 1.99.99), and Vector's shared allowance. Whether the shared allowance serves models is set on Vector's service with `FREE_MODELS_ENABLED`, not by the release; see [Shared allowance for Vector accounts](#shared-allowance-for-vector-accounts).

Connect your own free OpenRouter account, then choose an eligible model under **Models included with Vector**. The personal section works independently of the shared service flag. Its selection is limited to the explicit `:free` models on Vector's allowlist, each with online, tool-capable, zero-price endpoints from the provider allowlisted for it. Discovery reads each model's public OpenRouter endpoint list and matches each model ID and endpoint tag; it does not include every model advertised as free. Names omit the `:free` suffix; routing IDs retain it. A failed catalog check does not authorize an unlisted endpoint or a paid fallback.

The selected setup uses the **Your OpenRouter account** caption. Requests go directly to OpenRouter using your stored key and do not consume a shared Vector allowance. No shared OpenRouter key, KV service, or hosted allowance needs to be activated.

## Data policy: no training

On 15 October 2026 the policy for Models included with Vector changed from zero data retention (ZDR) to no training. That day no tool-capable free endpoint was on OpenRouter's ZDR list, so the included list was empty. Providers may now retain prompts and outputs under their own policies but must not train on them. Every other guard stays: allowlisted providers only (now allowlisted model by model), `data_collection: "deny"` on every request, the provider `only` list, `require_parameters`, a zero `max_price`, no paid fallback, the expiry buffer and tool support.

OpenRouter's public endpoint data does not say whether a provider trains on prompts, and provider-level policy records do not describe free endpoints reliably: the 25 September records listed Poolside as not training, yet OpenRouter's pages for the free Laguna models say Poolside may use inputs and outputs from free use to train its models. Vector therefore allowlists each model with the provider that may serve it, in `NO_TRAINING_ENDPOINTS` in `packages/core/src/free-model-catalog.ts`: Cohere for `cohere/north-mini-code:free` and AtlasCloud for `dots-studio/dots-3-note-preview:free`. A new free model, even from one of those providers, is not offered until it is checked and added. NovitaAI and ModelRun serve no free model today and were dropped until they are re-reviewed. Every request also asks OpenRouter to deny data collection, which excludes endpoints OpenRouter records as training on prompts; OpenRouter describes those records as its best knowledge, not a definitive source of provider policies. Both pairs still need the owner confirmations in [No-training evidence per model](owner-actions/openrouter.md#no-training-evidence-per-model) before deploy. This relies on published policies, not an independent audit of each provider's operations. Codium is unchanged and still routes to zero data retention endpoints only.

## Keep model access at no charge

Use a free OpenRouter account without purchasing credits, adding a payment method, enabling automatic top-ups, or connecting paid upstream provider keys through OpenRouter's BYOK settings. Remove account defaults or enforced settings that enable paid plugins. These account settings are outside Vector's control. Do not purchase credits to raise the allowance.

OpenRouter currently lists up to **50 free-model requests per day** and **20 per minute** for an account without a credit purchase. Model and provider availability can impose tighter limits, and one coding task can use many requests. At a limit, wait for it to reset; Vector must not switch to a paid model or provider. See [OpenRouter's current limits](https://openrouter.ai/docs/api_reference/limits).

The guarded personal route restricts requests to eligible explicit free IDs and zero-price endpoints, asks OpenRouter to deny data collection and limits routing to the allowlisted providers, disables paid plugins and paid model/provider fallbacks, and stops if those constraints cannot be satisfied. See [routing controls](https://openrouter.ai/docs/guides/routing/provider-selection).

Selecting another provider, using an external agent, or enabling a paid external tool is separate from this setup and is not covered by the free-model route. Free model access does not make other services free.

## Connect your account

In the desktop app, choose **Start free with OpenRouter** above the composer (shown while no connected provider offers a model) or **Start free** in Getting Started. You can also open Settings → Providers and choose **Connect OpenRouter**. The browser authorization flow stores the resulting key in Vector's provider credential store, and the composer then selects the largest-context eligible free model and keeps your draft prompt ready to send. If no eligible free model is available, Vector says so and selects nothing; it never substitutes a paid model. You can also enter your own API key. In the terminal, use `/connect`, or run:

```sh
vector providers login --provider openrouter --method "Connect OpenRouter"
vector models
```

For an API-key connection, save the key through Settings → Providers or set `OPENROUTER_API_KEY` in the engine's environment. A project-only `provider.openrouter.options.apiKey` value is insufficient for guarded free models: discovery and requests use the connected credential or environment key. Migrate an existing config-only key to one of those sources without committing or printing it.

Browser authorization receives its callback on the engine's localhost. With a remote engine, use an OpenRouter API key; browser authorization requires access to that callback port. The app and terminal show this guidance and keep API-key setup available.

`vector models` keeps canonical `provider/model` selectors on stdout. Its free-model heading, display names, and source captions go to stderr so shell consumers retain the plain selector format.

## Shared allowance for Vector accounts

`FREE_MODELS_ENABLED=false` keeps the shared allowance off without disabling personal OpenRouter access. Once the hosted service is configured and enabled, any signed-in Vector account can use **Shared Vector allowance** without an OpenRouter account or a paid Vector subscription. A duplicate available through your own connected OpenRouter account uses your account's copy.

The shared catalog reads OpenRouter's public `/api/v1/models` and, for each candidate, `/api/v1/models/{author}/{slug}/endpoints`. It checks live zero prices, tools, a 7-day expiry buffer, account availability and the no-training allowlist of models and providers. Shared requests ask OpenRouter to deny data collection and enforce the provider list and zero-price limits; one unreadable endpoint list drops only that model, while a failed model or account list leaves the stored catalog in place; exhaustion or a provider refusal shows the model as temporarily unavailable and never triggers a paid fallback. When nothing qualifies, the refresh publishes `enabled: false` and clients hide the section. The cache key is `vector:free-models:catalog:v3:no-training`, so a catalog chosen under an earlier policy cannot be served.

For hosted activation, set the existing Vector account/token and persistent Redis configuration, `OPENROUTER_FREE_API_KEY`, `CRON_SECRET`, and `FREE_MODELS_ENABLED=true` on the server. The older server `OPENROUTER_API_KEY` name remains a fallback. Run the authenticated `/api/free-models/refresh` job before exposing access; the existing daily cron refreshes the catalog. Missing, expired or malformed catalogs fail closed. Set `FREE_MODELS_DAILY_PER_USER` and `FREE_MODELS_MINUTE_PER_USER` for the intended shared capacity. These limits do not increase OpenRouter's account-wide quota. API keys are kept server-side and all users share the upstream account's capacity.

Activation still requires the owner's provider authentication, capacity and applicable commercial/provider permissions. A source change does not turn on the deployed service. Managed paid plans have separate keys, entitlements and allowances; see [model subscriptions](MODEL-PLANS.md).

Prompts pass through OpenRouter and the selected downstream provider. These are not zero data retention endpoints: providers may keep prompts and outputs under their own policies, and Vector requests that they are not used for training. This routing restriction covers the guarded model requests only. It does not cover Vector's local conversation history, OpenRouter account logging, or other connected services. Review those settings and policies before sending confidential code. Legal page changes remain separately subject to owner review.
