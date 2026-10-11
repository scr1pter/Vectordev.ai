# Vector Cloud OAuth

## Current availability

The Cloud completion changes described here are prepared for **1.99.99** and
are not a published desktop release. Provider application registration, hosted
configuration and a real browser-to-desktop consent check are separate release
steps. No Vercel or Supabase registration has been confirmed complete
for this checkpoint. Do not infer readiness from a successful build or test.

Vector Cloud supports two providers: Vercel for hosting and Supabase for data.
Vector connects accounts and resources that belong to the user. Provider
billing, quotas and terms still apply; guarded free OpenRouter inference does
not make hosting or database operations free. Never upgrade a plan, add payment,
or retry resource creation in another organization automatically.

## Authorization and credential boundaries

The hosted broker signs provider-bound OAuth state with a ten-minute expiry.
For Vercel, the browser callback returns an encrypted authorization result to
the pending desktop flow: the Vercel authorization code is protected by an
ephemeral desktop relay. The private key stays with that flow; there is no
plaintext custom-URL fallback. The relay format is versioned. Current desktops
advertise `relay=v1` when checking hosted readiness. An absent or unknown relay
capability keeps Vercel unconfigured in
that response, preserving the manual-token form in desktop 1.99.8 even after
their server credentials are installed. A direct incompatible start still fails
with an update instruction; it never falls back to plaintext.
Supabase uses an authorization-code flow with S256 PKCE.

The desktop checks the pending state and provider identity before saving a
connection. Unrelated callbacks do not cancel a valid pending flow, and a
failed identity request does not produce a connected account. Provider access
and refresh tokens are encrypted in the local credential vault. The renderer
receives account metadata, not the stored management token. Its manual-token
draft is cleared after successful connection, before resource listing.

No provider client secret or OAuth state-signing secret belongs in the desktop
bundle, a renderer environment variable, a public API response or a project
repository. Keep these values server-only: never use `VITE_`, `PUBLIC_` or
`NEXT_PUBLIC_` prefixes for them.

## Hosted environment

Set these variables in the server environment of the production Vercel project
that serves `vectordev.ai`:

```text
VECTOR_OAUTH_PUBLIC_URL=https://vectordev.ai
VECTOR_OAUTH_STATE_SECRET=<at least 32 random characters>

VECTOR_VERCEL_INTEGRATION_SLUG=<registered Vercel integration slug>
VECTOR_VERCEL_CLIENT_ID=<Vercel integration client ID>
VECTOR_VERCEL_CLIENT_SECRET=<Vercel integration client secret>

VECTOR_SUPABASE_CLIENT_ID=<Supabase OAuth application client ID>
VECTOR_SUPABASE_CLIENT_SECRET=<Supabase OAuth application client secret>
```

Generate the signing secret
with a cryptographically secure generator, store it through the deployment
secret manager, and keep it stable. Rotating it invalidates in-progress flows.
Use separate provider applications and secrets for development and preview.
Never copy a production secret into a committed `.env` file or diagnostic log.

Readiness fails closed when the signing secret is missing or shorter than 32
characters, or when required provider variables are absent. Missing names may
be reported; their values are not. Configured means the required settings and
the desktop's required relay capability are present, not that registration,
permissions or live consent have been verified. Supabase readiness is unchanged:
desktop 1.99.8 already supports its S256 PKCE flow.

Desktop **Vector Cloud → Connections** offers hosted sign-in when configured.
If hosted OAuth is unavailable and this desktop supports manual tokens, it
instead offers the provider's personal-access-token flow with local encrypted
storage. Older unsupported desktops show an unavailable state. The Database
panel routes users to this same connection setup, including manual Supabase
access when available.

## Callback URLs and identity access

Register these exact HTTPS callback URLs:

```text
https://vectordev.ai/api/cloud/oauth/callback-vercel
https://vectordev.ai/api/cloud/oauth/callback-supabase
```

Grant only the management access required for the selected operations:

- Vercel: user identity (`/v2/user`, including User read), selected team/project
  listing, deployment, environment variables and project domains.
- Supabase: the OAuth app's scopes must cover every control in Vector Cloud
  and the agent's tool
  ([scope list](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration/oauth-scopes)):
  Organizations read; Projects read and write (create, pause, restore);
  Database read and write (SQL, migrations, pooler, password rotation); Secrets
  read and write (API keys, Edge Function secrets); Auth read and write; Edge
  Functions read and write; Storage read; and Analytics read for logs and the
  security advisors where the dashboard offers it. Users who connected before
  a scope was added must reconnect for it to apply. A personal access token
  already carries the account's full access.

Do not request billing or destructive account-wide permissions. Provider
configuration must support the identity checks: a token exchange alone is not
a completed connection.

## Project variables and Supabase client keys

Provider connections are account-level; selected destinations and stored cloud
variables belong to a repository. The UI clears drafts and revealed values
when the project or task changes and ignores delayed results from the previous
view. Variable names retain their case. Values are hidden by default; use
Reveal deliberately.

Stored values are encrypted with the same local credential vault as provider
tokens; values saved in plaintext by an older release are encrypted the first
time they are read. Each variable is public or server-only. A name with a
browser-visible prefix (`VITE_`, `NEXT_PUBLIC_`, `PUBLIC_`, `REACT_APP_`,
`EXPO_PUBLIC_`, `NUXT_PUBLIC_`, `GATSBY_`, `VUE_APP_`, `STORYBOOK_`) is public;
a server-only value can never be saved under such a name.

Adding or removing a variable updates Vector's project configuration. **Write
to .env** applies the current list, including an empty list after the final
removal. It preserves content above Vector's managed marker. A successful load
is required before an empty list can be applied. The writer rejects a symbolic
link or non-regular `.env`, stages a private file and replaces the directory
entry atomically; new files use mode `0600` where POSIX modes apply. It does
not encrypt the project's `.env` contents.

For projects positively identified as Vite by their saved framework or a Vite
dependency, serialization preserves literal dollars and backslashes through
Vite's environment parser. Enter literal values, not variable-expansion
expressions. Multiline values and quote combinations that cannot be represented
literally are rejected before replacing `.env`; use the hosting provider's
environment settings for such values. Other project types retain their existing
serialization, so this is not a guarantee about every framework's parser.

Supabase connection writes the project URL and publishable (or legacy
anonymous) key under the names the framework exposes to browser code:
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` for Next.js,
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for Vite, and `SUPABASE_URL`
and `SUPABASE_ANON_KEY` otherwise. It scaffolds `src/lib/supabase.ts` (or `.js`
without a `tsconfig.json`; `lib/` for a Next.js app without `src/`) unless a
client already exists, and adds `.env` to `.gitignore` when git does not
already ignore it. Management, secret, service-role and user-session keys are
never placed in these browser-visible variables.

The service-role or secret key is read from the Management API only inside the
desktop main process, for the project's Auth admin and Storage APIs (users and
buckets). It is kept in memory for that one operation, never written to the
environment, `.env` or the scaffold, and scrubbed from every error and result,
as are the management token, database passwords and stored environment values.
`DATABASE_URL` (Supavisor transaction pooler) is written only with explicit
consent, as a server-only variable, from a password Vector generated when it
created the project or set when it rotated it; the password is stored with the
same vault encryption as provider tokens. Public client keys still require
appropriate database access policies.

Vercel synchronization sends the configured variables to the linked
provider project. It is separate from writing local `.env`. Removing a local
variable is not proof that a previously synchronized remote value was deleted;
manage remote deletion explicitly.

Vercel's `project-env-vars` read/write scope manages variables owned by the
integration. Existing variables created outside that integration may require
direct management in Vercel; local variable listing, `.env` application and
project listing remain available. See [Vercel's integration scopes](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations#project-environmental-variables).

## Agent permissions

The agent's `vector_cloud` tool asks before it publishes or moves production
(`vector_cloud_publish`), creates, prepares, changes or migrates a database
(`vector_cloud_database`), writes a host's environment variables
(`vector_cloud_environment`) or changes a Vercel project, its protection or its
domains (`vector_cloud_hosting`). Each prompt names the provider, the
provider-side project and the environment the action touches. All four default
to ask for every agent; a wildcard `"*": "allow"` does not approve them, only a
rule that names them. The app's auto-accept never answers them either, nor any
other Vector Cloud request that asks every time (one with no "always" pattern);
the list is `ALWAYS_ASK` in `packages/app/src/context/permission-auto-respond.ts`.
A migration dry run only reads, so it uses `vector_cloud_inspect`, which is
allowed by default and which auto-accept may answer.

## Repository migrations

`apply_migrations` runs the repository's `.sql` files against the linked
Supabase database in filename order. Vector records each applied file with a
SHA-256 checksum in `vector.schema_migrations`: a schema outside Supabase's Data
API, with row level security on, no policies and no access for the `anon` and
`authenticated` roles. Rows an older release kept in `public.vector_migrations`
move there on the next run and that table is dropped. Versions recorded by the
Supabase CLI in `supabase_migrations.schema_migrations` count as applied. Each
file is sent together with its tracking insert as one query, which Postgres runs
as one transaction. If an applied file's checksum no longer matches, nothing
runs until the file is restored; write a new migration for the change instead.

## Publishing and release checks

Vector publishes to the Vercel project linked to the repository. Without a
linked project, publishing returns setup instructions; a Vercel failure never
triggers a deployment elsewhere. An agent in a parallel workspace uses its
project's links, variables and database, builds and migrates from its own
worktree, and publishes only a preview: production moves after the work is
merged. This does not establish a provider's current
billing state or authorize a charge.

Before claiming live OAuth or release acceptance:

1. Verify server-only configuration and exact provider callback registration.
2. Complete consent from the intended desktop build and confirm the validated
   account identity. Never paste a token or client secret into logs or reports.
3. Select an existing provider project for the repository and confirm that
   environment/domain operations address that destination.
4. Test any provider mutation or preview publication only with explicit scope
   and a verified acceptable billing boundary. Fixtures do not prove a live
   account's costs or provider permissions.
5. Verify Supabase renewal without requiring a previously linked database.
   Disconnect removes the local credential and attempts remote revocation;
   confirm revocation with the provider when it matters rather than inferring
   it from local removal.

Local automated tests cover callback security, readiness, environment writes,
public-key selection and project scoping. They do not register provider apps,
complete live consent or publish desktop artifacts.
