# Vector account and Builder setup

Vector's account surfaces are intentionally fail-closed. They become available only after every required server-owned credential is configured. Never place service-role, Stripe, Resend, vault, license, cron, Blob write, or platform model credentials in browser-visible variables.

## 1. Supabase

1. Create the production Supabase project.
2. Apply all migrations in `supabase/migrations`, including `20260813010000_vector_builder.sql`.
3. Set the production site URL to `https://vectordev.ai`.
4. Add `/account`, `/billing`, `/download`, and `/settings` on the production domain to the redirect allowlist.
5. Enable email/password sign-in.
6. Enable Google in Supabase Auth and use the callback URL Supabase provides in the Google OAuth application.
7. Leave `VECTOR_AUTH_PROVIDERS` empty to discover enabled providers automatically, or set an explicit allowlist such as `google`.

Required Vercel variables:

```text
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
VECTOR_PLATFORM_SECRET
```

`VECTOR_PLATFORM_SECRET` must be a random secret of at least 32 characters. During a rotation, put the prior secret in `VECTOR_PLATFORM_SECRET_PREVIOUS`, deploy, re-save encrypted connections with the new key, and remove the old key only after the rotation is complete.

## 2. Stripe

1. Create a recurring monthly price for USD $10.
2. Create a recurring annual price for USD $99.
3. Enable the Stripe customer portal for payment-method and cancellation management.
4. Create a webhook endpoint at `https://vectordev.ai/api/billing/webhook`.
5. Subscribe it to checkout, subscription, invoice failure, invoice action, and invoice payment events.

Required Vercel variables:

```text
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_MONTHLY
STRIPE_PRICE_ANNUAL
VECTOR_LICENSE_SECRET
```

Monthly renewal failures receive a three-day grace period. Failed initial payments and annual-plan failures do not receive that monthly grace rule.

## 3. Transactional email

Verify the sending domain in Resend, then set:

```text
RESEND_API_KEY
VECTOR_PURCHASE_EMAIL_FROM=Vector <licenses@vectordev.ai>
```

Vector sends purchase, license, and failed-renewal notices. Stripe remains the source of truth for payment state.

## 4. Protected installers

Create a private Vercel Blob store and upload the platform installers beneath `releases/vector-downloads/`, then set:

```text
VECTOR_INSTALLER_BLOB_PRIVATE=true
VECTOR_INSTALLER_BLOB_TOKEN
VECTOR_INSTALLER_BLOB_PREFIX=releases/vector-downloads
```

The installer route verifies the signed-in subscription and download claim before streaming a private object. Keep public installer URLs disabled.

## 5. Vector Builder

Vector Builder runs every build inside an isolated persistent Vercel Sandbox. Configure a server-owned model or let subscribed users connect their own provider in Settings.

```text
VECTOR_PUBLIC_URL=https://vectordev.ai
OPENROUTER_API_KEY
VECTOR_BUILDER_MODEL=openrouter/openrouter/free
VECTOR_BUILDER_MODELS=openrouter/openrouter/free
VECTOR_BUILDER_ENGINE_COMMAND=opencode
VECTOR_BUILDER_SANDBOX_IMAGE=vector-builder@sha256:<immutable-digest>
VECTOR_BUILDER_MAX_MINUTES=30
VECTOR_BUILDER_30_DAY_LAUNCH_LIMIT=24
VECTOR_BUILDER_30_DAY_TURN_LIMIT=240
CRON_SECRET
```

Build `infra/vector-builder/Containerfile` and publish it to Vercel Container Registry under the Builder image name. Pin `VECTOR_BUILDER_SANDBOX_IMAGE` to its immutable digest. The image contains the Vector execution runtime, Bun, and Chromium/Playwright support.

The cron in `vercel.json` starts queued builds, refreshes active builds, and stops stale sandboxes. Confirm `/api/cron/builder-reconcile` runs every minute and receives `Authorization: Bearer $CRON_SECRET`.

Users may connect BYOK providers, MCP servers, and a paired Vector Desktop computer. Browser and shell permissions are separately controlled in Settings. Each remote computer action is approval-gated locally.

## 6. Release verification

1. Build with production Vercel environment variables.
2. Create and confirm a new account.
3. Complete both monthly and annual Stripe test checkouts.
4. Replay failed and successful renewal webhooks.
5. Claim a license on one computer and verify a second computer is rejected.
6. Download each installer from a subscribed account.
7. Create a Builder project, run it, open its preview, send a follow-up, restart it, and delete it.
8. Connect one BYOK provider and one MCP server, then verify each is available only to its owner.
9. Pair one desktop computer and confirm browser and shell actions require local approval.
10. Confirm no secret appears in logs, screenshots, build history, or browser responses.
11. Repeat the flow in Stripe live mode before paid launch.
