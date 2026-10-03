# Stripe wind-down

Vector is free, and the website no longer sells desktop licences.

## Verified status — 3 October 2026 UTC

The Vercel environment cleanup is complete. `VECTOR_ACCESS_MODE` was removed from its shared production/preview entry. The four `STRIPE_*` variables below were already absent. A fresh project-wide environment listing confirmed that all five retired variables are absent in production, preview, and development, and that all five retained variables remain present. No secret values were read or printed.

Stripe opened at its sign-in screen. Subscriptions and webhook endpoints could not be inspected, so dashboard cleanup remains an owner action; no cancellations, refunds, or webhook changes were made.

## In the Stripe dashboard

1. Sign in to the Vector Stripe account and select live mode.
2. Open [Subscriptions](https://dashboard.stripe.com/subscriptions). For each live Vector subscription, open its overflow menu, choose **Cancel subscription**, select **Immediately**, review the refund and final-invoice options, and confirm cancellation. Avoid creating a final charge. Check for remaining pending invoice items and subscription schedules so they cannot restart billing. Make any refund decision yourself.
3. Open [Workbench webhooks](https://dashboard.stripe.com/workbench/webhooks), locate the destination whose URL is exactly `https://vectordev.ai/api/billing/webhook`, and delete that endpoint. Leave unrelated destinations alone.
4. Confirm that no live Vector subscriptions or matching webhook remain. If neither existed, record that result.

Stripe documents the [dashboard cancellation flow and pending-invoice behavior](https://docs.stripe.com/billing/subscriptions/cancel) and [webhook endpoint deletion](https://docs.stripe.com/api/webhook_endpoints/delete).

## In Vercel

These variables must remain absent from every environment in the `vectordev-ai` project:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_MONTHLY`
- `STRIPE_PRICE_ANNUAL`
- `VECTOR_ACCESS_MODE`

Keep these; the site still uses them (see [hosted setup](../HOSTED-SETUP.md)):

- `VECTOR_LICENSE_SECRET` — signs CLI tokens and rate-limit hashes. Removing it signs everyone out of the terminal agent.
- `RESEND_API_KEY` and `VECTOR_PURCHASE_EMAIL_FROM` — bug-report email.
- `BLOB_READ_WRITE_TOKEN` — installer downloads and updates.
- `VECTOR_PUBLIC_URL`
