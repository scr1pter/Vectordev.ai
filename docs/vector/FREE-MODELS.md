# Free models inside of Vector

This describes the free-model section from desktop **1.99.109** and the next CLI release, and what earlier versions do. The current downloads are desktop 1.99.108 and npm CLI 1.99.99. Whether Vector's shared allowance serves models is set on Vector's service with `FREE_MODELS_ENABLED`, not by the release; see [Shared allowance for Vector accounts](#shared-allowance-for-vector-accounts).

Two routes reach the same section:

- **Your OpenRouter account.** Connect your own free OpenRouter account. Requests go directly to OpenRouter with your stored key and do not use Vector's shared allowance.
- **Shared Vector allowance.** Any signed-in Vector account, with no OpenRouter account, while Vector's service has it on. Requests pass through vectordev.ai, which checks the account and its limits.

Names omit the `:free` suffix; routing IDs keep it. A failed catalog check never authorizes an unlisted endpoint or a paid fallback, and `max_price` stays zero on every request.

## Every free model, with its data policy (owner decision, 17 October 2026)

The owner decided that every free OpenRouter model belongs here, including models whose providers may train on prompts, with a clear disclaimer. Each model and the provider serving it carry one of these policies, from a reviewed record in `REVIEWED_FREE_ENDPOINTS` in `packages/core/src/free-model-catalog.ts` (reviewed 17 October 2026, `FREE_MODEL_POLICY_REVIEWED`):

| Policy | Models on 17 October 2026 (provider) | What Vector does |
| --- | --- | --- |
| No training | Xing4.0 29B A4B (Phala), North Mini Code (Cohere, kept up to 30 days), Dots3-Note Preview (AtlasCloud, retention not published), Gemma 4 26B and 31B (Google AI Studio, kept up to 55 days) | Offered on both routes. Every request sends `data_collection: "deny"`. |
| May train | Laguna S 2.1 and XS 2.1 (Poolside, free until 31 October 2026), LFM2.5-2.6B (Liquid), Inkling and Inkling Small (Thinking Machines) | Labelled **May train on your prompts**. Nothing is sent until the user accepts once. After that, requests send `data_collection: "allow"`, which OpenRouter needs to route to these endpoints. |
| Unreviewed | Any free model or serving provider not in the record | Disclosed the same way as may-train, never as no-training. Offered on the personal route only, and its requests still send `data_collection: "deny"`. |
| Barred | NVIDIA's six free endpoints | Never listed. NVIDIA's API Trial Terms of Service limit them to evaluation and bar production use and sharing output (sections 1.2, 1.4 and 4.2). The reason is in `BARRED_FREE_AUTHORS`. |

No free endpoint was marked as publishing prompts on 17 October 2026. OpenRouter's public API has no training flag; the policies come from each endpoint's `data_policy` on its model page at `https://openrouter.ai/<model id>` and the terms that endpoint links, which OpenRouter calls its best knowledge rather than a definitive source. Evidence per pair is in [free-models-legal.md](owner-actions/free-models-legal.md#evidence-per-model-17-october-2026). To add a model, record its evidence there, then add its pair to `REVIEWED_FREE_ENDPOINTS`.

Still excluded, as before: router aliases (`openrouter/*`), models priced per item although their token prices are zero (Google Lyria), models without tools, and anything expiring within 7 days. Endpoints that accept tools but not `tool_choice` (Thinking Machines) are kept; an automatic tool choice is sent without the parameter.

**Answers-only models.** No free model without tools is offered. On 17 October 2026 the only ones were NVIDIA's, which are barred anyway. Whether the agent loop should offer a model that cannot edit files or run commands is an open owner question.

### The label, the disclaimer and the one-time consent

- Wherever a may-train or unreviewed model is listed, it says **May train on your prompts**: the desktop picker row, its tooltip and spoken label, the composer's model chip tooltip, the TUI model list, and the `vector models` caption on stderr.
- The disclaimer: "This free model's provider may log your prompts, code and outputs and use them to train its models. Vector itself never trains on your prompts. Don't use it with private repositories, secrets or personal data." An unreviewed model says Vector has not reviewed its policy yet.
- Before the first prompt to such a model, the desktop asks once (**Accept and send** or **Don't send**), and the TUI asks when the model is chosen. The draft stays in the editor if the user declines. The acceptance is recorded by the engine in `free-model-training-consent.json` in Vector's state directory, which the desktop engine, the TUI and the CLI share and read on every request.
- The engine refuses to build a request to such a model without that record, so nothing is sent from any client, including `vector run`, subagents and reviews. The refusal says: "... Nothing was sent. Accept this once in Vector's model picker, or run "vector models --accept-training", then send again." `vector models --decline-training` withdraws it.
- Vector never chooses a may-train model for you ahead of a no-training one.
- Vector itself never trains on prompts. That is a statement about Vector, not about the providers.

### Old clients keep a no-training catalog

Desktop 1.99.108 and CLI 1.99.99 never show the label, so vectordev.ai serves may-train models only to clients that declare they show it: `GET /api/free-models/models?disclosure=may-train-v1`, and the header `x-vector-free-model-disclosure: may-train-v1` on shared chats. Any other client receives the no-training models only, and its shared chats fall back only among them. The shared chat refuses a may-train model with 403 `FREE_MODELS_DISCLOSURE_REQUIRED` when the disclosure is missing and 403 `FREE_MODELS_CONSENT_REQUIRED` without `x-vector-free-model-training-consent: accepted`, before any allowance is spent.

## Keep model access at no charge

Use a free OpenRouter account without purchasing credits, adding a payment method, enabling automatic top-ups, or connecting paid upstream provider keys through OpenRouter's BYOK settings. Remove account defaults or enforced settings that enable paid plugins. These account settings are outside Vector's control.

OpenRouter currently lists up to **50 free-model requests per day** and **20 per minute** for an account without a credit purchase, and 1,000 a day once an account has bought $10 of credits. Failed attempts count. Model and provider availability can impose tighter limits, and one coding task can use many requests, since each tool step is one request. At a limit, wait for it to reset; Vector never switches to a paid model or provider. See [OpenRouter's current limits](https://openrouter.ai/docs/api_reference/limits).

## Your OpenRouter account's privacy settings

OpenRouter has separate privacy settings for free and paid models. If a user's account does not allow free models from providers that may train on their data, OpenRouter does not list those models for that account, so they do not appear under **Your OpenRouter account**. When such a model was chosen from the shared allowance, or OpenRouter answers that no endpoint matches the data policy, Vector says: "Your OpenRouter privacy settings block free models whose providers may train on prompts. To use this one, open openrouter.ai/settings/privacy, allow free models from providers that may train on your data, then send again. Or choose a model without the "May train on your prompts" label."

## Connect your account

In the desktop app, choose **Start free with OpenRouter** above the composer (shown while no connected provider offers a model) or **Start free** in Getting Started. You can also open Settings → Providers and choose **Connect OpenRouter**. The browser authorization flow stores the resulting key in Vector's provider credential store, and the composer then selects the largest-context free model on the account, preferring a no-training one, and keeps your draft prompt ready to send. If no free model is available, Vector says so and selects nothing; it never substitutes a paid model. In the terminal, use `/connect` (the TUI home screen shows it whenever no provider is connected), or run:

```sh
vector providers login --provider openrouter --method "Connect OpenRouter"
vector models
vector models --accept-training   # only if you want models labelled "May train on your prompts"
```

For an API-key connection, save the key through Settings → Providers or set `OPENROUTER_API_KEY` in the engine's environment. A key only in a repository's `provider.openrouter.options.apiKey` does not enable guarded free models.

Browser authorization receives its callback on the engine's localhost. With a remote engine, use an OpenRouter API key.

`vector models` keeps canonical `provider/model` selectors on stdout. Its free-model heading, display names, source captions, labels and the disclaimer go to stderr.

## Shared allowance for Vector accounts

`FREE_MODELS_ENABLED=false` keeps the shared allowance off without disabling personal OpenRouter access. A model available through your own connected OpenRouter account uses your account's copy.

The daily refresh (03:17 UTC, `/api/free-models/refresh`) reads OpenRouter's public `/api/v1/models`, Vector's account list `/api/v1/models/user` (which applies that account's privacy settings), and, for each reviewed candidate, `/api/v1/models/{author}/{slug}/endpoints`. It keeps zero-price, tool-capable, reviewed endpoints that are online and more than 7 days from expiry. One unreadable endpoint list drops only that model; a failed model or account list keeps the stored catalog. When nothing qualifies, it publishes `enabled: false`. The catalog is stored under `vector:free-models:catalog:v4:policy` for 54 hours, so one failed nightly run does not take the section down, and every stored endpoint must carry the policy the reviewed record gives it.

`/api/free-models/models` returns a 503 whose code says why: `FREE_MODELS_CATALOG_MISSING` (never refreshed under the current key), `FREE_MODELS_CATALOG_STALE`, `FREE_MODELS_CATALOG_INVALID` or `PERSISTENT_STORE_UNAVAILABLE`.

For hosted activation, set the Vector account/token and persistent Redis configuration, `OPENROUTER_FREE_API_KEY`, `CRON_SECRET` and `FREE_MODELS_ENABLED=true` on the server, then run the refresh; see [owner actions](owner-actions/openrouter.md#free-models-of-17-october-2026-owner-steps). `FREE_MODELS_MINUTE_PER_USER` defaults to 10 (at most 20) and `FREE_MODELS_DAILY_PER_USER` to the smaller of 20 and a tenth of the account's daily free limit (at most 1,000). These do not raise OpenRouter's account-wide quota, which every user of the shared allowance shares.

## Clients after an outage

A client caches the catalog in `free-models-v2.json`. When vectordev.ai answers with a refusal such as 503, the client treats the shared catalog as off instead of listing models whose prompts would fail. A network failure keeps the last catalog it served. When the catalog later turns on, the engine rebuilds its provider list without a restart.

Prompts pass through OpenRouter and the selected provider. None of these endpoints is zero data retention. The routing rules cover the model requests only, not Vector's local history, OpenRouter account logging or other connected services.
