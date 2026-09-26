# Vector pricing proposal — discussion only

Prepared September 26, 2026. No license checks, subscriptions, Stripe products,
checkout prices, entitlements or payment code were changed for this proposal.
The existing HULK behavior remains in place until a separate approved migration.

## Recommendation

Make the desktop and CLI free to download and use with the customer's own provider
account or local models. Sell optional managed model usage and, later, hosted team
administration. A download charge makes people pay before experiencing the product;
a subscription for convenience and measurable usage gives them a reason to upgrade.

Launch with two plans. These are proposed experiment prices, not current offers.

| Plan | Proposed price | Included | At the limit |
| --- | --- | --- | --- |
| Free | $0 | Local workspace, coding agent, manual Vectorscope review and user-owned provider connections; the separately approved shared free-model introduction | Connect the user's OpenRouter account or another provider; retain the workspace and history |
| Pro | $20/month | Free features plus managed premium inference with a $10 monthly model budget, usage visibility and spend controls | Stop managed inference at the cap; offer prepaid top-up or switching to the user's provider |
| Teams, later | Test $30–40/seat/month only after the paid admin features exist | Central billing, real administrative controls, usage reporting and a clearly priced pooled budget | Administrator-controlled hard budget; no unlimited model claim |

The $10 Pro budget means $10 at the selected provider's published inference rate,
including its applicable input/output/cache/request charges. Show dollar usage and
per-model rates, not one universal token count. Ten million tokens can have very
different costs depending on the model, output mix, reasoning, caching and context.
Reviews, subagents, titles and background tasks all consume the same visible managed
budget. Local compute remains on the user's machine; hosted runners would need a
separate compute budget if added later.

Keep provider-key use available on Free. The reason to pay Pro is a simple managed
experience and its included usage. Do not lock existing files or conversations when
a subscription ends. Avoid selling seat controls or enforced enterprise policy on
the strength of the current Teams defaults alone: those settings deliberately allow
local overrides, and are not yet an enterprise enforcement product.

## Economics to test before launch

For planning, use OpenRouter Standard's currently listed 5.5% platform fee; Business
lists 8% and Enterprise is negotiated. These are upstream costs, not a profit margin
Vector automatically receives. Confirm the actual contracted basis and minimums at
launch. [OpenRouter pricing](https://openrouter.ai/pricing)

The examples assume US domestic-card processing at 2.9% + $0.30 and Stripe Billing
at 0.7%, plus an **unmeasured $1/month per paying user** for hosting, search and support.
Country/payment-method fees, tax tooling, refunds and chargebacks may add cost.
[Stripe Payments](https://stripe.com/pricing), [Stripe Billing](https://stripe.com/billing/pricing)

| $20 Pro customer | Actual model usage | Upstream cost with 5.5% | Payment + Billing | Other variable cost assumption | Contribution before fixed costs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Uses half the budget | $5.00 | $5.28 | $1.02 | $1.00 | $12.70 / 63.5% |
| Uses the full budget | $10.00 | $10.55 | $1.02 | $1.00 | $7.43 / 37.2% |
| Uncapped heavy use, for comparison | $30.00 | $31.65 | $1.02 | $1.00 | −$13.67 / −68.4% |

These are unit contribution estimates, not company profit. They exclude engineering,
fixed hosting, acquisition, tax and general overhead. At full budget use, 100 Pro
customers produce $2,000 revenue and about $743 contribution under these assumptions.
The estimate does not depend on customers forgetting to use their allowance.

Test prepaid top-ups of **$10 for $8 of provider-rate usage**. At full consumption,
the same conservative fee assumptions leave about $0.90 before incremental hosting
and support. That thin margin is why cheap microtransactions and usage-only revenue
are weak starting points. Display the conversion clearly; do not advertise this as
provider pricing without a markup. If support/search is expensive, raise the service
portion or lower the included budget rather than silently degrading model quality.

Start monthly. After measured costs justify it, an illustrative $216 annual plan
would renew the same $10 budget monthly, not grant the full year's budget on day one.
Its full-consumption contribution is about $5.78/month, or 32.1%, under the same
assumptions. The existing $99 annual workspace plan must not silently become this
more expensive product.

## How OpenRouter fits

The shared free-model allowance is an onboarding benefit, not a source of paid
premium capacity or revenue. Free model limits remain account/model dependent and
availability can change. Connecting a user's own account keeps that user's usage
and provider bill separate from Vector's managed budget.
[OpenRouter limits](https://openrouter.ai/docs/api_reference/limits)

Before charging for managed inference, obtain written confirmation for this exact
embedded coding-agent model. The current terms contemplate integration into a
customer product while also prohibiting resale of model API access. Do not infer
that selling generic API keys or relabelled API access is approved. Ask whether an
Enterprise order form or another agreement is appropriate, including provider terms,
data handling and fees. The existing free-model approval request does not by itself
approve this separate paid offering. No outreach or agreement acceptance was performed.
[OpenRouter terms](https://openrouter.ai/terms),
[Enterprise agreement](https://openrouter.ai/terms-of-service-enterprise)

Current comparison: Cursor offers a free Hobby tier and an individual plan starting
at $20/month; its plans include model usage with additional on-demand billing.
This supports the free-entry/paid-convenience structure, not any assumption about
Vector's own costs. [Cursor pricing](https://cursor.com/pricing)

The Windsurf pricing URL currently redirects to Devin. That page lists Free and
$20/month Pro, with extra usage purchasable at API pricing. Do not use older Windsurf
credit tables as current benchmarks. [Devin pricing](https://devin.ai/pricing)

## Future implementation map, not implemented

1. Separate account identity from paid entitlements. Retire a mandatory workspace
   license wall only in an approved migration; preserve existing paid customers'
   remaining term or offer explicit credits/refunds according to the agreed policy.
2. Use an authenticated Vector server for managed paid requests. Keep the upstream
   key server-side. Keep the current no-paid-fallback free-model route separate so a
   free task can never silently incur charges.
3. Reserve a bounded cost before each provider call, including parallel subagents;
   reconcile against authoritative provider usage afterwards with idempotent request
   records. Restrict expensive extras and model choices to the reviewed budget rules.
4. Maintain an atomic server ledger for monthly grants, top-ups, reservations,
   settlements, refunds and billing webhooks. Device-reported token counts cannot
   authorize spend. A failed or interrupted stream still needs reconciliation.
5. Warn before the limit, stop at the cap and require explicit opt-in for top-ups or
   automatic recharge. Switching to a personal key continues the same conversation.
6. Pilot with a small consenting cohort. Measure task cost and monthly user cost at
   median, 90th and 99th percentiles, parallel-call exposure, search/support costs,
   conversion and retention. Set final allowances from those observations, and
   reconfirm the margin when model prices or upstream terms change.

Before implementation, decide the launch allowance, whether to offer top-ups at all,
the treatment of current monthly/yearly HULK customers, and the written OpenRouter
commercial approval. None of those decisions is encoded in this release candidate.
