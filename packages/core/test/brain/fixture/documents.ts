// Text documents for the structure and record tests: for every record rule, documents it must read (positives) and
// near misses it must leave alone (negatives), plus whole specifications to check ids across versions. All invented.

import { BrainExtract } from "@vectordevai/core/brain/extract"
import { BrainLimits } from "@vectordevai/core/brain/document/limits"
import { BrainDocument } from "@vectordevai/core/brain/document/read"
import { BrainStructure } from "@vectordevai/core/brain/structure"

/** Reads, structures and extracts a document the way the knowledge store will, or throws when it is refused. */
export async function learn(
  content: string | Uint8Array,
  name = "doc.md",
  options: { readonly repository?: string; readonly lineage?: string; readonly limits?: BrainLimits.Limits } = {},
) {
  const limits = options.limits ?? BrainLimits.LIMITS.worker
  const extracted = await BrainDocument.read(
    { name, bytes: typeof content === "string" ? new TextEncoder().encode(content) : content },
    limits,
  )
  if (extracted.type === "refused") throw new Error(`${name} was refused: ${extracted.message}`)
  const place = { repository: options.repository ?? "repo", lineage: options.lineage ?? name.toLowerCase(), limits }
  const structured = BrainStructure.structure(extracted, place)
  return { extracted, structured, ...BrainExtract.extract(extracted, structured, place) }
}

export type Case = { readonly name: string; readonly text: string }

export type RuleCases = {
  readonly rule: BrainExtract.Rule
  /** The file name the cases are read as, when not Markdown. */
  readonly file?: string
  readonly positive: readonly string[]
  readonly negative: readonly string[]
}

const API = (paths: string) => `openapi: 3.0.3
info:
  title: Accounts API
  version: "2.1"
paths:
${paths}
components:
  schemas:
    User:
      type: object
      required: [id]
      properties:
        id: { type: string, description: The user id }
        email: { type: string }
`

export const RULE_CASES: readonly RuleCases[] = [
  {
    rule: "rfc2119",
    positive: [
      "Clients MUST retry at most 3 times after a 429 response.",
      "The server SHALL NOT store refresh tokens in plain text.",
      "Implementations SHOULD send the Retry-After header.",
      "A client MAY cache the discovery document for one hour.",
    ],
    negative: [
      "THE SOFTWARE IS PROVIDED AS IS AND YOU MAY NOT RELY ON IT FOR ANY PURPOSE.",
      "We met in May to plan the launch.",
      "You must restart the editor after installing the plugin.",
    ],
  },
  {
    rule: "requirement-id",
    positive: [
      "REQ-12 Sessions end when the user signs out.",
      "FR-3.1: The dashboard lists every open invoice.",
      "NFR-7 Search answers within the page budget.",
    ],
    negative: [
      "See the REQUEST-12 ticket for the background.",
      "Pick the US-East region for the bucket.",
      "The FR team owns the French copy.",
    ],
  },
  {
    rule: "lowercase-modal",
    positive: [
      "## Security requirements\n\nPasswords must be hashed with argon2id.",
      "## Acceptance criteria\n\nThe export never includes deleted rows.",
      "## Data retention policy\n\nBackups are required to be encrypted at rest.",
    ],
    negative: [
      "## Tutorial\n\nYou must restart the editor after installing.",
      "## Security requirements\n\nShould we rotate keys every month?",
      "## Notes\n\nThe nightly build always takes a while.",
    ],
  },
  {
    rule: "user-story",
    positive: [
      "As a billing admin, I want to export invoices as CSV, so that I can reconcile them.",
      "As an operator I need to pause the queue.",
      "As a new user, I want to reset my password.",
    ],
    negative: [
      "As a result, the queue drains faster.",
      "As we discussed, the export runs nightly.",
      "As an aside, I want to thank the team.",
    ],
  },
  {
    rule: "gherkin",
    positive: [
      "Given a signed-in user\nWhen the session expires\nThen the app shows the sign-in page",
      "- Given an empty cart\n- When the user checks out\n- Then the order is refused",
      "Given a 429 response, when the client retries, then it waits for Retry-After.",
    ],
    negative: [
      "Given the time, we skipped the review.",
      "When in doubt, then ask the owner.",
      "Given that, then nothing changes.",
    ],
  },
  {
    rule: "requirement-table",
    positive: [
      "| ID | Requirement | Priority |\n|---|---|---|\n| REQ-1 | Users can export invoices | Must |\n| REQ-2 | Exports finish within 10 s | Should |",
      "| Ref | Description |\n|---|---|\n| SR-4 | Audit logs are kept for one year |",
      "| No. | Statement | Importance |\n|---|---|---|\n| 1 | The archive is read-only | High |",
    ],
    negative: [
      "| Name | Description |\n|---|---|\n| timeout | Request timeout |",
      "| ID | Name |\n|---|---|\n| 1 | Alice |",
      "| # | Step |\n|---|---|\n| 1 | Build |",
    ],
  },
  {
    rule: "constraint",
    positive: [
      "Uploads are limited to 50 MB per file.",
      "Refresh tokens expire after 24 h.",
      "The API allows at most 100 requests/min per key.",
      "Responses arrive within 200 ms at p95.",
    ],
    negative: [
      "We shipped version 2 in 3 days.",
      "Chapter 3 has 12 pages.",
      "At most one reviewer is needed for a docs change.",
    ],
  },
  {
    rule: "adr",
    positive: [
      "# ADR 7: Use Postgres for sessions\n\n## Status\n\nAccepted\n\n## Context\n\nSessions need row locks.\n\n## Decision\n\nWe will store sessions in Postgres.\n\n## Consequences\n\nRedis is no longer needed.",
      '# Choose a queue\n\n## Context and Problem Statement\n\nJobs pile up.\n\n## Considered Options\n\n- Redis streams\n- Postgres\n\n## Decision Outcome\n\nChosen option: "Postgres", because it is already deployed.',
      "# ADR 9: Ship weekly\n\n## Status\n\nProposed\n\n## Decision\n\nReleases go out every Tuesday.",
    ],
    negative: [
      "# Board\n\n## Decision\n\nThe board meets monthly.",
      "# Health\n\n## Status\n\nGreen across all regions.",
      "# Log\n\n## Decisions\n\nWe keep a list of past choices.",
    ],
  },
  {
    rule: "decision-prose",
    positive: [
      "We decided to use Postgres because it supports row locks.",
      "We chose fflate since it is pure JavaScript.",
      "We went with weekly releases due to the review load.",
    ],
    negative: [
      "We decided to wait.",
      "They chose React because it was popular.",
      "Nobody decided anything because the meeting was cancelled.",
    ],
  },
  {
    rule: "decision-label",
    positive: [
      "Decision: adopt OpenTelemetry for tracing.",
      "Decision: keep the monorepo.",
      "Decision: drop Node 18 support.",
    ],
    negative: [
      "The decision: was it the right one?",
      "Decisions are logged in the ADR folder.",
      "Decision making is slow here.",
    ],
  },
  {
    rule: "openapi-path",
    file: "api.yaml",
    positive: [
      API(`  /v1/users/{id}:
    get:
      summary: Get a user
      operationId: getUser
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        "200": { description: The user }
        "404": { description: No such user }`),
      API(`  /v1/sessions:
    post:
      summary: Start a session
      responses:
        "201": { description: Created }`),
      `swagger: "2.0"
info: { title: Legacy API, version: "1" }
host: api.example.com
basePath: /v0
paths:
  /invoices:
    get:
      summary: List invoices
      responses:
        "200": { description: Invoices }
`,
    ],
    negative: [
      "openapi_notes: 3\npaths_seen: 2\n",
      "name: accounts\npaths:\n  /v1/users: {}\n",
      "info:\n  title: Not an API\n",
    ],
  },
  {
    rule: "http-route",
    positive: [
      "Call `POST /v1/sessions/{id}/refresh` with the refresh token.",
      "The client sends GET /health every minute.",
      "```http\nDELETE /v1/users/42\n```",
    ],
    negative: [
      "Get or set the value in the panel.",
      "Use POST requests for writes.",
      "The GET-request handler lives in /api.",
    ],
  },
  {
    rule: "graphql",
    positive: [
      "```graphql\ntype Query {\n  user(id: ID!): User\n  invoices: [Invoice]\n}\n```",
      "```graphql\ntype Mutation {\n  refreshSession(token: String!): Session\n}\n```",
      "```gql\nextend type Query {\n  health: Boolean\n}\n```",
    ],
    negative: [
      "```graphql\ntype User {\n  id: ID!\n}\n```",
      "The Query type lists reads.",
      "```ts\ntype Query = { id: string }\n```",
    ],
  },
  {
    rule: "grpc",
    positive: [
      "```proto\nservice Users {\n  rpc GetUser (GetUserRequest) returns (User);\n}\n```",
      "Call rpc Refresh(RefreshRequest) returns (Session) to rotate tokens.",
      "```proto\nservice Billing {\n  rpc ListInvoices (ListRequest) returns (stream Invoice);\n}\n```",
    ],
    negative: [
      "The RPC layer returns errors as codes.",
      "Our rpc calls are slow on mobile.",
      "```proto\nmessage User {\n  string id = 1;\n}\n```",
    ],
  },
  {
    rule: "env",
    positive: [
      "Set `DATABASE_URL` before starting the server.",
      "```sh\nexport API_BASE_URL=https://api.example.com\n```",
      "The environment variable REDIS_URL points at the cache.",
      "```ts\nconst url = process.env.SERVICE_URL\n```",
    ],
    negative: [
      "Use the MAX_VALUE limit from the docs.",
      "`ERR_TIMEOUT` is returned when the call is slow.",
      "```ts\nconst MAX_RETRIES = 3\n```",
    ],
  },
  {
    rule: "cli",
    positive: [
      "Run `vector memory doc add spec.md --replace` to add it.",
      "```sh\n$ bun test --timeout 5000\n```",
      "`git push --force-with-lease` rewrites the branch.",
    ],
    negative: ["Run `npm install` first.", "Pass --verbose for details.", "```sh\nls | grep foo -v\n```"],
  },
  {
    rule: "config-key",
    positive: [
      "`server.port` sets the port.",
      "Set `auth.tokenTtl` to 3600.",
      "`memory.repositoryDocs` turns the scan off.",
    ],
    negative: [
      "`package.json` lists the dependencies.",
      "`example.com` is reserved for docs.",
      "Release `v1.2.3` fixed it.",
    ],
  },
  {
    rule: "function",
    positive: [
      "Call `refreshToken()` before the request.",
      "`Brain.recall()` loads the entries.",
      "`useSession()` returns the user.",
    ],
    negative: ["`refreshToken` is a string.", "Call refresh() now.", "`f(x)` maps a value."],
  },
  {
    rule: "error-code",
    positive: [
      "The API returns `E1042` when the token expired.",
      "`ERR_UPLOAD_TOO_LARGE` means the file is over the limit.",
      "Error E2001 means the quota is exhausted.",
    ],
    negative: ["E2E tests run nightly.", "ERROR: something went wrong.", "Use the E-mail form."],
  },
  {
    rule: "procedure-heading",
    positive: [
      "## Deploy steps\n\n1. Build the image.\n2. Push it to the registry.\n3. Restart the service.",
      "## How to rotate keys\n\n1. Generate a key.\n2. Upload it to the vault.",
      "## Rollback\n\n1. Revert the tag.\n2. Redeploy the previous build.",
    ],
    negative: [
      "## Deploy steps\n\n- Fast\n- Safe",
      "## Features\n\n1. Search.\n2. Export.",
      "## Steps\n\n1. Only one step here.",
    ],
  },
  {
    rule: "procedure-imperative",
    positive: [
      "## Checklist\n\n- Run the tests.\n- Update the changelog.\n- Tag the release.",
      "## Before you merge\n\n- Rebase on main.\n- Run the linter.\n- Request a review.",
      "## Weekly\n\n1. Rotate the keys.\n2. Archive old logs.\n3. Check the backups.",
    ],
    negative: [
      "## Team\n\n- Alice\n- Bob\n- Carol",
      "## Changes\n\n- Added export.\n- Fixed search.\n- Improved speed.",
      "## Ideas\n\n- Dark mode\n- Run history\n- Better search",
    ],
  },
  {
    rule: "glossary-table",
    positive: [
      "| Term | Definition |\n|---|---|\n| SLO | Service level objective |\n| RPO | Recovery point objective |",
      "| Acronym | Meaning |\n|---|---|\n| TTL | Time to live |",
      "| Word | Explanation |\n|---|---|\n| Tenant | A customer account |",
    ],
    negative: [
      "| Name | Description |\n|---|---|\n| timeout | Request timeout |",
      "| Term | Owner |\n|---|---|\n| Q3 | Alice |",
      "| Month | Revenue |\n|---|---|\n| May | 10 |",
    ],
  },
  {
    rule: "glossary-entry",
    positive: [
      "## Glossary\n\n- Tenant: a customer account with its own data.\n- Seat: one paid user.",
      "## Definitions\n\nWorkspace — the folder a session works in.",
      "## Terminology\n\nDrain: running every queued input of a session.",
    ],
    negative: [
      "## Notes\n\n- Tenant: a customer account.",
      "## Glossary\n\nThis section lists the words used below.",
      "## Steps\n\n- Build: run the build.",
    ],
  },
  {
    rule: "definition-prose",
    positive: [
      "A Tenant is defined as a customer account with its own database.",
      "Throughput means requests served per second.",
      "The term Seat refers to one paid user.",
    ],
    negative: ["This means the queue is empty.", "It refers to the old API.", "That means we ship on Friday."],
  },
  {
    rule: "acronym",
    positive: [
      "The Service Level Objective (SLO) is reviewed monthly.",
      "Each Recovery Point Objective (RPO) is set per tenant.",
      "We follow Test Driven Development (TDD) for the parser.",
    ],
    negative: [
      "The meeting (Friday) is cancelled.",
      "Use the API (beta) with care.",
      "Ask the Billing Team (BT2) first.",
    ],
  },
  {
    rule: "create-table",
    positive: [
      "```sql\nCREATE TABLE invoices (id integer primary key);\n```",
      "```sql\nCREATE TABLE IF NOT EXISTS sessions (id text);\n```",
      "Run CREATE TABLE audit_log (id integer) once.",
    ],
    negative: [
      "```sql\nSELECT * FROM invoices;\n```",
      "We create tables on demand.",
      "The table was created last year.",
    ],
  },
  {
    rule: "named-entity",
    positive: [
      "The Billing Service retries invoices. The Billing Service sends receipts. Alerts go to the Billing on-call.",
      "Events flow through the `audit_events` queue. The `audit_events` queue is durable. Consumers read `audit_events` in order.",
      "Deploys go to the staging environment first. The staging environment mirrors production. Reset staging weekly.",
    ],
    negative: [
      "The Billing Service retries invoices.",
      "Our service is fast. The service scales. Every service logs.",
      "Each Service is owned by a team. Each team owns a queue. Each queue has a dashboard.",
    ],
  },
  {
    rule: "schema-definition",
    file: "schema.json",
    positive: [
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "Invoice",
        type: "object",
        properties: { id: { type: "string" } },
      }),
      JSON.stringify({ definitions: { Address: { type: "object", properties: { city: { type: "string" } } } } }),
      JSON.stringify({
        $defs: { Money: { type: "object", properties: { cents: { type: "integer" } } } },
        $schema: "x",
      }),
    ],
    negative: [
      JSON.stringify({ name: "accounts", version: 2 }),
      JSON.stringify([{ id: 1 }, { id: 2 }]),
      JSON.stringify({ schema: "public", tables: 3 }),
    ],
  },
  {
    rule: "parameter-table",
    positive: [
      "| Name | Default | Description |\n|---|---|---|\n| timeout | 30 s | Request timeout |",
      "| Option | Type | Description |\n|---|---|---|\n| --verbose | boolean | Print more |",
      "| Key | Value |\n|---|---|\n| region | eu-west-1 |",
    ],
    negative: [
      "| Term | Definition |\n|---|---|\n| SLO | Service level objective |",
      "| ID | Requirement |\n|---|---|\n| REQ-1 | Users can export |",
      "| Month | Revenue |\n|---|---|\n| May | 10 |",
    ],
  },
  {
    rule: "stated-value",
    positive: ["p95 latency is 200 ms.", "The average payload is about 12 KB.", "Error rate was 0.4%."],
    negative: ["The client MUST wait 200 ms.", "Latency is low today.", "We have 3 teams."],
  },
  {
    rule: "tbd",
    positive: [
      "TBD: the key rotation schedule.",
      "The retention period is to be decided.",
      "TODO confirm the rate limit with the API team.",
    ],
    negative: ["The todo list syncs nightly.", "To be clear, the export is daily.", "We decided the retention period."],
  },
  {
    rule: "open-question",
    positive: [
      "## Open questions\n\n- Should refresh tokens bind to devices?",
      "Open question: who owns the billing alerts?",
      "## Questions\n\nDo we need SSO for guests?",
    ],
    negative: [
      "## FAQ\n\nHow do I reset my password?",
      "## Usage\n\nWhy does this matter? Tokens leak.",
      "## Open questions\n\nNone right now.",
    ],
  },
  {
    rule: "heading-question",
    positive: [
      "## Should we shard the sessions table?\n\nNo answer yet.",
      "## Who rotates the keys?\n\nUnclear.",
      "### Is SSO required for guests?\n\nAsk legal.",
    ],
    negative: [
      "# FAQ\n\n## How do I reset my password?\n\nUse the link.",
      "## Why Vector\n\nIt is fast.",
      "# Frequently asked questions\n\n## Can I export data?\n\nYes.",
    ],
  },
]

/** A small specification and its second version: reworded, reordered and with one value changed. */
export const SPEC_V1 = `# Auth spec

## 1 Sessions

The client MUST refresh the session before it expires.
Refresh tokens expire after 14 days.

## 2 Limits

Clients MUST retry at most 3 times after a 429 response.
Uploads are limited to 50 MB per file.

## 3 Endpoints

Call \`POST /v1/sessions/{id}/refresh\` with the refresh token. Set \`DATABASE_URL\` before starting.

## Glossary

- SLO: service level objective.
`

export const SPEC_V2 = `# Auth spec

## Glossary

- SLO: the service level objective.

## 1 Endpoints

To refresh, call \`POST /v1/sessions/{id}/refresh\` with the refresh token. Set \`DATABASE_URL\` before starting.

## 2 Limits

Uploads are limited to 50 MB per file.
The clients MUST retry at most 5 times after a 429 response.

## 3 Sessions

Refresh tokens expire after 14 days.
Clients MUST refresh their sessions before they expire.
`

/** Prose with no requirement, value, contract or question in it. */
export const PLAIN = `# Team notes

The team met on Tuesday. We talked about the roadmap, the offsite and lunch.
Everyone agreed the new office is bright. Next week we look at hiring.
`
