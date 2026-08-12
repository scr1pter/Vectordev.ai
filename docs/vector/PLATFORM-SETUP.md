# Vector Account, Billing, API, and Cloud Agent Setup

The account surfaces are intentionally fail-closed. They become available only after every required server-owned credential is configured. Never place service-role, Stripe, Resend, OpenRouter, vault, license, cron, or Blob write credentials in browser-visible variables.

## 1. Supabase

1. Create the production Supabase project.
2. Run `supabase/migrations/20260811000000_vector_platform.sql` in the SQL editor or through the Supabase CLI.
3. Set the production site URL to `https://vectordev.ai`.
4. Add redirect URLs for `/account`, `/download`, `/cloud-agents`, and `/api-studio` on the production domain.
5. Enable email/password sign-in.
6. Enable Google in Supabase Auth and use the callback URL Supabase provides in the Google OAuth application.
7. Leave `VECTOR_AUTH_PROVIDERS` empty to let Vector discover enabled Supabase providers automatically. Set it only when you want an explicit allowlist such as `google` or `github,google`.

Required Vercel variables:

```text
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
VECTOR_PLATFORM_SECRET
```

Google sign-in requires a Google Cloud web OAuth client. Add Supabase's callback URL to that client's authorized redirect URIs, save its client ID and secret in Supabase Auth, and add `https://vectordev.ai/account`, `https://vectordev.ai/download`, `https://vectordev.ai/cloud-agents`, and `https://vectordev.ai/api-studio` to the Supabase redirect allowlist. Vector checks Supabase's live provider settings before showing an OAuth button, so a half-configured provider is never advertised.

`VECTOR_PLATFORM_SECRET` must be a random secret of at least 32 characters. During a rotation, put the prior secret in `VECTOR_PLATFORM_SECRET_PREVIOUS`, deploy, re-save encrypted connections with the new key, and remove the old key only after the rotation is complete.

## 2. Stripe

1. Create a recurring monthly price for USD $10.
2. Create a recurring annual price for USD $99.
3. Enable the Stripe customer portal for payment-method and cancellation management.
4. Create a webhook endpoint at `https://vectordev.ai/api/billing/webhook`.
5. Subscribe it to:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
   - `invoice.payment_action_required`
   - `invoice.paid`
   - `invoice.payment_succeeded`

Required Vercel variables:

```text
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_MONTHLY
STRIPE_PRICE_ANNUAL
VECTOR_LICENSE_SECRET
```

`VECTOR_LICENSE_SECRET` must be a separate random secret of at least 32 characters. Monthly renewal failures receive a three-day grace period. Failed initial payments and annual-plan failures do not receive that monthly grace rule.

## 3. Transactional email

Verify the sending domain in Resend, then set:

```text
RESEND_API_KEY
VECTOR_PURCHASE_EMAIL_FROM=Vector <licenses@vectordev.ai>
```

Vector sends purchase/license confirmation and failed-renewal notices. Stripe remains the source of truth for payment state.

## 4. Protected installers

Create a private Vercel Blob store and upload these exact objects beneath `releases/vector-downloads/`:

```text
vector-desktop-mac-arm64.dmg
vector-desktop-mac-x64.dmg
vector-desktop-win-x64.exe
vector-desktop-win-arm64.exe
vector-desktop-linux-x86_64.AppImage
vector-desktop-linux-arm64.AppImage
```

Set:

```text
VECTOR_INSTALLER_BLOB_PRIVATE=true
VECTOR_INSTALLER_BLOB_TOKEN
VECTOR_INSTALLER_BLOB_PREFIX=releases/vector-downloads
```

The installer route verifies the signed-in subscription and one-time download claim before streaming a private object. Keep public installer URLs disabled.

## 5. Vector API Platform and Play Park

The API Platform uses the Supabase tables and `VECTOR_PLATFORM_SECRET` above. Set the public origin and optional quotas:

```text
VECTOR_PUBLIC_URL=https://vectordev.ai
VECTOR_API_DAILY_EXECUTION_LIMIT=500
```

Play Park blocks local, private, metadata, and reserved network destinations. Saved environment secrets are encrypted at rest and are never returned in API history responses.

## 6. Vector Cloud Agents

Create an OpenRouter API key and enable Vercel Sandbox, then set:

```text
OPENROUTER_API_KEY
VECTOR_CLOUD_AGENT_MODEL=openrouter/openrouter/free
VECTOR_CLOUD_AGENT_MODELS=openrouter/openrouter/free,openrouter/poolside/laguna-s-2.1:free,openrouter/cohere/north-mini-code:free,openrouter/nvidia/nemotron-3-super-120b-a12b:free,openrouter/openai/gpt-oss-20b:free
VECTOR_CLOUD_AGENT_ENGINE_COMMAND=opencode
VECTOR_CLOUD_SANDBOX_IMAGE=vector-cloud-agent@sha256:<immutable-digest>
VECTOR_CLOUD_AGENT_MAX_MINUTES=30
VECTOR_CLOUD_AGENT_30_DAY_LAUNCH_LIMIT=24
VECTOR_CLOUD_AGENT_30_DAY_TURN_LIMIT=240
CRON_SECRET
```

Every configured cloud model must use the `openrouter/` provider prefix. Each run receives an isolated persistent sandbox. Repository URLs must be credential-free public HTTPS Git URLs; private-repository brokering is deliberately disabled until a scoped GitHub installation flow exists.

The first model is the default. `openrouter/openrouter/free` delegates selection to the current free pool and filters for capabilities required by the request, including tool calling. The remaining entries expose specific coding-oriented free choices. OpenRouter's free inventory and rate limits change over time, so verify the live catalog before changing the curated list. Paid models can remain available as explicit upgrades.

Build `infra/vector-cloud-agent/Containerfile` and push it to Vercel Container Registry, then set `VECTOR_CLOUD_SANDBOX_IMAGE` to the project-local repository name plus the immutable digest printed by `vercel vcr image inspect` (omit the `vcr.vercel.com/<team>/<project>/` prefix). The image contains the pinned Vector agent engine, Bun, and Chromium/Playwright runtime. Cloud Agents remain unavailable until both this image and the scheduled reconciler are configured, rather than launching an incomplete workspace that must download its execution engine at run time.

The Vercel cron in `vercel.json` starts queued runs, refreshes active runs, and advances multi-agent teams. Confirm `/api/cron/agent-reconcile` runs every minute and receives `Authorization: Bearer $CRON_SECRET`.

## 7. Release verification

Before enabling the navigation publicly:

1. Build with production Vercel environment variables.
2. Create and confirm a new account.
3. Complete both monthly and annual Stripe test checkouts.
4. Replay failed and successful renewal webhooks.
5. Claim a license on one computer and verify a second computer is rejected.
6. Download each installer once from a subscribed account.
7. Create, run, stop, and review one Cloud Agent and one multi-agent team.
8. Execute a public test API request in Play Park and verify the evidence history.
9. Confirm no secret appears in logs, screenshots, API history, or browser responses.
10. Repeat the flow in Stripe live mode before paid launch.
