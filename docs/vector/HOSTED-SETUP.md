# Vector hosted setup

vectordev.ai runs Vector accounts, CLI tokens, downloads and bug reports from serverless functions on the production Vercel project. Vector is free: a Vector account is all anyone needs to download the desktop app and to sign in the terminal agent.

## Environment

Configure these server-only variables on the production Vercel project:

```text
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
VECTOR_LICENSE_SECRET=
RESEND_API_KEY=
VECTOR_PURCHASE_EMAIL_FROM=Vector <support@vectordev.ai>
VECTOR_PUBLIC_URL=https://vectordev.ai
BLOB_READ_WRITE_TOKEN=
```

- `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` connect the site to the Supabase project that holds Vector accounts. `SUPABASE_SERVICE_ROLE_KEY` lets account deletion remove the Supabase user.
- `VECTOR_LICENSE_SECRET` signs `vct_` CLI tokens and the hashes behind request rate limits. Despite its name it has nothing to do with licences. It must be a stable random value of at least 32 characters. Never remove or rotate it casually: changing it signs everyone out of the terminal agent and resets rate-limit counters.
- `RESEND_API_KEY` and `VECTOR_PURCHASE_EMAIL_FROM` send bug-report email. The sender name is historical; keep it set.
- `VECTOR_PUBLIC_URL` is the public origin used in links the site generates.
- `BLOB_READ_WRITE_TOKEN` gives access to the release store (see below).

The other groups in `.env.example` (the hosted OAuth broker and the Help assistant) are documented there.

## Installer storage

Vector's updater and account downloads resolve through the same public release store. `BLOB_READ_WRITE_TOKEN` must be that store's real `vercel_blob_rw_...` token; placeholders are rejected. The release workflow uploads immutable installers first and publishes `releases/vector-downloads/latest.json` last, so every download surface switches versions as one atomic release.

## Release check

1. Create a fresh Vector account and confirm the account page offers each installer.
2. Download each relevant installer and confirm it matches the version and checksum in the release manifest.
3. Run `vector login` with the same account (or paste a token from `vectordev.ai/auth/cli`) and confirm `vector whoami` shows it.
