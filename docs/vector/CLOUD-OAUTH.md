# Vector Cloud OAuth

## Current availability

The Cloud changes described here are on the integration branch and are not in a
published desktop release yet. Provider application registration, hosted
configuration and a real browser-to-desktop consent check are separate owner
steps, listed in [owner-actions/cloud-oauth.md](owner-actions/cloud-oauth.md).
No Vercel or Supabase registration has been confirmed complete. Do not infer
readiness from a successful build or test.

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

Desktop **Vector Cloud → Connections** offers hosted sign-in (**Connect**)
when configured, and the provider's personal-access-token flow (**Use access
token**) beside it, with local encrypted storage. When hosted sign-in is
unavailable, only the token flow is offered. Older unsupported desktops show an
unavailable state. The Database panel routes users to this same connection
setup.

## Callback URLs and scopes

Register these exact HTTPS callback URLs:

```text
https://vectordev.ai/api/cloud/oauth/callback-vercel
https://vectordev.ai/api/cloud/oauth/callback-supabase
```

The scopes each provider app needs, and what each one is used for, are listed
once, in [owner-actions/cloud-oauth.md](owner-actions/cloud-oauth.md). Do not
request billing or destructive account-wide permissions. Provider
configuration must support the identity checks: a token exchange alone is not
a completed connection. A personal access token already carries the account's
full access. A Vercel sign-in is an integration installed on one personal
account or team, and Vector lists and uses only that scope.

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
not encrypt the project's `.env` contents. Every write, from the screen, the
agent or Supabase setup, first adds `.env` to `.gitignore` when git does not
already ignore it, and refuses to put a server-only value into a `.env` that
git tracks, naming the variables and leaving the file unchanged.

For projects positively identified as Vite by their saved framework or a Vite
dependency, serialization preserves literal dollars and backslashes through
Vite's environment parser. Enter literal values, not variable-expansion
expressions. Multiline values and quote combinations that cannot be represented
literally are rejected before replacing `.env`; set such values on the linked
Vercel project in the **On Vercel** panel, whose value field keeps line breaks
(Shift+Enter), instead. Other project types retain their existing
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

A Vercel sign-in manages variables created outside Vector through the
`global-project-env-vars` scope; with only `project-env-vars`, Vercel would
limit it to the variables the integration created. See
[Vercel's integration scopes](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations#scopes).

## Agent permissions

The agent's `vector_cloud` tool asks before it publishes or moves production
(`vector_cloud_publish`), creates, prepares, changes or migrates a database
(`vector_cloud_database`), writes a host's environment variables, the
project's `.env` or the variables Vector stores for it
(`vector_cloud_environment`) or changes a Vercel project, its protection or its
domains (`vector_cloud_hosting`). Each prompt names the provider, the
provider-side project and the environment the action touches, and shows any SQL
it would run.

These four ask every time. Auto-accept, `vector run --auto`, a configured
`allow` rule (a wildcard or one that names them) and an earlier "Always allow"
never answer them, and no Vector client offers "Always allow" for them; a
`deny` rule still blocks them. The rule is `PermissionPolicy` in
`packages/schema/src/permission-policy.ts`. The app, the TUI, `vector run`, the
ACP bridge and both permission runtimes use it, and it also keeps `doom_loop`,
`browser_sensitive` and `computer_*` prompts manual. A migration dry run only
reads, so it uses `vector_cloud_inspect`, which is allowed by default and which
auto-accept may answer. A new migration file is a repository edit and asks
under `edit`.

Connecting or disconnecting a Vercel or Supabase account is never an agent
action: only the user can do it, in Vector Cloud → Connections.

The agent reaches Vector Cloud only through this tool. The desktop's cloud
bridge token is kept out of the agent's shell environment and out of the
engine's launch environment, which other processes of the same user can read,
so a shell command cannot call the bridge and skip these prompts.

The same work typed into the shell, on the Vercel or Supabase command-line
tool's own login, asks under the same four permissions, every time
(`packages/engine/src/tool/shell/cloud-cli.ts`): a deploy, promote, rollback,
removal or alias change asks under `vector_cloud_publish`; `vercel env` changes
and pulls under `vector_cloud_environment`; other Vercel project, domain and
account commands under `vector_cloud_hosting`; and Supabase commands that change
the linked project or account, or read its data or keys (`db push`,
`db dump`, `projects api-keys`, `secrets set`, `functions deploy`, `link`),
under `vector_cloud_database`, as does `supabase test db` against the linked
database (`--linked`, `--db-url`). `vercel dev` and `vercel build --yes` ask
under `vector_cloud_environment`, since they download the project's variables.
Local work (`vercel build` without `--yes`, `supabase start`, `supabase db
reset` without `--linked`), plain reads (`vercel ls`, `vercel env ls`), help
(`--help`) and lookups (`command -v vercel`) only ask as shell commands do.

This is a best-effort check on direct calls, not a boundary. It sees the CLI
behind package runners and their options (`npx vercel`, `pnpm --filter web exec
vercel`, `yarn run vercel`, `npm --prefix web exec vercel`), behind wrappers
(`env`, `sudo`, `doas`, `timeout`, `nice`, `ionice`, `xargs`, `caffeinate`,
`stdbuf`, `chronic`, `unbuffer`, `setsid`, `find -exec`), and in command lines
run from a string (`sh -c`, `bash -lc`, `zsh -c`, `eval`, `watch`, `env -S`,
`npx -c`), which the shell parses and checks command by command. It does not
see a call inside a project script (`npm run deploy`), behind a variable
(`$CLI --prod`), or in a program that reads the CLI's stored login or calls the
provider's API itself. Only the shell sandbox (`VECTOR_SHELL_SANDBOX=1`) closes
that route: sandboxed commands cannot read the CLIs' stored logins. The sandbox
stays off by default because it confines every shell command to the workspace,
is unavailable on Windows, and asks before running unconfined where the host
cannot apply it; turning it on by default is a separate decision.

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

Known limit: the upload runs the pinned Vercel CLI through `npx`, with the
user's Vercel token in its `VERCEL_TOKEN` environment variable
(`runVercel` in `packages/desktop/src/main/publish.ts`). While a deploy runs,
another process of the same user, an agent's shell command among them, can
read that environment (`ps eww`), and the CLI itself lives in the
user-writable npx cache. The token never enters a tool result, a log or the
renderer, but a hostile shell command running alongside a publish could take
it. Closing this means deploying through Vercel's REST API from the desktop
process (file upload and deployment creation), so the token never leaves it.

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
   Disconnect removes the local credential and revokes a sign-in connection:
   it deletes Vector's Vercel integration installation
   (`DELETE /v1/integrations/configuration/{id}`, which needs the
   integration-configuration read/write scope) and revokes the Supabase grant
   through the broker. Vector reports when the provider did not confirm it.
   A pasted personal access token is the user's own and stays valid until the
   user deletes it.

Local automated tests cover callback security, readiness, environment writes,
public-key selection and project scoping. `packages/desktop/src/main/cloud-signin.test.ts`
runs both one-click sign-ins end to end: the broker's route code on 127.0.0.1
with placeholder registrations, the desktop's Connect flow and deep-link
handling, and fake Vercel and Supabase APIs. They do not register provider
apps, complete live consent or publish desktop artifacts.
