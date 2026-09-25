# Vector public sessions: production setup and privacy review

Implementation is ready for integration testing. Production is not enabled by this document. The owner applies the new database migration and approves the privacy wording below before publishing the feature.

## Setup

1. In Vector's existing Supabase project, review and run [sql/public-shares.sql](sql/public-shares.sql) in the SQL editor. It creates a private table, a server-only transactional function, and an account-deletion trigger. It does not expose a table policy to anonymous or signed-in browser clients.
2. Confirm the existing Vercel production environment contains `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VECTOR_CLI_TOKEN_SECRET`, and the configured KV/Upstash REST URL and token. Add any missing values yourself. Do not paste secret values into source, CLI arguments, screenshots or this document. The server's service-role key never reaches desktop, CLI, browser or public responses.
3. Configure `CRON_SECRET` in Vercel. `/api/shares/cleanup` runs every ten minutes and erases up to 100 expired payloads per invocation. Monitor unsuccessful runs and increase cleanup capacity if the backlog grows. Public reads reject expired content immediately, independently of cleanup.
4. Deploy the reviewed branch only after the release approval. Confirm `/s/<id>` serves the static viewer shell, while `/api/shares/<id>` reaches the function. The build's prune allowlist includes `s`.
5. With a disposable test account, publish a synthetic conversation after reviewing the consent dialog. Open the URL signed out, update it only if updates were selected, then unshare. Both the viewer and direct API must stop returning content. Repeat a pending create/update after deletion and confirm it remains unavailable.
6. Expire another test share and run the authenticated cleanup job; verify the snapshot is null. Delete the disposable account through normal account settings and verify its public snapshots are removed. Never use real private source code for these checks.
7. Approve and insert the draft below into the privacy policy. Confirm Supabase storage region, backup retention and the applicable processor agreement in Vector's account; those account settings were not read or changed during development.

## Service contract and retention

- POST `/api/shares` requires an exact signed Vector account bearer token, authoritative revocation lookup and current explicit consent. PUT and DELETE additionally require the locally retained management secret and same owner. Client-generated IDs and secrets make lost-response retries safe; secrets travel only in authenticated request bodies and are stored as hashes on the server.
- GET `/api/shares/<id>` is public while the link is active. It returns a versioned visible transcript, expiry, update choice and revision. It never returns account identity, management secrets, local settings, permission state or hidden system context. A link is public access, not a password: anyone with it can read or copy the content.
- The transcript includes visible prompts, assistant text, reasoning displayed by the client, code and tool input/output. Those fields may contain sensitive information. Vector does not promise automatic secret removal. Attachments are descriptive labels; the viewer/importer never fetches local files or arbitrary attachment URLs.
- Expiry is at most 30 days. Published snapshots stop being readable immediately at expiry, revocation, unshare or account deletion. Unshare and account deletion erase the live payload immediately; cleanup erases expired live payloads in batches. Database backups follow the owner's confirmed Supabase retention policy.
- A minimal deletion record remains permanently: random ID, management-secret hash, timestamps and owner ID until account deletion. Account deletion clears the owner too. These records prevent delayed network retries from recreating removed links. Do not purge them without a permanent replacement ID-denial mechanism.
- Current limits are 20 active shares per account, 20 create attempts per day, 60 mutation requests per minute per account, and 120 public reads per minute per IP. KV unavailability fails closed. Request payloads are limited to 4 MB; large sessions must be exported locally instead of silently truncated.
- Updates require the publishing user's choice. Project `share`/`autoshare` settings alone do not authorize uploads. Remembered consent is local, bound to the signed-in account and consent version. GitHub workflows require separate current consent acknowledgment; sharing defaults off.

## Privacy policy draft — owner approval required

**Public session sharing.** If you choose to publish a session, Vector stores its visible conversation content in Vector's Supabase service so anyone with the link can view it. This can include prompts, code, assistant responses and visible tool input and output. Review the content before publishing; it may contain confidential information or secrets. Sharing does not upload your account credentials, application settings or hidden system instructions. Attached files are represented by descriptive labels rather than fetched by the public viewer.

You choose whether later conversation updates are published and when the link expires, up to 30 days. You can remove a public session from Vector. Removal, expiry or account deletion disables public access; removed live content is erased, and expired live content is erased by a scheduled cleanup process. Backup retention follows our confirmed service-provider policy. People who previously viewed a public session may keep their own copies, which Vector cannot remove. A minimal deletion record is retained to prevent old upload requests from restoring a removed link. Public sessions are marked against search indexing, but that instruction does not make a public link private.

## Validation and references

The hosted tests execute this exact SQL on disposable PostgreSQL 17.11 and the production rate-limit/revocation commands on Valkey 7.2.14. They cover ownership, secret hashing, explicit consent, excess-field and size rejection, revision races, delete-before-create tombstones, expiry, account deletion, cleanup, anonymous database privileges, redirect refusal and unavailable storage. This is local verification, not evidence of deployment into the owner's Supabase project.

Supabase documents [database functions and function privileges](https://supabase.com/docs/guides/database/functions) and [row-level security and service roles](https://supabase.com/docs/guides/database/postgres/row-level-security). The RPC uses security-invoker execution, an empty search path and explicit schema-qualified objects. Public and authenticated roles have no table or function access; only the server service role can invoke it.
