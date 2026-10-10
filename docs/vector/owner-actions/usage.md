# Vector usage counts: production setup

Usage counts tell the owner how many people use Vector, whether they come back, and which versions and platforms matter. They are counts only. The source is ready; production stays dark until the steps below are done.

## What is recorded

- Desktop check-in, `POST /api/usage/checkin`: a random install ID, the account ID when the desktop is signed in (taken from the verified Vector account token, never from the request body), app version, OS, CPU architecture, and that day's session and subagent-session counts. One row per install per UTC day; a later check-in the same day never lowers a count.
- CLI: the daily account check, `POST /api/account/cli-verify`, records one row per account per UTC day when the CLI sends `x-vector-version` and `x-vector-platform` and not `x-vector-usage: off`. Older CLIs send neither header and are not counted, because they cannot honour `VECTOR_DISABLE_USAGE`.
- Downloads, `GET /api/download`: one row per successful installer request, against the signed-in account, with the target and version.
- Never: prompts, code, file names or paths, model output, provider names or keys, IP addresses or user agents. The check-in endpoint's abuse limiter keeps an HMAC of the network address in KV for one hour, separately from the counts.
- Retention: rows older than 400 days (about 13 months) are deleted whenever a new row is written. Account deletion calls `vector_usage_forget` before removing the identity; the foreign keys to `auth.users` also cascade.

## Setup

1. In Vector's Supabase project, review and run [sql/usage.sql](sql/usage.sql) in the SQL editor. It is idempotent. It creates two tables with row-level security and no policies, and four `SECURITY DEFINER` functions that only the service role may execute.
2. Confirm Vercel production has `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (already used by public sessions and account deletion). Without them every check-in still answers 204 and nothing is stored.
3. Optionally set `VECTOR_ADMIN_EMAILS` (comma-separated) to the accounts allowed to read the dashboard. It falls back to `VECTOR_DESIGN_LAB_EMAILS`, then to the owner's address. Access also requires a Google sign-in, exactly as for the Design Lab.
4. In the Vercel project, enable Web Analytics. The site loads the first-party `/_vercel/insights/script.js` on public pages only; until Web Analytics is enabled that script returns 404 and nothing is counted. It sets no cookies and sends only the page path.
5. Deploy, then open `https://vectordev.ai/usage`, sign in with Google, and confirm the dashboard loads. With no check-ins yet it says so.
6. Review the usage-count section of [the privacy policy](../../../packages/web/src/pages/legal/privacy.astro) before the desktop and CLI releases that send counts ship.

## Validation

`test/usage-api.test.ts` covers the endpoints with an injected fetcher. `packages/web/test/usage-sql.test.ts` runs this exact SQL on a disposable PostgreSQL 17 through the API code; the `Vector usage counts integration` workflow runs it on pull requests that touch it. That is local verification, not evidence that the SQL was applied to the production project.
