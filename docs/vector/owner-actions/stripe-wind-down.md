# Stripe wind-down

Vector is free, and the website no longer sells desktop licences. Close out the old Stripe setup once the free release is live.

## In the Stripe dashboard

1. Cancel any live Vector subscriptions so nobody is charged again. Refund recent payments where that is fair.
2. Delete the webhook endpoint `https://vectordev.ai/api/billing/webhook`.

## In Vercel

Remove these variables from the production project:

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
