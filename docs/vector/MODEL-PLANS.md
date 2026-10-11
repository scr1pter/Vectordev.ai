# Vector Codium

Codium is Vector's managed coding-model service: monthly subscriptions plus one-time top-ups, with the same curated model catalog at every price. The workspace stays free. Larger purchases buy more usage, not a different quality tier. **Stripe is intentionally disconnected and `MODEL_PLANS_ENABLED=false`; source changes do not activate sales.** The owner has deferred payment setup.

The public `/codium` pricing page (`/pricing` redirects to it) shows the offering without requiring sign-in. While sales are off, its purchase buttons say "Coming soon" and do nothing. Once enabled, a signed-in visitor's button opens the same checkout or top-up session the account page uses; a signed-out visitor signs in first, and the page resumes that purchase when they return in the same tab. The page is prerendered from `publicModelPlans()`, so changing sales flags or allowances takes a redeploy, as the API functions already do. The account page adds authenticated balances and billing management. The desktop and CLI show the provider as **Vector Codium**, while its stable internal ID remains `vector-plan`.

The page tells buyers that Codium works in the Vector desktop app and CLI, so keep `MODEL_PLANS_ENABLED=false` until a published desktop and CLI release includes the Vector Codium provider. Its balance answer names only the account page; when that release shows Codium balances in the app, name the app there as well.

Customer-facing amounts use **100 Codium credits per internal USD credit**: the four default purchases include 800, 4,000, 8,000 and 16,000 credits. This is a display conversion only; the backend continues accounting in provider-cost USD. The account page shows those credit amounts and balances. Renewal, expiration, carry-forward and cancellation terms remain visible before purchase; `/legal/terms#codium` describes variable consumption and preserves billing-error remedies and mandatory consumer rights.

## The /codium page

The page follows the layout and behaviour of a familiar coding-plan pricing page with Vector's own copy, logo and colours: its own top bar and footer, a plain black background with hairline borders, Geist for type, and Vector violet only as an accent. An **Individual / Top-ups** radiogroup switches between the four monthly plans and the four one-time packs and keeps the choice in the address (`?type=topups`), so links, reloads and the back button restore it. There is no free card: the workspace itself is free to download.

The page never shows credit amounts, dollar values of credits, model prices or the markup, and its island props carry none of them. `packages/web/src/lib/codium-pricing.ts` reduces the configuration to names, purchase prices, each offer's credits as a multiple of the smallest offer ("5× the monthly credits of Codium 10"), and **usage estimates as ranges of typical agent tasks**, rounded down to two significant digits. Because the ranges depend on the task assumptions below, which are not published on the page, a reader cannot work back from them to the dollars of model credit in a purchase.

### How the usage ranges are derived

For each model, a typical agent task runs from a focused fix (the smaller task) to a multi-file change (the larger one). 90% of input tokens are assumed to come from the prompt cache. Each task's cost is `input × 10% × input price + input × 90% × cached price + output × output price`, and a purchase's range is its USD model credits divided by the larger task's cost (low end) and by the smaller task's cost (high end).

| Model                  | Smaller task (input / output) | Larger task (input / output) | Expected input / cached / output price per million |
| ---------------------- | ----------------------------- | ---------------------------- | -------------------------------------------------- |
| DeepSeek V4.1 Flash    | 500K / 10K                    | 5M / 75K                     | $0.11 / $0.008 / $0.54                             |
| Xiaomi MiMo V2.6 Flash | 400K / 8K                     | 3.5M / 60K                   | $0.15 / $0.005 / $0.30                             |
| Claude Haiku 5.5       | 600K / 25K                    | 6M / 180K                    | $0.13 / $0.011 / $0.55                             |

- **Prices** are what OpenRouter's default routing is expected to pay. It prefers the cheapest stable providers, weighted by the inverse square of price, so these are the inverse-square-weighted averages across each model's ZDR endpoints that pass the catalog audit, using fp8 or better (October 10, 2026 snapshot). Haiku's uncached input is priced as a prompt-cache write (1.25× its list input price).
- **Token counts** reflect how much each model spends per task in independent agentic benchmarks (Vals Terminal-Bench 4.0, Vibe Code Bench and Code Migration): MiMo at default reasoning effort spends about 0.7× DeepSeek's cost per task, and Haiku at high effort at least 1.7× once its long-prompt surcharge is taken out. Haiku's 100K context also makes it compact and re-read context more often.
- A model without reviewed assumptions (for example one added through `MODEL_PLAN_MODELS_JSON`) is priced at its routing ceilings with no cache discount and DeepSeek's token counts, which understates its range rather than overstating it.

With the default 25% markup this gives, per month on each plan (and per pack for top-ups of the same price):

| Model                  | Codium 10 | Codium 50 | Codium 100 | Codium 200   |
| ---------------------- | --------- | --------- | ---------- | ------------ |
| DeepSeek V4.1 Flash    | 60–550    | 300–2,700 | 600–5,500  | 1,200–11,000 |
| Xiaomi MiMo V2.6 Flash | 92–780    | 460–3,900 | 920–7,800  | 1,800–15,000 |
| Claude Haiku 5.5       | 33–290    | 160–1,400 | 330–2,900  | 670–5,800    |

These are estimates, not allotments. Revisit the assumptions after measuring real Vector sessions on each model, and when the catalog or its routing changes.

## Pricing and margin

The starting markup is 25% on model cost, configurable through `MODEL_CREDIT_MARKUP_PERCENT`. USD model credits are the amount available for provider-reported inference, not the amount paid at checkout. The markup is applied once when converting a purchase into credits; usage debits actual upstream model cost, without applying a second markup.

| Purchase | Included model credits | Difference before fees and expenses |
| -------- | ---------------------- | ----------------------------------- |
| $10      | $8                     | $2                                  |
| $50      | $40                    | $10                                 |
| $100     | $80                    | $20                                 |
| $200     | $160                   | $40                                 |

These defaults apply to both monthly subscriptions and one-time packs. Monthly allowance expires at the end of its paid period. Purchased credits carry forward independently of the subscription. There are no automatic top-ups or overage charges. This is not an unlimited-use offering, and no fixed number of coding tasks is promised.

A 25% markup on cost is a 20% spread on revenue **before** payment fees, provider funding fees, hosting, support, refunds, fraud and taxes. It is not a 25% profit margin. As a conservative illustration, consuming all $8 of a $10 monthly plan leaves about $0.70 before other expenses when assuming an 8% provider fee, 2.9% + $0.30 payment processing, and 0.7% subscription billing. Actual fees depend on the account and payment method. Public references checked October 9, 2026: [OpenRouter pricing](https://openrouter.ai/pricing), [Stripe pricing](https://stripe.com/pricing), [Stripe Billing](https://stripe.com/billing/pricing).

From `packages/web`, `bun scripts/codium-economics.ts` prints a contribution table for the configured allowances. Its fee assumptions are planning inputs only and never change customer balances. Override `CODIUM_PROVIDER_FEE_PERCENT`, `CODIUM_PAYMENT_FEE_PERCENT`, `CODIUM_PAYMENT_FIXED_USD` and `CODIUM_SUBSCRIPTION_FEE_PERCENT` when the actual commercial terms are known.

## Coding catalog

Codium offers low-cost coding models only, chosen for the most usage per credit without giving up quality. The default allowlist lives in `api/_lib/codium-catalog.ts`; the first entry is the default. These routing ceilings were checked against OpenRouter's public [model catalog](https://openrouter.ai/api/v1/models) and [ZDR endpoint catalog](https://openrouter.ai/api/v1/endpoints/zdr) on October 10, 2026. They require working endpoints with function tools, no training/retention routing, and no additional request/image charges.

| Model                                                                     | Role                                    | Context / max output | Input / output ceiling per million tokens |
| ------------------------------------------------------------------------- | --------------------------------------- | -------------------- | ----------------------------------------- |
| [DeepSeek V4.1 Flash](https://openrouter.ai/deepseek/deepseek-v4.1-flash) | Default everyday model                  | 262,144 / 32,000     | $0.30 / $1.20                             |
| [Xiaomi MiMo V2.6 Flash](https://openrouter.ai/xiaomi/mimo-v2.6-flash)    | Cheapest option for routine work        | 262,144 / 16,384     | $0.26 / $0.41                             |
| [Claude Haiku 5.5](https://openrouter.ai/anthropic/claude-haiku-5.5)      | Strongest low-cost model for hard tasks | 100,000 / 20,000     | $0.22 / $0.55                             |

Why these three, from independent boards that still separate low-cost models (Vals Terminal-Bench 4.0 and 2.1, Vibe Code Bench v1.1, Code Migration) rather than saturated vendor SWE-bench figures, and from cached-input price, which dominates Vector's agent sessions:

- **DeepSeek V4.1 Flash** has the best independent quality per dollar of the low-cost models (Vibe Code 84.7%, Code Migration 45.6%, Terminal-Bench 2.1 74.5%), runs at about 217 tokens/s and has the widest ZDR coverage. The $0.30 / $1.20 ceiling covers the mainstream fp8 ZDR endpoints and leaves out Fireworks US and BaseTen fast. 262K context covers real work; recall across the 1M window is unproven.
- **Xiaomi MiMo V2.6 Flash** is the cheapest per task among credible agentic models (Terminal-Bench 2.1 76.4% at about $0.02 a task) with cached input at $0.002 to $0.004 per million on four of its five ZDR vendors. It streams at about 62 tokens/s, so output is capped at 16,384 tokens to finish inside the gateway's 600-second limit even on a slow provider. The Xiaomi first-party endpoint is not ZDR.
- **Claude Haiku 5.5** has the highest independent quality among low-price models (Vibe Code 90.4%, Terminal-Bench 4.0 35.4%). It is ZDR on Google Vertex and Amazon Bedrock only. Every endpoint bills the whole request at 5x once a prompt reaches 100,000 tokens, so its context is set to 100,000 on purpose: the gateway rejects a prompt plus requested output above that, and the engine compacts at about 80,000. Its input ceiling is $0.22 rather than the $0.11 list price because these endpoints bill prompt-cache writes at up to twice the input price, and the gateway's pre-authorisation must cover them.

Set reasoning effort explicitly when the Codium provider lands in the app so usage stays predictable: DeepSeek high, MiMo default, Haiku high (max adds about five Artificial Analysis Intelligence Index points for about 2.6x the cost per task). The gateway does not restrict quantization, and DeepSeek V4.1 Flash has fp4 ZDR endpoints inside its ceiling that price-weighted routing will favour; restrict routing to fp8 or better before launch if quality on real Vector tasks drops.

These roles are product recommendations from public benchmarks, not measured Vector results. Evaluate completion quality and latency on real Vector coding tasks before launch. Models are selected by the user; this change does not introduce automatic model routing by task difficulty. All models consume the same credit pools, and more expensive models spend them faster. Input, output and billed reasoning count toward usage. Caching can lower actual usage cost.

Do not anchor permanent prices to temporary provider discounts. From `packages/web`, `bun scripts/model-plan-catalog.ts` checks whether the configured catalog still has compatible live endpoints. A model's cheapest advertised provider may have incompatible context, tool support or retention settings. The audit ignores per-search web fees, because the gateway turns off OpenRouter's web plugin and accepts only function tools. Price ceilings fail closed if suitable provider prices rise; review the catalog rather than silently increasing customer cost.

## Account and credit flow

Supabase authenticates the web account. Stripe adapters are implemented but disconnected. A checkout redirect alone never grants credits. The gateway verifies signed Vector account tokens and durable account revocation; server-held encrypted OpenRouter keys make the actual inference requests. Neither management credentials nor inference keys reach the desktop/browser.

Monthly access requires a full paid invoice matching one supported subscription and its current period, with an unrefunded, undisputed charge. Trial, unpaid, paused, refunded, discounted, prorated-only and expired periods do not grant monthly credits. Monthly card checkout is supported initially; coupons, customer-balance-only payments, manual settlement and mid-cycle plan changes are not. The billing portal permits payment-method updates, invoices and cancellation at period end. Cancellation retains the paid remainder of the current period.

Top-up checkout uses one-time payment mode. Credit grants must be tied to an actual paid checkout and its account, price and charge, with durable purchase identity to prevent duplicate grants. Refunds and disputes remove the associated allowance. Purchased credits remain separate from monthly renewals. OpenRouter's capped keys and usage totals are authoritative for spend; a lost or repeated request cannot reset the allowance.

Before inference, the gateway conservatively checks whether the selected pool can cover the bounded request. Monthly credits are used first; purchased credits can cover a request that does not fit the monthly remainder. An upstream response never triggers an automatic retry against the other pool. Parallel spending still depends on OpenRouter's per-key enforcement; local tests do not establish an atomic reservation guarantee for simultaneous real provider requests. Vector does not charge customers automatic overages. Confirm provider behavior under load before enabling sales, and account for possible provider-side overshoot as an operating risk.

Purchased-credit reconciliation reads current payment and dispute state, with Stripe reads limited to batches of eight. This fails closed when payment verification is unavailable and prevents reordered notifications from restoring refunded credits. Verification work still grows with lifetime purchase history; test realistic account histories and provider rate limits before launch. A future durable reconciliation ledger must preserve refund, dispute and deletion correctness rather than trusting cached grants indefinitely.

Account deletion closes new purchases and model access durably, expires pending checkout, cancels recurring subscriptions and disables model keys before identity deletion. Cleanup failures remain retryable. Stripe notifications verify signatures and reconcile current payment state; duplicate or reordered notifications must not mint credits.

## Configuration and deferred activation

Server secrets belong in the hosting environment, never in client builds or the repository. See `.env.example` for the complete list:

- `MODEL_PLANS_ENABLED=false` while payment setup is deferred.
- `MODEL_CREDIT_MARKUP_PERCENT=25` sets default purchase-to-credit conversion.
- `MODEL_PLAN_<price>_CREDITS_USD` and `MODEL_TOPUP_<price>_CREDITS_USD` optionally override the default allowance; valid values are greater than zero and no greater than the purchase price.
- `MODEL_PLAN_MODELS_JSON` optionally overrides the catalog. Blank uses the reviewed defaults; `[]` intentionally offers no models.
- `STRIPE_MODEL_PLAN_<price>_PRICE_ID` and `STRIPE_MODEL_TOPUP_<price>_PRICE_ID` map each of the four prices ($10, $50, $100 and $200) to recurring and one-time prices respectively.
- Stripe secret, webhook secret and portal configuration; OpenRouter management key; a stable 32-byte AES encryption secret encoded as 64 hex characters; existing Vector/Supabase authentication and persistent Redis/Valkey REST configuration.

`bun scripts/setup-model-plans.ts` is a **dry run by default** and shows prices/allowances without connecting to Stripe. Its explicit `--apply` adapter can later create/reuse products and the cancellation portal in the intended test account. Do not run `--apply` until the owner resumes Stripe setup. Register `/api/model-plans/webhook` using API version `2025-02-24.acacia`, with checkout, payment, subscription, invoice, charge/refund and dispute events. Keep sales disabled until the full test flow is verified.

OpenRouter's [terms, section 7](https://openrouter.ai/terms) restrict resale of model API access. Confirm that the bundled Vector offering is covered by appropriate commercial terms before activation. No source change grants this permission.

Remaining launch work requires owner authentication/business verification, funded capacity, actual payment/provider fee terms, secret configuration, legal review of the Codium terms, payment activation, and end-to-end test payments, renewal, cancellation, refund and coding-task checks. Publishing the coming-soon website does not enable paid access. No live Stripe connection, real purchase or provider funding was performed as part of this implementation.
