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
| No training | North Mini Code (Cohere, kept up to 30 days), Dots3-Note Preview (AtlasCloud, retention not published) | Offered on both routes. Every request sends `data_collection: "deny"`. |
| No training, own account only | Gemma 4 26B and 31B (Google AI Studio, kept up to 55 days), Xing4.0 29B A4B (Phala) | Offered only through the user's own OpenRouter account, never on the shared allowance, so 1.99.108 and CLI 1.99.99 never receive them. Google's Gemini API terms (28 April 2026) let EEA, Swiss and UK users use the service only through Paid Services, and the shared allowance does not check where its users are. Phala serves Xing4.0 under RedPill's terms (7 April 2025), which do not address free use. Set in `PERSONAL_ONLY_FREE_MODELS`; whether to serve them on the shared allowance is an owner decision. Every request sends `data_collection: "deny"`. |
| May train | Laguna S 2.1 and XS 2.1 (Poolside, free until 31 October 2026), LFM2.5-2.6B (Liquid), Inkling and Inkling Small (Thinking Machines) | Labelled **May train on your prompts**. Nothing is sent until the user accepts once. After that, requests send `data_collection: "allow"`, which OpenRouter needs to route to these endpoints, and fall back only to may-train models of the same provider, never to another provider or to a no-training model. |
| Unreviewed | Any free model or serving provider not in the record | Disclosed the same way as may-train, never as no-training. Offered on the personal route only, and its requests still send `data_collection: "deny"`. |
| Barred | NVIDIA's six free endpoints | Never listed. NVIDIA's API Trial Terms of Service limit them to evaluation and bar production use and sharing output (sections 1.2, 1.4 and 4.2). The reason is in `BARRED_FREE_AUTHORS`. |

No free endpoint was marked as publishing prompts on 17 October 2026. OpenRouter's public API has no training flag; the policies come from each endpoint's `data_policy` on its model page at `https://openrouter.ai/<model id>` and the terms that endpoint links, which OpenRouter calls its best knowledge rather than a definitive source. Evidence per pair is in [free-models-legal.md](owner-actions/free-models-legal.md#evidence-per-model-17-october-2026). To add a model, record its evidence there, then add its pair to `REVIEWED_FREE_ENDPOINTS`.

Still excluded, as before: router aliases (`openrouter/*`), models priced per item although their token prices are zero (Google Lyria), models without tools, and anything expiring within 7 days. Endpoints that accept tools but not `tool_choice` (Thinking Machines) are kept; an automatic tool choice is sent without the parameter.

**Answers-only models.** No free model without tools is offered. On 17 October 2026 the only ones were NVIDIA's, which are barred anyway. Whether the agent loop should offer a model that cannot edit files or run commands is an open owner question.

### The label, the disclaimer and the one-time consent

- Wherever a may-train or unreviewed model is listed, it says **May train on your prompts**: the desktop picker row, its tooltip and spoken label, the composer's model chip tooltip, the TUI model list, and the `vector models` caption on stderr.
- The disclaimer: "This free model's provider may log your prompts, code and outputs and use them to train its models. Vector itself never trains on your prompts. Don't use it with private repositories, secrets or personal data." An unreviewed model says Vector has not reviewed its policy yet.
- Before the first prompt to such a model, the desktop asks once (**Accept and send** or **Don't send**), and the TUI asks when the model is chosen. The draft stays in the editor if the user declines. The question names the chosen model and says that accepting covers every model labelled **May train on your prompts**, including ones Vector has not reviewed yet, now and later, until it is withdrawn. The acceptance is recorded by the engine in `~/.local/state/vector/free-model-training-consent.json`, a fixed path under the home directory, so the desktop engine (whose XDG directories sit inside the app's data folder), the TUI and the CLI on one computer share it and read it on every request. An engine on another computer, such as `vector serve` on a server, keeps its own.
- The engine refuses to build a request to such a model without that record, so nothing is sent from any client, including `vector run`, subagents and reviews. The refusal says: "... Nothing was sent. Accept it once when Vector asks, or run "vector models --accept-training", then send again." **Withdraw** on the Free models inside of Vector card in the desktop Help panel, or `vector models --decline-training`, withdraws it.
- An invited guest (`vector invite`) runs on the owner's engine, under the owner's acceptance, which the guest never gave. So a guest is not offered models labelled **May train on your prompts** (the provider list leaves them out and the consent read says no), and the engine refuses a guest's prompt (including a subtask part that names one), compaction, worker message, model switch or free-model resume that would run on one, on the legacy and V2 routes, before anything is saved: "Only the workspace owner can use free models labelled "May train on your prompts" here, since only they can accept that notice. Choose another model." The same text replaces "try again" when an acceptance is refused with 403.
- The guest's input stays in the session's history and goes out again with every later request there, so the rule also holds where each free-model request is built (`FreeModels.resolveRoute`, used by the legacy fetch and the V2 runner alike). Once a guest has sent a session any request other than a read (GET or HEAD), or answered one of its questions, the whole session tree (its subagents and its parent) is marked in `FreeModelGuests`, and no request for it goes to a labelled model, the owner's own prompts, compactions, titles, summaries, subagents, retries and fallbacks included: "An invited guest has worked in this session, and only the workspace owner can accept the "May train on your prompts" notice, so Vector doesn't send this session to free models with that label. Nothing was sent. Choose another model." Marks are kept beside the database (`free-model-guest-sessions.json`), so a restart does not clear them, and a fork of a marked session, which copies the guest's messages, is marked too. A guest request forwarded to a remote workspace reaches that workspace's engine with the owner's credentials, so it carries `x-vector-guest-request: 1`, and that engine marks the session the same way, for prompts and for answers to questions. The remote engine's early refusals still see an owner there, so a forwarded guest prompt to a labelled model is refused when it is sent, not before it is saved.
- Vector never chooses a may-train model for you ahead of a no-training one.
- Vector itself never trains on prompts. That is a statement about Vector, not about the providers.

### Old clients keep a no-training catalog

Desktop 1.99.108 and CLI 1.99.99 never show the label, so vectordev.ai serves may-train models only to clients that declare they show it: `GET /api/free-models/models?disclosure=may-train-v1`, and the header `x-vector-free-model-disclosure: may-train-v1` on shared chats. Any other client receives the no-training models only, and its shared chats fall back only among them. The shared chat refuses a may-train model with 403 `FREE_MODELS_DISCLOSURE_REQUIRED` when the disclosure is missing and 403 `FREE_MODELS_CONSENT_REQUIRED` without `x-vector-free-model-training-consent: accepted`, before any allowance is spent.

## Keep model access at no charge

Use a free OpenRouter account without purchasing credits, adding a payment method, enabling automatic top-ups, or connecting paid upstream provider keys through OpenRouter's BYOK settings. Remove account defaults or enforced settings that enable paid plugins. These account settings are outside Vector's control.

OpenRouter currently lists up to **50 free-model requests per day** and **20 per minute** for an account without a credit purchase, and 1,000 a day once an account has bought $10 of credits. Failed attempts count. Model and provider availability can impose tighter limits, and one coding task can use many requests, since each tool step is one request. At a limit, wait for it to reset; Vector never switches to a paid model or provider. See [OpenRouter's current limits](https://openrouter.ai/docs/api_reference/limits).

## Your OpenRouter account's privacy settings

OpenRouter has separate privacy settings for free and paid models. If a user's account does not allow free models from providers that may train on their data, OpenRouter does not list those models for that account, so they do not appear under **Your OpenRouter account**. When such a model was chosen from the shared allowance, or OpenRouter answers that no endpoint matches the data policy for a may-train model, Vector says: "Your OpenRouter privacy settings block free models whose providers may train on prompts. To use this one, open openrouter.ai/settings/privacy, allow free models from providers that may train on your data, then send again. Or choose a model without the "May train on your prompts" label." A model Vector has not reviewed is sent `data_collection: "deny"` by Vector itself, so no account setting can help; for it Vector says that it has not reviewed the model's data policy, asked OpenRouter for providers that don't train on prompts, found none, and suggests another free model.

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

The daily refresh (03:17 UTC, `/api/free-models/refresh`) reads OpenRouter's public `/api/v1/models`, Vector's account list `/api/v1/models/user` (which applies that account's privacy settings), and, for each reviewed candidate, `/api/v1/models/{author}/{slug}/endpoints`. It keeps zero-price, tool-capable, reviewed endpoints that are online and more than 7 days from expiry, and leaves out personal-only models (`PERSONAL_ONLY_FREE_MODELS`, Gemma and Xing4.0 today), which a stored catalog also never serves. One unreadable endpoint list drops only that model; a failed model or account list keeps the stored catalog. When nothing qualifies, it publishes `enabled: false`. The catalog is stored under `vector:free-models:catalog:v4:policy` for 54 hours, so one failed nightly run does not take the section down, and every stored endpoint must carry the policy the reviewed record gives it.

`/api/free-models/models` returns a 503 whose code says why: `FREE_MODELS_CATALOG_MISSING` (never refreshed under the current key), `FREE_MODELS_CATALOG_STALE`, `FREE_MODELS_CATALOG_INVALID` or `PERSISTENT_STORE_UNAVAILABLE`.

For hosted activation, set the Vector account/token and persistent Redis configuration, `OPENROUTER_FREE_API_KEY`, `CRON_SECRET` and `FREE_MODELS_ENABLED=true` on the server, then run the refresh; see [owner actions](owner-actions/openrouter.md#free-models-of-17-october-2026-owner-steps). `FREE_MODELS_MINUTE_PER_USER` defaults to 10 (at most 20) and `FREE_MODELS_DAILY_PER_USER` to the smaller of 20 and a tenth of the account's daily free limit (at most 1,000). These do not raise OpenRouter's account-wide quota, which every user of the shared allowance shares.

## Clients after an outage

A client caches the catalog in `free-models-v2.json`. When vectordev.ai answers with a refusal such as 503, the client treats the shared catalog as off instead of listing models whose prompts would fail. A network failure keeps the last catalog it served. When the catalog later turns on, the engine rebuilds its provider list without a restart.

Prompts pass through OpenRouter and the selected provider. Vector does not request zero data retention for these endpoints. Most keep prompts under their own policy; OpenRouter records Phala's Xing4.0 endpoint as keeping none. The routing rules cover the model requests only, not Vector's local history, OpenRouter account logging or other connected services.
