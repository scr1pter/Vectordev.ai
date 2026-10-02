# Free models inside of Vector

This describes the guarded personal-account setup prepared for the upcoming **1.99.99** release. It is not a feature announcement for the currently downloadable desktop **1.99.8**. The shared Vector service remains disabled.

Connect your own free OpenRouter account, then choose an eligible model under **Free models inside of Vector**. The upcoming personal section works independently of the shared service flag. Its initial selection is limited to explicit `:free` models with online, tool-capable, zero-price endpoints in OpenRouter's zero data retention (ZDR) endpoint list. Discovery matches each model ID and endpoint tag; it does not include every model advertised as free. Names omit the `:free` suffix; routing IDs retain it. A failed catalog check does not authorize an unlisted endpoint or a paid fallback.

The selected setup uses the **Your OpenRouter account** caption. Requests go directly to OpenRouter using your stored key and do not consume a shared Vector allowance. No shared OpenRouter key, KV service, or hosted allowance needs to be activated.

## Keep model access at no charge

Use a free OpenRouter account without purchasing credits, adding a payment method, enabling automatic top-ups, or connecting paid upstream provider keys through OpenRouter's BYOK settings. Remove account defaults or enforced settings that enable paid plugins. These account settings are outside Vector's control. Do not purchase credits to raise the allowance.

OpenRouter currently lists up to **50 free-model requests per day** and **20 per minute** for an account without a credit purchase. Model and provider availability can impose tighter limits, and one coding task can use many requests. At a limit, wait for it to reset; Vector must not switch to a paid model or provider. See [OpenRouter's current limits](https://openrouter.ai/docs/api_reference/limits).

The guarded personal route restricts requests to eligible explicit free IDs and zero-price endpoints, enforces `provider.zdr: true` and `data_collection: "deny"`, disables paid plugins and paid model/provider fallbacks, and stops if those constraints cannot be satisfied. The endpoint list is supplied by OpenRouter, not an independent Vector audit of each provider. See [OpenRouter's ZDR endpoint API](https://openrouter.ai/docs/api/api-reference/endpoints/preview-the-impact-of-zdr-on-the-available-endpoints) and [routing controls](https://openrouter.ai/docs/guides/routing/provider-selection).

Selecting another provider, using an external agent, or enabling a paid external tool is separate from this setup and is not covered by the free-model route. Free model access does not make other services free.

## Connect your account

In the desktop app, open Getting Started or Settings → Providers and choose **Connect OpenRouter**. The browser authorization flow stores the resulting key in Vector's provider credential store. You can also enter your own API key. In the terminal, use `/connect`, or run:

```sh
vector providers login --provider openrouter --method "Connect OpenRouter"
vector models
```

For an API-key connection, save the key through Settings → Providers or set `OPENROUTER_API_KEY` in the engine's environment. A project-only `provider.openrouter.options.apiKey` value is insufficient for guarded free models: discovery and requests use the connected credential or environment key. Migrate an existing config-only key to one of those sources without committing or printing it.

Browser authorization receives its callback on the engine's localhost. With a remote engine, use an OpenRouter API key; browser authorization requires access to that callback port. The app and terminal show this guidance and keep API-key setup available.

`vector models` keeps canonical `provider/model` selectors on stdout. Its free-model heading, display names, and source captions go to stderr so shell consumers retain the plain selector format.

## Optional future shared allowance

`FREE_MODELS_ENABLED=false` keeps the shared allowance off without disabling personal OpenRouter access. A shared allowance would require a separate owner decision, service configuration, and review; it is not required for this release's personal setup. Its older policy-catalog refresh still depends on an obsolete metadata endpoint and must be repaired before any future activation. If enabled in a future rollout, its source caption is **Shared Vector allowance**, and a duplicate available through your own account uses your account's copy. Exhausting an allowance must never trigger a paid fallback.

Prompts pass through OpenRouter and the selected downstream provider. The ZDR restriction applies to downstream routing for these guarded requests. It does not promise that Vector's local conversation history, OpenRouter account logging, or other connected services retain no data. Review those settings and policies before sending confidential code. Legal page changes remain separately subject to owner review.
