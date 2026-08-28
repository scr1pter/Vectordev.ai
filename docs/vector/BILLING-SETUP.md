# Vector billing and licensing

Vector sells one-device desktop licenses through Stripe. The public website does not require an account: a customer selects the monthly or annual plan, enters an email address, completes Stripe Checkout, and receives the license key by email and on the purchase-complete page.

## Hosted environment

Configure these server-only variables on the production Vercel project:

```text
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_MONTHLY=
STRIPE_PRICE_ANNUAL=
VECTOR_LICENSE_SECRET=
RESEND_API_KEY=
VECTOR_PURCHASE_EMAIL_FROM=Vector <licenses@vectordev.ai>
VECTOR_PUBLIC_URL=https://vectordev.ai
BLOB_READ_WRITE_TOKEN=
```

`VECTOR_LICENSE_SECRET` must be a stable random value of at least 32 characters. Losing or changing it invalidates existing license and download signatures.

## Stripe products

Create one recurring monthly price at $10 and one recurring annual price at $99. Put their `price_...` identifiers in `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_ANNUAL`.

Configure the webhook endpoint at `https://vectordev.ai/api/billing/webhook` for checkout completion, subscription changes, invoice payment failure, invoice payment success, and subscription deletion. The monthly plan receives a three-day payment grace period; annual access remains valid through the paid term after cancellation.

## Installer storage

Vector's updater, free downloads, and licensed downloads all resolve through the same public release store. `BLOB_READ_WRITE_TOKEN` must be that store's real `vercel_blob_rw_...` token; placeholders are rejected. The release workflow uploads immutable installers first and publishes `releases/vector-downloads/latest.json` last, so every download surface switches versions as one atomic release.

The billing API creates a short-lived download token after a paid checkout. The public installer bytes are intentionally shareable; the desktop license controls whether the installed application can be used.

## Release check

1. Complete one monthly and one annual test checkout.
2. Confirm the license email arrives and the purchase-complete page shows the same key.
3. Download each relevant installer and confirm it matches the version and checksum in the release manifest.
4. Activate the license on a clean computer and confirm a second device is rejected.
5. Exercise cancellation, payment-failure email, the monthly grace window, and reactivation in Stripe test mode before enabling live mode.
