# Vector Codium

Codium is Vector's managed coding-model service: monthly subscriptions plus one-time top-ups, with the same curated model catalog at every price. The workspace stays free. Larger purchases buy more usage, not a different quality tier. **Stripe is intentionally disconnected and `MODEL_PLANS_ENABLED=false`; source changes do not activate sales.** The owner has deferred payment setup.

The public `/codium` pricing page (`/pricing` redirects to it) shows the offering without requiring sign-in. While sales are off, its purchase buttons say "Coming soon" and do nothing. Once enabled, a signed-in visitor's button opens the same checkout or top-up session the account page uses; a signed-out visitor signs in first, and the page resumes that purchase when they return in the same tab. The page is prerendered from `publicModelPlans()`, so changing sales flags or allowances takes a redeploy, as the API functions already do. The account page adds authenticated balances and billing management. The desktop and CLI show the provider as **Vector Codium**, while its stable internal ID remains `vector-plan`.

The page tells buyers that Codium works in the Vector desktop app and CLI, so keep `MODEL_PLANS_ENABLED=false` until a published desktop and CLI release includes the Vector Codium provider. Its balance answer names only the account page; when that release shows Codium balances in the app, name the app there as well.

Customers never see credit amounts. The account page shows balances as the share of monthly and purchased credits remaining, and each offer's usage as a range of typical tasks on the default model; the backend accounts in provider-cost USD. Credit amounts appear only in an account's own authenticated status (`/api/model-plans/status`), never in `/api/model-plans/config` or on a public page. Renewal, expiration, carry-forward and cancellation terms remain visible before purchase; `/legal/terms#codium` describes variable consumption and preserves billing-error remedies and mandatory consumer rights.

## The /codium page

The page follows the layout and behaviour of a familiar coding-plan pricing page with Vector's own copy, logo and colours: its own top bar and footer, a plain black background with hairline borders, Geist for type, and Vector violet only as an accent. An **Individual / Top-ups** radiogroup switches between the four monthly plans and the four one-time packs and keeps the choice in the address (`?type=topups`), so links, reloads and the back button restore it. There is no free card: the workspace itself is free to download.

The page never shows credit amounts, dollar values of credits, model prices or the markup, and neither do its island props or the unauthenticated `/api/model-plans/config`. Both are built from `publicModelPlans()` in `api/_lib/model-plan-config.ts`, which reduces the configuration to names, purchase prices, each offer's credits as a multiple of the smallest offer ("5× the monthly credits of Codium 10"), model names and descriptions, and **usage estimates as ranges of typical agent tasks**, rounded down to two significant digits. The ranges are computed on the server from each purchase's credits and private task assumptions. Anyone holding both the ranges and those assumptions can work out each purchase's credits, and from them the markup, so the assumptions, the markup and the allowances stay out of this repository and off every public page.

### How the usage ranges are derived

`CODIUM_TASK_USAGE_JSON` holds the assumptions, keyed by model ID: the share of input tokens expected from the prompt cache, the expected input, cached-input and output prices per million tokens, and two typical tasks, a focused fix and a multi-file change, as input and output tokens. The shape, with placeholder values:

```json
{
  "vendor/model": {
    "cached": 0.5,
    "price": { "input": 1, "cached": 0.1, "output": 4 },
    "tasks": [
      { "input": 100000, "output": 2000 },
      { "input": 1000000, "output": 20000 }
    ]
  }
}
```

A task costs `input × (1 − cached) × input price + input × cached × cached price + output × output price`. A purchase's range runs from its credits divided by the larger task's cost to its credits divided by the smaller task's cost. A model without an entry has no range. Set the variable both where `/codium` is built and where the API runs; without it the page leaves out the usage table and the usage lines on its cards, and the account page leaves out its estimates. Invalid JSON fails the build and the configuration endpoint closed, as an invalid `MODEL_PLAN_MODELS_JSON` does.

Base prices on what OpenRouter's price-weighted routing is expected to pay across each model's ZDR endpoints, and tokens per task on independent agentic benchmarks. Keep the reviewed values with the markup in the owner's private records, and revisit them after measuring real Vector sessions and whenever the catalog or its routing changes. These are estimates, not allotments.

## Pricing and margin

`MODEL_CREDIT_MARKUP_PERCENT` sets the markup on model cost applied when a purchase is converted into USD model credits; `MODEL_PLAN_<price>_CREDITS_USD` and `MODEL_TOPUP_<price>_CREDITS_USD` can set an allowance directly. USD model credits are the amount available for provider-reported inference, not the amount paid at checkout. The markup is applied once, when converting a purchase into credits; usage debits actual upstream model cost without a second markup. Set the markup only in the hosting environment: neither its value nor the resulting allowances belong in this repository, its docs or its tests, because the code's fallback is public.

The same conversion applies to monthly subscriptions and one-time packs. Monthly allowance expires at the end of its paid period. Purchased credits carry forward independently of the subscription. There are no automatic top-ups or overage charges. This is not an unlimited-use offering, and no fixed number of coding tasks is promised.

A markup on cost is a smaller spread on revenue, and it comes **before** payment fees, provider funding fees, hosting, support, refunds, fraud and taxes, so it is not a profit margin. Actual fees depend on the account and payment method. Public references checked October 9, 2026: [OpenRouter pricing](https://openrouter.ai/pricing), [Stripe pricing](https://stripe.com/pricing), [Stripe Billing](https://stripe.com/billing/pricing).

From `packages/web`, `bun scripts/codium-economics.ts` prints a contribution table for the allowances configured in the environment it runs in; run it with the private values and keep its output private. Its fee assumptions are planning inputs only and never change customer balances. Override `CODIUM_PROVIDER_FEE_PERCENT`, `CODIUM_PAYMENT_FEE_PERCENT`, `CODIUM_PAYMENT_FIXED_USD` and `CODIUM_SUBSCRIPTION_FEE_PERCENT` when the actual commercial terms are known.

## Coding catalog

Codium offers low-cost coding models only, chosen for the most usage per credit without giving up quality. The default allowlist lives in `api/_lib/codium-catalog.ts`; the first entry is the default. These routing ceilings were checked against OpenRouter's public [model catalog](https://openrouter.ai/api/v1/models) and [ZDR endpoint catalog](https://openrouter.ai/api/v1/endpoints/zdr) on October 10, 2026. They require working endpoints with function tools, no training/retention routing, and no additional request/image charges.

| Model                                                                     | Role                                    | Context / max output | Input / output ceiling per million tokens |
| ------------------------------------------------------------------------- | --------------------------------------- | -------------------- | ----------------------------------------- |
| [DeepSeek V4.1 Flash](https://openrouter.ai/deepseek/deepseek-v4.1-flash) | Default everyday model                  | 262,144 / 32,000     | $0.30 / $1.20                             |
| [Xiaomi MiMo V2.6 Flash](https://openrouter.ai/xiaomi/mimo-v2.6-flash)    | Cheapest option for routine work        | 262,144 / 16,384     | $0.26 / $0.41                             |
| [Claude Haiku 5.5](https://openrouter.ai/anthropic/claude-haiku-5.5)      | Strongest low-cost model for hard tasks | 100,000 / 20,000     | $0.22 / $0.55                             |

Why these three, from independent boards that still separate low-cost models (Vals Terminal-Bench 4.0 and 2.1, Vibe Code Bench v1.1, Code Migration) rather than saturated vendor SWE-bench figures, and from cached-input price, which dominates Vector's agent sessions:

- **DeepSeek V4.1 Flash** has the best independent quality per dollar of the low-cost models (Vibe Code 84.7%, Code Migration 45.6%, Terminal-Bench 2.1 74.5%), runs at about 217 tokens/s and has the widest ZDR coverage. The $0.30 / $1.20 ceiling covers the mainstream fp8 ZDR endpoints and leaves out Fireworks US and BaseTen fast. The catalog uses 262K of its context, enough for real work; recall across the 1M window is unproven.
- **Xiaomi MiMo V2.6 Flash** is the cheapest per task among credible agentic models (Terminal-Bench 2.1 76.4% at about $0.02 a task) with cached input at $0.002 to $0.004 per million on four of its five ZDR vendors. It streams at about 62 tokens/s, so output is capped at 16,384 tokens to finish inside the gateway's 600-second limit even on a slow provider. The Xiaomi first-party endpoint is not ZDR.
- **Claude Haiku 5.5** has the highest independent quality among low-price models (Vibe Code 90.4%, Terminal-Bench 4.0 35.4%). It is ZDR on Google Vertex and Amazon Bedrock only. Every endpoint bills the whole request at 5x once a prompt reaches 100,000 tokens, so its context is set to 100,000 on purpose: the gateway rejects a request whose prompt bound plus requested output exceeds that, and its bound overcounts typical code, prose and tool output (see below). Its input ceiling is $0.22 rather than the $0.11 list price because these endpoints bill prompt-cache writes at up to twice the input price, and the gateway's pre-authorisation must cover them.

Set reasoning effort explicitly when the Codium provider lands in the app so usage stays predictable: DeepSeek high, MiMo default, Haiku high (max adds about five Artificial Analysis Intelligence Index points for about 2.6x the cost per task). The gateway does not restrict quantization, and DeepSeek V4.1 Flash has fp4 ZDR endpoints inside its ceiling that price-weighted routing will favour; restrict routing to fp8 or better before launch if quality on real Vector tasks drops.

The gateway cannot tokenize every model, so it bounds a prompt as one token per three bytes of its request JSON plus a small allowance per message. Code, prose and tool output run nearer four bytes a token once JSON escaping is counted, so the bound overcounts them by up to a third; only text averaging under about three bytes a token, such as long runs of non-Latin script, could pass the bound and still reach Haiku's 100,000-token price. The authenticated `/api/model-plans/models` tells the app three quarters of each context (196,608 for DeepSeek and MiMo, 75,000 for Haiku), so the app compacts a session before the gateway would refuse its next request. Revisit both numbers if real Vector sessions on a model average under three or over four bytes a token.

These roles are product recommendations from public benchmarks, not measured Vector results. Evaluate completion quality and latency on real Vector coding tasks before launch. Models are selected by the user; this change does not introduce automatic model routing by task difficulty. All models consume the same credit pools, and more expensive models spend them faster. Input, output and billed reasoning count toward usage. Caching can lower actual usage cost.

Do not anchor permanent prices to temporary provider discounts. From `packages/web`, `bun scripts/model-plan-catalog.ts` checks whether the configured catalog still has compatible live endpoints. A model's cheapest advertised provider may have incompatible context, tool support or retention settings. The audit ignores per-search web fees, because the gateway turns off OpenRouter's web plugin and accepts only function tools. Price ceilings fail closed if suitable provider prices rise; review the catalog rather than silently increasing customer cost.

## Account and credit flow

Supabase authenticates the web account. Stripe adapters are implemented but disconnected. A checkout redirect alone never grants credits. The gateway verifies signed Vector account tokens and durable account revocation; server-held encrypted OpenRouter keys make the actual inference requests. Neither management credentials nor inference keys reach the desktop/browser.

Monthly access requires a full paid invoice matching one supported subscription and its current period, with an unrefunded, undisputed charge. Trial, unpaid, paused, refunded, discounted, prorated-only and expired periods do not grant monthly credits. Monthly card checkout is supported initially; coupons, customer-balance-only payments, manual settlement and mid-cycle plan changes are not. The billing portal permits payment-method updates, invoices and cancellation at period end. Cancellation retains the paid remainder of the current period.

Top-up checkout uses one-time payment mode. Credit grants must be tied to an actual paid checkout and its account, price and charge, with durable purchase identity to prevent duplicate grants. Refunds and disputes remove the associated allowance. Purchased credits remain separate from monthly renewals. OpenRouter's capped keys and usage totals are authoritative for spend; a lost or repeated request cannot reset the allowance.

Before inference, the gateway conservatively checks whether the selected pool can cover the bounded request. Monthly credits are used first; purchased credits can cover a request that does not fit the monthly remainder. An upstream response never triggers an automatic retry against the other pool. Parallel spending still depends on OpenRouter's per-key enforcement; local tests do not establish an atomic reservation guarantee for simultaneous real provider requests. Vector does not charge customers automatic overages. Confirm provider behavior under load before enabling sales, and account for possible provider-side overshoot as an operating risk.

Purchased-credit reconciliation reads current payment and dispute state, with Stripe reads limited to batches of eight. This fails closed when payment verification is unavailable and prevents reordered notifications from restoring refunded credits. Verification work still grows with lifetime purchase history; test realistic account histories and provider rate limits before launch. A future durable reconciliation ledger must preserve refund, dispute and deletion correctness rather than trusting cached grants indefinitely.

Account deletion closes new purchases and model access durably, expires pending checkout, cancels recurring subscriptions and disables model keys before identity deletion. Cleanup failures remain retryable. Stripe notifications verify signatures and reconcile current payment state; duplicate or reordered notifications must not mint credits.

## Using credits in Vector

The desktop app and the CLI list **Vector Codium** (`vector-plan`) as a provider whenever the signed-in account's `/api/model-plans/models` answers `enabled: true`, which needs `MODEL_PLANS_ENABLED=true` and a complete server configuration. Every signed-in account then sees the catalog, with or without credits; the endpoint reads no billing state, so frequent catalog polls never reach Stripe or OpenRouter. The desktop app passes the account token from its main process to the local engine, and the CLI uses the `vct_` token from `vector login` or `VECTOR_CLI_TOKEN`. Neither the token nor project configuration can change the provider's destination, prices or models: requests go only to `/api/model-plans/chat`, with the token added at that final boundary. A catalog refresh that is slow, fails or returns something unusable keeps the account's last catalog, so a paid turn never fails on it; only a refused token or `enabled: false` removes Codium. A fresh engine starts from the last catalog it saved for the signed-in account (keyed by a digest of the token, never the token), and a turn on an account with no catalog at all waits for vectordev.ai's answer instead of giving up after the short listing deadline.

Both runtimes (the engine's AI SDK path and the Core V2 runner) stream text and tool calls through the gateway. Each step records the provider-billed cost that the gateway passes through in the usage chunk, which is what the credit pools are debited; the catalog prices are only a fallback ceiling. Codium is never chosen automatically, in the engine, the Core V2 runner, the app or the TUI, even when it is the only provider listed, so credits are spent only on a model the person chose.

The gateway estimates a request's input tokens at four bytes of content per token, as Vector's clients do, and refuses one that cannot fit the model's listed context window with its reply (`MODEL_PLAN_CONTEXT`). Vector compacts a conversation before it reaches that window. A provider tokenizer can count more tokens than that estimate, so when the provider itself refuses a request's context (or answers 413), the gateway answers `MODEL_PLAN_CONTEXT` too, without passing on the provider's wording, and Vector compacts instead of retrying. The same estimate sizes the credit check that picks the monthly or purchased pool.

Settings → Providers and Settings → Usage show the plan, monthly credits left, purchased credits left and the renewal date from `/api/model-plans/status`, which accepts the same account token as chat requests (and the website's browser session). **Buy credits** opens `/codium`; **Manage plan** opens `/account`. A balance under a tenth of the month's plan credits, or under 100 credits, is flagged as running low; purchased credits count every top-up ever bought, so they do not raise the threshold. When every credit is spent, including a subscriber's monthly credits before they renew, Settings and `vector codium` say so and give the renewal date.

When the gateway answers that the account has no plan or not enough credits (402 with `MODEL_PLAN_REQUIRED`, `MODEL_PLAN_PAYMENT_REQUIRED`, `MODEL_PLAN_EXHAUSTED` or `MODEL_TOPUP_EXHAUSTED`), the turn fails at once with the gateway's explanation and a **Buy credits** action. A revoked or expired sign-in, or no sign-in at all, offers **Sign in to Vector**, and a disabled or misconfigured service, or a model no longer in the catalog, asks the person to choose another model. None of these answers is retried or sent to another provider. A failure Vector detects before sending (signed out, Codium off, model retired) reads exactly like the gateway's answer and sends nothing. `MODEL_PLAN_CAPACITY` (402) means Vector's model capacity is short for a moment, not the person's balance: it is retried like a busy provider and never asks for a purchase. Engine sessions show the action on the failed turn and on session notices; Core V2 sessions record it in the assistant error as `{ type: "codium", action }`. `vector codium` (alias `vector credits`) prints the plan, balances and purchase link; `vector models vector-plan` lists the models.

## Configuration and deferred activation

Server secrets belong in the hosting environment, never in client builds or the repository. See `.env.example` for the complete list:

- `MODEL_PLANS_ENABLED=false` while payment setup is deferred.
- `MODEL_CREDIT_MARKUP_PERCENT` sets the purchase-to-credit conversion. Set it privately; blank uses the public fallback in `api/_lib/model-plan-config.ts`.
- `CODIUM_TASK_USAGE_JSON` holds the private task assumptions behind the usage ranges (see above), in both the build and the API environment.
- `MODEL_PLAN_<price>_CREDITS_USD` and `MODEL_TOPUP_<price>_CREDITS_USD` optionally override the default allowance; valid values are greater than zero and no greater than the purchase price.
- `MODEL_PLAN_MODELS_JSON` optionally overrides the catalog. Blank uses the reviewed defaults; `[]` intentionally offers no models.
- `STRIPE_MODEL_PLAN_<price>_PRICE_ID` and `STRIPE_MODEL_TOPUP_<price>_PRICE_ID` map each of the four prices ($10, $50, $100 and $200) to recurring and one-time prices respectively.
- Stripe secret, webhook secret and portal configuration; OpenRouter management key; a stable 32-byte AES encryption secret encoded as 64 hex characters; existing Vector/Supabase authentication and persistent Redis/Valkey REST configuration.

`bun scripts/setup-model-plans.ts` is a **dry run by default** and shows prices/allowances without connecting to Stripe. Its explicit `--apply` adapter can later create/reuse products and the cancellation portal in the intended test account. Do not run `--apply` until the owner resumes Stripe setup. Register `/api/model-plans/webhook` using API version `2025-02-24.acacia`, with checkout, payment, subscription, invoice, charge/refund and dispute events. Keep sales disabled until the full test flow is verified.

OpenRouter's [terms, section 7](https://openrouter.ai/terms) restrict resale of model API access. Confirm that the bundled Vector offering is covered by appropriate commercial terms before activation. No source change grants this permission.

Remaining launch work requires owner authentication/business verification, funded capacity, actual payment/provider fee terms, secret configuration, legal review of the Codium terms, payment activation, and end-to-end test payments, renewal, cancellation, refund and coding-task checks. Publishing the coming-soon website does not enable paid access. No live Stripe connection, real purchase or provider funding was performed as part of this implementation.
