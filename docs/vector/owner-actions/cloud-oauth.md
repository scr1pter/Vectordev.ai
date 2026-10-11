# Configure Vector Cloud OAuth

The desktop connects directly to Vercel and Supabase. The website's `api/cloud/oauth/*` functions broker sign-in; deploy these functions on the production `vectordev.ai` project before enabling the connection buttons. Provider app registration and the credentials below are owner actions. No registration or production account changes were performed during the local review.

## Vercel registration

1. In the [Vercel dashboard](https://vercel.com/dashboard), choose the team that owns Vector. Open **Integrations → Integrations Console → Create** and create a connectable-account integration named Vector. Complete the required website, support, logo, privacy and terms fields. Follow the [integration registration guide](https://vercel.com/docs/integrations/create-integration).
2. Set **Redirect URL** to `https://vectordev.ai/api/cloud/oauth/callback-vercel`. Keep the assigned URL slug; it is used in the installation URL.
3. Configure these scopes for the implemented controls: `deployment` read/write, `project` read/write, `domain` read/write, `project-env-vars` read/write, `global-project-env-vars` read/write, `team` read, and `user` read. Global project environment access is needed to manage existing variables created outside Vector. Domain changes require both project and domain write access. Confirm the current scope labels against [Vercel's API scope table](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations#scopes).
4. Save the integration. Copy its slug, client ID and client secret from the integration settings into the website deployment variables listed below. Install it on a test team and grant access to a disposable project before exposing it publicly. If scopes change later, existing installations need to confirm the new permissions.

## Supabase registration

1. Open the organization that owns Vector in the [Supabase dashboard](https://supabase.com/dashboard), then **Organization Settings → OAuth Apps → Add application**. Enter Vector's application details and confirm. See [Supabase's registration guide](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration).
2. Set its redirect URL to `https://vectordev.ai/api/cloud/oauth/callback-supabase`.
3. Enable **Organizations: Read**, **Projects: Read and Write**, **Database: Read and Write**, **Auth: Read and Write**, **Secrets: Read and Write**, **Edge Functions: Read and Write**, and **Storage: Read**. These cover project creation/linking/lifecycle, SQL and schema types, Auth settings, project keys and function secrets, Edge Functions, and bucket discovery. Bucket mutations and Auth user administration use the linked project's server key, obtained through Secrets read access. Refer to the [current scope definitions](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration/oauth-scopes).
4. Save the app and copy its client ID and secret into the website variables below. Publish/enable the OAuth app in the dashboard so another test organization can authorize it. Scopes are set on the app, not sent as a deprecated `scope` query parameter; changed scopes require users to reconnect. The implemented flow uses S256 PKCE.

## Website deployment variables

Set these in the production website project's server environment, then redeploy its OAuth functions. Do not place client secrets in a desktop bundle, frontend `VITE_*` variable, tracked file, or chat transcript.

| Variable                         | Value                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `VECTOR_OAUTH_PUBLIC_URL`        | `https://vectordev.ai`                                                            |
| `VECTOR_OAUTH_STATE_SECRET`      | A generated random secret of at least 32 characters; retain it across deployments |
| `VECTOR_VERCEL_INTEGRATION_SLUG` | The Vercel integration's URL slug                                                 |
| `VECTOR_VERCEL_CLIENT_ID`        | The Vercel integration client ID                                                  |
| `VECTOR_VERCEL_CLIENT_SECRET`    | The Vercel integration client secret                                              |
| `VECTOR_SUPABASE_CLIENT_ID`      | The Supabase OAuth application client ID                                          |
| `VECTOR_SUPABASE_CLIENT_SECRET`  | The Supabase OAuth application client secret                                      |

The desktop defaults to `https://vectordev.ai/api/cloud/oauth`. For a separate staging installation, register separate provider apps and set their HTTPS callbacks, the staging broker's `VECTOR_OAUTH_PUBLIC_URL`, and the desktop's `VECTOR_OAUTH_BROKER_URL` consistently. The provider callback is the HTTPS function above; `vector://cloud/oauth` is only the broker-to-desktop return URI. Vercel credentials return in an envelope encrypted to the initiating desktop; Supabase's code is exchanged with that desktop's PKCE verifier. Desktop credentials are kept in the OS-backed credential vault.

## Owner verification in the installed desktop

Use disposable provider projects and the released desktop build. Record the build version and results with the release evidence.

- **Connections:** connect Vercel and Supabase, finish browser consent, return to Vector, and verify the selected account/team or organization. Disconnect and reconnect once to verify revocation/recovery. A failed or canceled login must leave the prior connection usable.
- **Deployments:** link an existing Vercel project and confirm its provider deployment history is present. Make a local uncommitted change and verify the warning before publishing. Publish a preview, then use Redeploy, Promote and Roll back. Production confirmation must name the target project; failed required checks must prevent promotion. A project's first deployment is labelled production when Vercel will make it production.
- **Project controls:** change a disposable environment variable after reviewing its target environment and sync plan, verify exact domain DNS records, and exercise project settings. Stored secret values must not appear in agent replies, checks or logs. Test protected deployment checks with the project's automation bypass secret if used.
- **Database:** link an existing Supabase project. Verify schema browsing, a harmless SQL query, a migration dry run, Auth configuration and editable storage limits. Review the exact SQL before approving a migration; only the approved text may execute. Confirm the generated TypeScript client and ignored `.env` are written to the selected project/worktree.
- **Agent permissions:** with auto-accept enabled, ask separately for publishing, a database mutation, an environment sync and a hosting mutation. Each must still show a permission prompt, and rejecting it must make no provider change. Only inspection and the read-only migration dry run may auto-accept. Repeat a risky action to verify no permanent approval was retained.
