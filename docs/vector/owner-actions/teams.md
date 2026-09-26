# Vector Teams: owner provisioning and release gate

Vector Teams supplies signed organization defaults to the desktop app and CLI. The hosted API is disabled until the owner applies the SQL, provisions memberships, and configures production signing. This work has not created a production organization, registered accounts, generated production keys, or enabled the service. It changes no subscriptions or payments.

## 1. Review and apply the database migration

Apply [sql/teams.sql](sql/teams.sql) through the production Supabase SQL Editor as the database owner after reviewing it and the existing project schema. The migration expects Supabase's `auth.users`, `anon`, `authenticated`, and `service_role`; it does not create replacement accounts or roles. It creates:

- `vector_teams`: team UUID and display name.
- `vector_team_memberships`: an existing account's team membership and `owner`, `admin`, or `member` label.
- `vector_team_configurations`: one JSON configuration per team, a monotonic revision, and update time.
- `vector_team_configuration(request jsonb)`: a service-role-only read RPC. One database snapshot binds account existence, its membership roster, and the selected policy.

RLS is enabled and direct client grants are revoked on all three tables. Anonymous and authenticated Supabase clients cannot read or write them or execute the RPC. The API verifies the Vector CLI grant and account revocation before supplying the account ID itself. Keep the service-role key server-side: it bypasses RLS. The RPC uses `SECURITY DEFINER`, a fixed empty search path, explicitly qualified tables, and revoked public execution. [Supabase RLS and grants](https://supabase.com/docs/guides/database/postgres/row-level-security), [PostgreSQL function security](https://www.postgresql.org/docs/current/sql-createfunction.html)

Team roles currently describe membership; there is no public invitation, membership-write, policy-editing, or admin API. The owner performs changes through controlled SQL access. Do not grant client write access to implement management informally.

## 2. Provision one test team

Use an existing Vector account UUID from Supabase Auth. Replace the placeholder below; do not create a synthetic production account. The statement is atomic, including the foreign-key check.

```sql
with team as (
  insert into public.vector_teams(name)
  values ('Vector test team') returning id
), policy as (
  insert into public.vector_team_configurations(team_id, config)
  select id, '{"permission":{"bash":"ask"}}'::jsonb from team
  returning team_id
)
insert into public.vector_team_memberships(team_id, account_id, role)
select team.id, '<existing-auth-user-uuid>'::uuid, 'owner'
from team join policy on policy.team_id = team.id
returning team_id;
```

Keep the returned team UUID. To add an existing member, insert its account UUID into `vector_team_memberships` with that `team_id` and an appropriate role. To remove access, delete that membership. To change defaults:

```sql
update public.vector_team_configurations
set config = '{"permission":{"bash":"ask","edit":"deny"}}'::jsonb
where team_id = '<team-uuid>'::uuid
returning revision, updated_at;
```

The trigger assigns revision 1 on insert and increments it on every update, including parallel writes. Do not write a revision manually or move a configuration row to another team. Deleting and recreating a configuration resets its revision; use updates for normal changes.

Configurations must be JSON objects, at most 160,000 UTF-8 bytes in their stored JSON representation, with nesting at most 32. Prototype-mutating keys are rejected at every depth. A response allows at most 100 memberships and 256,000 total bytes, including encoding/signature overhead; large rosters and policies can exceed the combined response ceiling even when each individual value is valid. The API rejects excess data instead of dropping policy fields. Validate the chosen configuration with the shipped Vector client before enabling a wider membership set.

Team defaults are merged before personal/project configuration. They can configure providers, permissions, and integrations; they are not immutable device management or a sandbox imposed on the machine owner. Existing local deny rules remain meaningful. All team members can receive the full team configuration, so include only credentials or integration configuration that every member is authorized to read. Signed payloads are integrity-protected, not encrypted; the client cache uses a private local file.

## 3. Create and configure the signing key

The owner generates an Ed25519 PKCS8 key on a trusted machine. For example, run these commands in a private temporary directory; do not run them inside the repository:

```sh
umask 077
openssl genpkey -algorithm ED25519 -out vector-teams-private.pem
openssl pkey -in vector-teams-private.pem -pubout -outform DER |
  openssl base64 -A | tr '+/' '-_' | tr -d '='
```

The second command prints the public verification key only. Store the private PEM directly in Vercel's **production** environment or the owner's secret-management process; never commit it or paste it into a support conversation. Node's standard Ed25519 signing API signs the exact domain-prefixed payload bytes. [Node crypto signing](https://nodejs.org/api/crypto.html#cryptosignalgorithm-data-key-callback)

| Variable                                    | Value                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `VECTOR_TEAMS_ENABLED`                      | Exact `true` to enable; leave absent or `false` during setup                               |
| `VECTOR_TEAMS_SIGNING_KEY_ID`               | Unique owner-chosen key identifier, 1–64 letters/digits/underscore/hyphen                  |
| `VECTOR_TEAMS_SIGNING_PRIVATE_KEY`          | Ed25519 PKCS8 private PEM; real or escaped newlines accepted                               |
| `VECTOR_TEAMS_PREVIOUS_PUBLIC_KEYS`         | Optional JSON array of previous `{ "id": "...", "publicKey": "..." }` values; default `[]` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Existing production Supabase endpoint and server-only service-role credential              |
| `VECTOR_CLI_TOKEN_SECRET`                   | Existing CLI grant signing secret; the API verifies existing `vct_` grants                 |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN`      | Existing persistent Redis REST configuration; existing Upstash aliases also work           |
| `VECTOR_ABUSE_SECRET`                       | Stable random secret of at least 32 characters for hashed rate counters                    |

When `VERCEL_ENV` is set, only `production` can enable Teams. Preview stays disabled even if the flag is accidentally copied. The active public key is derived from the private key. Rotation accepts at most three total keys, unique IDs, and canonical base64url DER Ed25519 public keys. A malformed keyset disables signing; it does not silently omit keys.

Deploy with the flag off, apply the migration, configure the key and existing service credentials, then enable for the controlled acceptance below. No client, repository, or customer-provided URL can replace Vector's signing-key endpoint.

## 4. Verify the production contract

`GET https://vectordev.ai/api/org/keys` returns public `{keys:[{id,publicKey}]}` without a credential. `GET https://vectordev.ai/api/org/config` uses `Authorization: Bearer <vct_ grant>`. Omit the query to list the signed-in account's memberships in Personal mode; pass only `?org=<team-uuid>` to request that current member's team policy. Bearer grants never belong in URLs. Unknown or repeated query fields, request bodies, and non-GET methods are rejected.

The response is `{version:1,keyId,payload,signature}`. `payload` is unpadded canonical base64url of the exact UTF-8 JSON bytes. Ed25519 signs UTF-8 `vector-org-config-v1.` followed by that encoded payload. The payload binds issuer `https://vectordev.ai`, audience `vector-teams`, account ID/email, SHA-256 of the current CLI grant, issue/expiry times, verified memberships, and the explicit selected team's ID/revision/configuration. It expires within 15 minutes and never later than its CLI grant. The server checks account revocation again after the database read.

Every response is `no-store`, with `no-referrer` and `nosniff`. No wildcard CORS is supplied. Keys are limited to 120 requests/IP/minute; configuration is limited to 60 requests/IP/minute and 60 requests/account/minute using persistent atomic counters. Redis, SQL, decoding, and signing failures fail closed. The API does not log or reflect raw upstream responses, grants, or private keys.

Relevant errors are `401 SIGN_IN_REQUIRED`/`CLI_TOKEN_INVALID`/`CLI_TOKEN_EXPIRED`, `403 TEAM_ACCESS_DENIED`, `400 TEAMS_INVALID`, `429 RATE_LIMITED`, and `503 TEAMS_NOT_CONFIGURED`/`TEAMS_UNAVAILABLE`/`PERSISTENT_STORE_UNAVAILABLE`. An explicit team request that loses membership cannot become an apparently successful Personal response.

Use the desktop Team switcher, TUI `/org`, or CLI `vector org` commands with the owner test account. Confirm membership listing, explicit selection, updated policy revisions, and Personal workspace selection. Verify a second account cannot select the test team until provisioned. Remove its membership and confirm a refresh is denied. Verify direct anonymous/authenticated Supabase table/RPC access is denied, preview remains disabled, and an unavailable persistent store prevents policy issuance. Record deployment and pass/fail evidence without recording bearer grants or private key material.

## Cache, rotation, and deletion

Clients use only the fixed HTTPS key endpoint as the trust anchor. A previously verified key may stay in memory temporarily; an on-disk key is never accepted as an authority. The private local `teams.json` selection/cache contains no raw CLI token. A new offline process with an active team cannot establish key trust and fails closed. An already-running process can use an unexpired, correctly signed policy bound to the same account/grant for at most 15 minutes. Invalid, expired, or mismatched policy never silently removes team defaults. Explicit Personal selection clears local team state even offline; logout clears it too.

Membership removal, configuration edits, account revocation, and disabling the enable flag stop new successful issuance. Already verified in-memory policies may remain usable until their signed expiry, at most 15 minutes. This is not instant centralized revocation. For key rotation, deploy the new active private key with a new ID and retain the preceding public key in the rotation array for the intended transition, then remove it. Never retain a compromised public key merely to avoid a refresh failure; remove it and rotate immediately, recognizing the same bounded in-process cache window.

Deleting an account cascades its memberships. It does **not** delete a shared team or its configuration, which may still belong to other members. Review empty teams manually and delete those no longer needed; deleting a team cascades its memberships and policy. The current schema does not enforce “at least one owner,” so transfer the owner role before removing the last responsible owner. No API stores policy history; ordinary database backups follow the existing owner-operated retention policy. Signing keys live in production environment secrets, and rotating them does not change database content.

Customer-hosted configuration continues to use only `/.well-known/vector`. There is no fallback to another product's endpoint. Hosted Teams has no customer-supplied endpoint or signing-key URL override.

## Evidence boundary

Local coverage uses real Ed25519, Node HTTP handlers, PostgreSQL constraints/RLS/RPCs, and a disposable Redis-compatible service. It covers signature binding, removed/nonmember/deleted accounts, the second revocation check, parallel revisions, limits, unsafe configuration, disabled/preview behavior, key rotation validation, and sanitized failures. These checks do not substitute for applying the owner-reviewed migration and validating the real production Supabase/PostgREST and Vercel configuration. Keep Teams unavailable in release claims until that owner acceptance passes.
