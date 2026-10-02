# Vector Cloud OAuth

## Current availability

The Cloud completion changes described here are prepared for **1.999.99** and
are not a published desktop release. Provider application registration, hosted
configuration and a real browser-to-desktop consent check are separate release
steps. No Vercel, Netlify or Supabase registration has been confirmed complete
for this checkpoint. Do not infer readiness from a successful build or test.

Vector connects accounts and resources that belong to the user. Provider
billing, quotas and terms still apply; guarded free OpenRouter inference does
not make hosting or database operations free. Never upgrade a plan, add payment,
or retry resource creation in another organization automatically.

## Authorization and credential boundaries

The hosted broker signs provider-bound OAuth state with a ten-minute expiry.
For Vercel and Netlify, the browser callback returns an encrypted authorization
result to the pending desktop flow: the Vercel authorization code and Netlify
access token are protected by an ephemeral desktop relay. The private key stays
with that flow; there is no plaintext custom-URL fallback. The relay format is
versioned, and an unsupported older desktop is told to update before starting.
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

VECTOR_NETLIFY_CLIENT_ID=<Netlify OAuth application client ID>

VECTOR_SUPABASE_CLIENT_ID=<Supabase OAuth application client ID>
VECTOR_SUPABASE_CLIENT_SECRET=<Supabase OAuth application client secret>
```

The Netlify flow currently uses its client ID and encrypted token relay; it
does not consume a Netlify client-secret variable. Generate the signing secret
with a cryptographically secure generator, store it through the deployment
secret manager, and keep it stable. Rotating it invalidates in-progress flows.
Use separate provider applications and secrets for development and preview.
Never copy a production secret into a committed `.env` file or diagnostic log.

Readiness fails closed when the signing secret is missing or shorter than 32
characters, or when required provider variables are absent. Missing names may
be reported; their values are not. Configured means the required settings are
present, not that registration, permissions or live consent have been verified.

Desktop **Cloud Services → Connections** offers hosted sign-in when configured.
If hosted OAuth is unavailable and this desktop supports manual tokens, it
instead offers the provider's personal-access-token flow with local encrypted
storage. Older unsupported desktops show an unavailable state. The Database
panel routes users to this same connection setup, including manual Supabase
access when available.

## Callback URLs and identity access

Register these exact HTTPS callback URLs:

```text
https://vectordev.ai/api/cloud/oauth/callback-vercel
https://vectordev.ai/api/cloud/oauth/callback-netlify
https://vectordev.ai/api/cloud/oauth/callback-supabase
```

Grant only the management access required for the selected operations:

- Vercel: user identity (`/v2/user`, including User read), selected team/project
  listing, deployment, environment variables and project domains.
- Netlify: user identity (`/api/v1/user`), selected site listing, deployment,
  environment variables and site domains.
- Supabase: organization identity/listing (`/v1/organizations`), selected
  projects, public client keys and the database operations the user approves.

Do not request billing or destructive account-wide permissions. Provider
configuration must support the identity checks: a token exchange alone is not
a completed connection.

## Project variables and Supabase client keys

Provider connections are account-level; selected destinations and stored cloud
variables belong to a repository. The UI clears drafts and revealed values
when the project or task changes and ignores delayed results from the previous
view. Variable names retain their case. Values are hidden by default; use
Reveal deliberately.

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

Supabase connection writes `SUPABASE_URL` and `SUPABASE_ANON_KEY`, plus the
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` aliases consumed by the generated
browser client. Only a publishable key or legacy anonymous key is accepted for
this client configuration. Management, secret, service-role and user-session
keys must not be placed in these browser-visible variables. The provider's key
listing may contain privileged keys, but Vector does not select them for the
client, return them as its database connection, or write them to the scaffold.
Public client keys still require appropriate database access policies.

Vercel/Netlify synchronization sends the configured variables to the linked
provider project. It is separate from writing local `.env`. Removing a local
variable is not proof that a previously synchronized remote value was deleted;
manage remote deletion explicitly.

Vercel's `project-env-vars` read/write scope manages variables owned by the
integration. Existing variables created outside that integration may require
direct management in Vercel; local variable listing, `.env` application and
project listing remain available. See [Vercel's integration scopes](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations#project-environmental-variables).

## Publishing and release checks

When an agent omits a publish target, Vector selects the repository's single
configured destination. Multiple destinations require an explicit choice; zero
destinations return setup instructions. An explicitly chosen provider's failure
does not trigger a fallback deployment elsewhere. This does not establish a
provider's current billing state or authorize a charge.

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
