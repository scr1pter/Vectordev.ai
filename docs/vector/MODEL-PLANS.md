# Vector Codium

Codium is Vector's managed coding-model service: monthly subscriptions plus one-time top-ups, with the same curated model catalog at every price. The workspace stays free. Larger purchases buy more usage, not a different quality tier. **Stripe is intentionally disconnected and `MODEL_PLANS_ENABLED=false`; source changes do not activate sales.** The owner has deferred payment setup.

The public `/codium` page shows the offering without requiring sign-in. The account page adds authenticated balances and future checkout actions. The desktop and CLI show the provider as **Vector Codium**, while its stable internal ID remains `vector-plan`.

Customer-facing amounts use **100 Codium credits per internal USD credit**: the five default purchases include 800, 1,600, 4,000, 8,000 and 16,000 credits. This is a display conversion only; the backend continues accounting in provider-cost USD. Pricing cards show purchase price, credits and estimated tokens, without an internal markup or supplier-cost table. Estimates assume 80% input and 20% output and span the configured models' price ceilings. They are not guaranteed token allotments. Renewal, expiration, carry-forward and cancellation terms remain visible before purchase; `/legal/terms#codium` describes variable consumption and preserves billing-error remedies and mandatory consumer rights.

## Pricing and margin

The starting markup is 25% on model cost, configurable through `MODEL_CREDIT_MARKUP_PERCENT`. USD model credits are the amount available for provider-reported inference, not the amount paid at checkout. The markup is applied once when converting a purchase into credits; usage debits actual upstream model cost, without applying a second markup.

| Purchase | Included model credits | Difference before fees and expenses |
| -------- | ---------------------- | ----------------------------------- |
| $10      | $8                     | $2                                  |
| $20      | $16                    | $4                                  |
| $50      | $40                    | $10                                 |
| $100     | $80                    | $20                                 |
| $200     | $160                   | $40                                 |

These defaults apply to both monthly subscriptions and one-time packs. Monthly allowance expires at the end of its paid period. Purchased credits carry forward independently of the subscription. There are no automatic top-ups or overage charges. This is not an unlimited-use offering, and no fixed number of coding tasks is promised.

A 25% markup on cost is a 20% spread on revenue **before** payment fees, provider funding fees, hosting, support, refunds, fraud and taxes. It is not a 25% profit margin. As a conservative illustration, consuming all $8 of a $10 monthly plan leaves about $0.70 before other expenses when assuming an 8% provider fee, 2.9% + $0.30 payment processing, and 0.7% subscription billing. Actual fees depend on the account and payment method. Public references checked October 9, 2026: [OpenRouter pricing](https://openrouter.ai/pricing), [Stripe pricing](https://stripe.com/pricing), [Stripe Billing](https://stripe.com/billing/pricing).

From `packages/web`, `bun scripts/codium-economics.ts` prints a contribution table for the configured allowances. Its fee assumptions are planning inputs only and never change customer balances. Override `CODIUM_PROVIDER_FEE_PERCENT`, `CODIUM_PAYMENT_FEE_PERCENT`, `CODIUM_PAYMENT_FIXED_USD` and `CODIUM_SUBSCRIPTION_FEE_PERCENT` when the actual commercial terms are known.

## Initial coding catalog

The default allowlist lives in `api/_lib/codium-catalog.ts`. These routing ceilings were checked against OpenRouter's public [model catalog](https://openrouter.ai/api/v1/models) and [ZDR endpoint catalog](https://openrouter.ai/api/v1/endpoints/zdr) on October 9, 2026. They require working endpoints with function tools, no training/retention routing, and no additional request/image charges. Vector initially advertises 128,000 context tokens and caps output at 8,192 for each model.

| Model                                                             | Suggested role                             | Input / output ceiling per million tokens |
| ----------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------- |
| [Qwen3 Coder Next](https://openrouter.ai/qwen/qwen3-coder-next)   | Economical coding default                  | $0.12 / $0.80                             |
| [MiniMax M3](https://openrouter.ai/minimax/minimax-m3)            | Alternative for coding and tool-heavy work | $0.30 / $1.20                             |
| [Kimi K2.7 Code](https://openrouter.ai/moonshotai/kimi-k2.7-code) | Optional higher-cost coding model          | $0.71 / $3.50                             |

These roles are product recommendations, not measured Vector benchmark results. Evaluate completion quality and latency on real Vector coding tasks before launch. Models are selected by the user; this change does not introduce automatic model routing by task difficulty. All models consume the same credit pools, and more expensive models spend them faster. Input, output and billed reasoning count toward usage. Caching can lower actual usage cost.

Do not anchor permanent prices to temporary provider discounts. From `packages/web`, `bun scripts/model-plan-catalog.ts` checks whether the configured catalog still has compatible live endpoints. A model's cheapest advertised provider may have incompatible context, tool support or retention settings. Price ceilings fail closed if suitable provider prices rise; review the catalog rather than silently increasing customer cost.

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
- `STRIPE_MODEL_PLAN_<price>_PRICE_ID` and `STRIPE_MODEL_TOPUP_<price>_PRICE_ID` map each of the five prices to recurring and one-time prices respectively.
- Stripe secret, webhook secret and portal configuration; OpenRouter management key; a stable 32-byte AES encryption secret encoded as 64 hex characters; existing Vector/Supabase authentication and persistent Redis/Valkey REST configuration.

`bun scripts/setup-model-plans.ts` is a **dry run by default** and shows prices/allowances without connecting to Stripe. Its explicit `--apply` adapter can later create/reuse products and the cancellation portal in the intended test account. Do not run `--apply` until the owner resumes Stripe setup. Register `/api/model-plans/webhook` using API version `2025-02-24.acacia`, with checkout, payment, subscription, invoice, charge/refund and dispute events. Keep sales disabled until the full test flow is verified.

OpenRouter's [terms, section 7](https://openrouter.ai/terms) restrict resale of model API access. Confirm that the bundled Vector offering is covered by appropriate commercial terms before activation. No source change grants this permission.

Remaining launch work requires owner authentication/business verification, funded capacity, actual payment/provider fee terms, secret configuration, legal review of the Codium terms, payment activation, and end-to-end test payments, renewal, cancellation, refund and coding-task checks. Publishing the coming-soon website does not enable paid access. No live Stripe connection, real purchase or provider funding was performed as part of this implementation.
