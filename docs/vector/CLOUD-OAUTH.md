# Vector Cloud OAuth

Vector connects a user's own Vercel, Netlify, and Supabase accounts. Provider
tokens are exchanged by the hosted OAuth broker and then handed to the desktop
app through a short-lived, signed callback. The desktop app stores tokens in
its encrypted local credential vault.

No provider client secret is shipped inside the desktop application.

## Hosted environment

Configure these variables on the production `vectordev-ai` Vercel project:

```text
VECTOR_OAUTH_PUBLIC_URL=https://vectordev.ai
VECTOR_OAUTH_STATE_SECRET=<at least 32 random characters>

VECTOR_VERCEL_INTEGRATION_SLUG=<Vercel integration slug>
VECTOR_VERCEL_CLIENT_ID=<Vercel integration client ID>
VECTOR_VERCEL_CLIENT_SECRET=<Vercel integration client secret>

VECTOR_NETLIFY_CLIENT_ID=<Netlify OAuth application client ID>

VECTOR_SUPABASE_CLIENT_ID=<Supabase OAuth application client ID>
VECTOR_SUPABASE_CLIENT_SECRET=<Supabase OAuth application client secret>
```

Generate the state secret once and keep it stable:

```sh
openssl rand -hex 32
```

Changing that secret invalidates OAuth flows that are currently in progress.

## Callback URLs

Register these exact HTTPS callback URLs with the providers:

```text
https://vectordev.ai/api/cloud/oauth/callback-vercel
https://vectordev.ai/api/cloud/oauth/callback-netlify
https://vectordev.ai/api/cloud/oauth/callback-supabase
```

Use separate OAuth applications for local development if localhost callbacks
are needed. Do not add production client secrets to `.env` files committed to
source control.

## Provider permissions

Grant only the management access Vector currently uses:

- Vercel: identify the user/team, list projects, deploy to a selected project,
  read and update project environment variables, and manage project domains.
- Netlify: identify the user, list sites, deploy to a selected site, read and
  update site environment variables, and manage site domains.
- Supabase: identify the user, list organizations and projects, read a selected
  project's public client key, and manage that project's database resources.

Do not request billing or destructive account-wide permissions.

## Supabase client keys

OAuth authorizes Vector to manage the user's Supabase account. A deployed web
application still needs its selected project's public publishable key (or
legacy anonymous key) to use the Supabase client SDK.

Vector fetches that public key after the user selects a project and writes it
into that project's cloud configuration. The user does not paste it manually.
Service-role keys are never fetched or exposed to the renderer.

## Release check

Before shipping a build:

1. Open Vector Cloud > Connections.
2. Connect each provider and finish consent in the system browser.
3. Confirm Vector returns to the app and shows the connected account.
4. Select a provider project for the current Vector project/task.
5. Verify environment variables and domains load from that exact destination.
6. Publish a preview and confirm the deployment lands in the selected project.
7. Disconnect Supabase and confirm its consent is revoked as well as removed
   from the local vault.

If a provider is not configured, Vector must show `Setup required` with the
missing hosted variable names. It must not show a working-looking button that
silently fails.
