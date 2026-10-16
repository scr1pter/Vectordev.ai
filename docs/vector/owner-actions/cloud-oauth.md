# Configure Vector Cloud sign-in (Vercel and Supabase)

Vector Cloud → Connections offers **Connect Vercel** and **Connect Supabase** (one-click sign-in in the browser) when Vector's sign-in broker on `vectordev.ai` reports the provider as configured, and **Use access token** in every case. This page is the owner's checklist for that broker: the two provider registrations, the server variables, the deploy and the checks in the desktop. All of it is an owner action; nothing here was registered, changed or deployed by an agent.

## Where it stands (read 2026-10-15)

`GET https://vectordev.ai/api/cloud/oauth/status?relay=v1` (public, no credentials) answered `configured: true` with no missing variables for both `vercel` and `supabase`. So the production server variables exist, and released desktops already offer one-click sign-in.

That answer only proves the variables are set. It does not prove the provider registrations use the callback URLs and scopes below, and no live sign-in has been checked. The same answer still lists `netlify`, which means production runs a broker older than this branch; the branch's broker supports only Vercel and Supabase.

## How the desktop uses it

1. Connections calls `GET <broker>/status?relay=v1`. The broker is `https://vectordev.ai/api/cloud/oauth` unless the desktop was started with `VECTOR_OAUTH_BROKER_URL`.
2. When a provider is configured, **Connect** calls `POST <broker>/start`. The browser opens:
   - Vercel: `https://vercel.com/integrations/<VECTOR_VERCEL_INTEGRATION_SLUG>/new?state=…`. The state carries a one-time public key of the desktop.
   - Supabase: `https://api.supabase.com/v1/oauth/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `state` and an S256 PKCE challenge.
3. The provider sends the browser back to the callback below. The callback page hands the result to the desktop through `vector://cloud/oauth`. For Vercel, the code is first encrypted to the desktop's key in the browser.
4. The desktop exchanges the code through `POST <broker>/exchange`. The client secret stays on the server. The desktop then checks the account identity and stores the token in its encrypted credential vault.
5. Supabase tokens are renewed through `POST <broker>/refresh`.
6. **Disconnect** revokes the sign-in. For Supabase it calls `POST <broker>/revoke`. For Vercel it deletes the integration installation directly with the token, which is why the `integration-configuration` scope is needed.

## 1. Vercel integration

Vercel calls this a *connectable account integration*. Each sign-in installs it on one scope: the personal account or one team, chosen on Vercel's install screen. Its token reaches only that scope. Vector lists only that scope; to use another team, the user signs in again or uses an access token.

1. Open the [Vercel dashboard](https://vercel.com/dashboard) and choose the team that will own the integration in the team switcher.
2. Open **Integrations** in the sidebar, then **Integrations Console** (direct: `https://vercel.com/dashboard/integrations/console`), then **Create**.
3. Fill in the form:

   | Field | Value |
   | --- | --- |
   | Name | `Vector` |
   | URL Slug | e.g. `vector` (at most 32 characters). This is `VECTOR_VERCEL_INTEGRATION_SLUG`. |
   | Developer | The legal name Vector is published under |
   | Contact email | Private; Vercel uses it to reach you |
   | Support contact email | Public |
   | Short description | At most 40 characters |
   | Logo | Non-transparent PNG, at least 256 px square |
   | Category | Dev Tools |
   | Website | `https://vectordev.ai` |
   | Documentation URL | `https://vectordev.ai/docs/cloud-services` |
   | EULA URL | `https://vectordev.ai/legal/terms` |
   | Privacy Policy URL | `https://vectordev.ai/legal/privacy` |
   | Overview | At most 768 characters |
   | Feature media | 1 to 8 PNG images, 1920×1080 |
   | **Redirect URL** | `https://vectordev.ai/api/cloud/oauth/callback-vercel` |
   | Webhook URL | Leave empty; Vector uses no webhooks |
   | Configuration URL | Leave empty |

4. Under **Permissions** (called **API Scopes** in older consoles), set exactly these. These are the endpoints Vector's code calls (`packages/desktop/src/main/cloud-vercel-*.ts`, `cloud-connections.ts`, `cloud-provider-token.ts`, and the Vercel CLI that publishes). Anything not listed stays `None`.

   | Permission (scope ID) | Level | Endpoints Vector calls |
   | --- | --- | --- |
   | Current User (`user`) | Read | `GET /v2/user`: account identity |
   | Teams (`team`) | Read | `GET /v2/teams`, `GET /v2/teams/{teamId}`: the installed team's name |
   | Projects (`project`) | Read/Write | `GET /v10/projects`, `POST /v11/projects`, `GET` and `PATCH /v9/projects/{id}`: list, create, link and configure projects. `POST /v10/projects/{id}/promote/{deploymentId}` and `POST /v1/projects/{id}/rollback/{deploymentId}`: Promote and Roll back. `GET`, `POST /v10` and `DELETE /v9/projects/{id}/domains…`: project domains |
   | Project Protection Bypass | Read/Write | `PATCH /v1/projects/{id}/protection-bypass`: the **Protection Bypass for Automation** switch, which creates the secret Vector's release checks use to open protected deployments |
   | Deployments (`deployment`) | Read/Write | `GET /v6/deployments`, `GET /v13/deployments/{id}`, `GET /v3/deployments/{id}/events`, `GET /v2/deployments/{id}/aliases` and `GET /v1/projects/{id}/deployments/{id}/runtime-logs`: history, build events and runtime logs. `POST /v13/deployments` and `PATCH /v12/deployments/{id}/cancel`: Redeploy and cancel. `vercel deploy` (file upload and deployment): publish |
   | Project Environment Variables (`project-env-vars`) | Read/Write | `/v10/projects/{id}/env` and `/v9/projects/{id}/env/{envId}`: variables Vector creates |
   | Global Project Environment Variables (`global-project-env-vars`) | Read/Write | The same endpoints for variables created outside Vector, which Environment variables lists, compares, syncs and pulls |
   | Domains (`domain`) | Read/Write | `GET /v6/domains/{domain}/config`: DNS configuration. `POST /v9/projects/{id}/domains/{domain}/verify`: verification. Vercel requires both Projects and Domains write to change a project's domains |
   | Integration Configuration (`integration-configuration`) | Read/Write | `DELETE /v1/integrations/configuration/{id}`: **Disconnect** deletes Vector's installation, which revokes its token |
   | Deployment Checks (`deployment-check`) | None | Vector runs its own release checks and calls none of Vercel's Checks endpoints |

   Vercel's permission list for its newer tokens names **Project Protection Bypass** (Read and Write, "Manage project protection bypass rules") as a permission of its own, separate from Projects, and its older integration scope table lists the protection-bypass endpoint under no scope ([Scopes and Permissions](https://vercel.com/docs/sign-in-with-vercel/scopes-and-permissions), [integration scopes](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations#scopes), both read 2026-10-16). Set it wherever the console offers it. Vercel's integration scope table also does not name the promote, rollback or runtime-logs endpoints; treat the **Promote**, **Roll back** and **Logs** checks in the verification below as the proof that Projects and Deployments cover them.

   The owner's integration was set on 2026-10-16 to Deployments, Projects, Project Environment Variables, Global Project Environment Variables and Domains at Read/Write, Teams and Current User at Read, and Deployment Checks at None. That matches this table except for two lines: add **Project Protection Bypass: Read/Write**, or the Protection Bypass for Automation switch is refused, and **Integration Configuration: Read/Write**, or Disconnect cannot remove the installation (Vector then says Vercel did not confirm the revocation, and the installation has to be removed from the team's Integrations page).

5. Accept the Vercel Integrations Marketplace Agreement and save. The integration gets the Community badge. Anyone can then install it from Vector without a marketplace listing.
6. Copy the client (integration) ID and client secret from the integration's settings page (**Credentials**, at the bottom) into the variables in section 3.

If you add a scope to an integration that is already installed, every installation has to confirm the change on Vercel before it applies.

## 2. Supabase OAuth app

1. Open **OAuth Apps** in the settings of the Supabase organization that will own the app: `https://supabase.com/dashboard/org/_/apps`. Choose **Add application**.
2. Enter Vector's name, website (`https://vectordev.ai`) and icon. Set the **redirect (callback) URL** to `https://vectordev.ai/api/cloud/oauth/callback-supabase`.
3. Scopes are set on the app; Vector does not send a `scope` parameter. Enable exactly these, which are what Vector's code calls (`packages/desktop/src/main/cloud-supabase-*.ts`, `cloud-migrations.ts`, `cloud-provision.ts`, `cloud-connections.ts` and `cloud-provider-token.ts`). Anything not listed stays off.

   | Scope | Level | Endpoints Vector calls |
   | --- | --- | --- |
   | Organizations | Read | `GET /v1/organizations`: account identity and choosing where to create a project |
   | Projects | Read and Write | `GET /v1/projects`, `GET /v1/projects/{ref}` and `POST /v1/projects`: list, read and create projects. `POST …/pause` and `POST …/restore`: pause and restore. `PATCH …/database/password`: reset the database password |
   | Database | Read and Write | `POST …/database/query`: SQL console, migrations and schema reads. `GET …/config/database/pooler`: the pooler settings for `DATABASE_URL` |
   | Auth | Read and Write | `GET` and `PATCH …/config/auth`: Site URL, redirect URLs, email and Google, GitHub or Apple sign-in |
   | Secrets | Read and Write | `GET …/api-keys?reveal=true`: the public key for `.env` and the server key, kept in memory only, for users and buckets. `GET`, `POST` and `DELETE …/secrets`: Edge Function secrets |
   | Edge Functions | Read and Write | `GET …/functions`, `POST …/functions/deploy` and `DELETE …/functions/{slug}`: list, deploy and delete functions |

   Storage needs no scope: buckets are listed and changed through the project's own Storage API with the server key from Secrets, not through the Management API. Domains, Environment (branches) and Rest are not used.

   Supabase's scope list gives Organizations no write level (read 2026-10-15), so an OAuth app cannot create an organization. That is expected: a sign-in is always authorized for one organization. **Create organization** in Database, and the agent's `create_organization` (`POST /v1/organizations`), only appear for an account with no organization, which only an access-token connection can be.

   Supabase's [scope list](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration/oauth-scopes) does not name pause, restore, the database password, the logs endpoint (`…/analytics/endpoints/logs`) or the security advisors (`…/advisors/security`) (read 2026-10-16). If the form offers an Analytics or Advisors read scope, enable it. Either way, check pause and restore, **Database logs** and **Security** after connecting. When the advisors are not allowed, Security skips them and asks the user to reconnect.

4. Save the app. Copy its client ID and client secret into section 3. If the dashboard shows a publish or visibility control for the app, publish it so other organizations can authorize it.

If you change the scopes later, users who connected before have to disconnect and connect again.

## 3. Server variables on the `vectordev.ai` Vercel project

Set these in the production environment of the Vercel project that serves `vectordev.ai`. Never put them in a desktop build, in a `VITE_`, `PUBLIC_` or `NEXT_PUBLIC_` variable, in a tracked file or in a chat.

| Variable | Value |
| --- | --- |
| `VECTOR_OAUTH_PUBLIC_URL` | `https://vectordev.ai` (the origin both callback URLs are built from) |
| `VECTOR_OAUTH_STATE_SECRET` | At least 32 random characters from a secure generator. Keep it stable: changing it cancels sign-ins in progress. |
| `VECTOR_VERCEL_INTEGRATION_SLUG` | The URL slug from step 1.3 |
| `VECTOR_VERCEL_CLIENT_ID` | The integration's client ID |
| `VECTOR_VERCEL_CLIENT_SECRET` | The integration's client secret |
| `VECTOR_SUPABASE_CLIENT_ID` | The OAuth app's client ID |
| `VECTOR_SUPABASE_CLIENT_SECRET` | The OAuth app's client secret |

For staging, register separate provider apps whose callbacks use the staging origin. Set that origin as the staging broker's `VECTOR_OAUTH_PUBLIC_URL`, and start the staging desktop with `VECTOR_OAUTH_BROKER_URL=https://<staging origin>/api/cloud/oauth`.

## 4. Deploy and check the broker

1. Deploy `main` with this branch merged to the `vectordev.ai` project, so `api/cloud/oauth/*` is the Vercel-and-Supabase-only broker.
2. Open `https://vectordev.ai/api/cloud/oauth/status?relay=v1`. Expect exactly two providers, `vercel` and `supabase`, each with `configured: true`, `missing: []` and the callback URL above. A missing variable is named there; its value never is.

## 5. Verify in the desktop

Before using real accounts, `bun --no-env-file test ./src/main/cloud-signin.test.ts` in `packages/desktop` runs both sign-ins against the broker code and local fakes. It proves Vector's side only, not your registrations.

Use disposable Vercel and Supabase projects and an installed desktop build. Record the build version and the results with the release evidence.

- **Sign-in:** in Connections, **Connect Vercel**. On Vercel's screen, choose a test team. Vector must return as signed in, and the team picker must show only that team. Then **Connect Supabase**. A canceled sign-in must leave the earlier connection working.
- **Token path:** **Use access token** must still connect each provider while sign-in is offered.
- **Disconnect:** disconnect Vercel. Vector must say its access is revoked, and the installation must be gone from the team's Integrations page on Vercel. Disconnect Supabase. Vector must say its access is revoked, and the app must be gone from the organization's authorized apps.
- **Vercel controls:** link a project and check that its deployment history appears. Check build and runtime logs, Redeploy, Promote and Roll back (failed required checks must stop a promotion), an environment variable change through its sync plan, a domain with its DNS records, project settings, and the Protection Bypass for Automation switch. Stored secret values must not appear in agent replies, checks or logs.
- **Supabase controls:** link an existing project. Check pause and restore, a read-only SQL query, a new migration written from Database and applied after reviewing its SQL, Auth settings, storage limits, Database logs and Security.
- **Agent permissions:** with auto-accept on, ask the agent for a preview publish, a database change, an environment sync, a hosting change and a release-settings change. Each must show a prompt every time, with no Always allow, and rejecting it must change nothing. Only the migration dry run may run without a prompt.
