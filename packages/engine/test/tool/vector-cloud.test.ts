import { describe, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Cause, Effect, Exit, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { Parameters, VectorCloudTool } from "../../src/tool/vector-cloud"
import { VECTOR_CLOUD_POLICY } from "../../src/session/system"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])))

type Reply = { report: unknown; status?: number }

// A fake desktop bridge. `describe` requests get the scope the permission
// prompt shows; every other command gets the report under test.
function bridge(report: unknown, status = 200, describe: Reply = { report: { ok: false } }) {
  return Effect.gen(function* () {
    const requests: Record<string, unknown>[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            expect(request.method).toBe("POST")
            expect(request.headers.get("authorization")).toBe("Bearer cloud-test-token")
            const body = await request.json()
            requests.push(body)
            if (body.command === "describe") return Response.json(describe.report, { status: describe.status ?? 200 })
            return Response.json(report, { status })
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const previousUrl = process.env.VECTOR_CLOUD_BRIDGE_URL
    const previousToken = process.env.VECTOR_CLOUD_BRIDGE_TOKEN
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        previousUrl === undefined
          ? delete process.env.VECTOR_CLOUD_BRIDGE_URL
          : (process.env.VECTOR_CLOUD_BRIDGE_URL = previousUrl)
        previousToken === undefined
          ? delete process.env.VECTOR_CLOUD_BRIDGE_TOKEN
          : (process.env.VECTOR_CLOUD_BRIDGE_TOKEN = previousToken)
      }),
    )
    process.env.VECTOR_CLOUD_BRIDGE_URL = `http://127.0.0.1:${server.port}`
    process.env.VECTOR_CLOUD_BRIDGE_TOKEN = "cloud-test-token"
    return requests
  })
}

function scope(provider: string, project: string, environment: string, summary: string): Reply {
  return { report: { ok: true, scope: { provider, project, environment, summary } } }
}

function execute(params: Schema.Schema.Type<typeof Parameters>, ask: Tool.Context["ask"] = () => Effect.void) {
  return Effect.gen(function* () {
    const info = yield* VectorCloudTool
    const tool = yield* info.init()
    return yield* tool.execute(params, {
      sessionID: SessionID.descending(),
      messageID: MessageID.ascending(),
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask,
    })
  })
}

function recordAsks() {
  const permissions: Parameters<Tool.Context["ask"]>[0][] = []
  const ask: Tool.Context["ask"] = (input) =>
    Effect.sync(() => {
      permissions.push(input)
    })
  return { permissions, ask }
}

describe("vector_cloud bridge", () => {
  it.instance("reports the linked destination in Cloud status without asking", () =>
    Effect.gen(function* () {
      const requests = yield* bridge({
        ok: true,
        configured: true,
        targets: [{ id: "vercel", label: "Vercel", projectName: "customer-site" }],
        connections: [{ provider: "vercel", connected: true }],
      })
      const asks = recordAsks()
      const result = yield* execute({ action: "status" }, asks.ask)
      expect(asks.permissions).toEqual([])
      expect(requests.map((item) => item.command)).toEqual(["status"])
      expect(result.output).toContain("Vector Cloud configured: yes")
      expect(result.output).toContain("customer-site")
      expect(result.output).toContain('"provider":"vercel"')
    }),
  )

  it.instance("relays missing hosting setup without asking or publishing", () =>
    Effect.gen(function* () {
      const requests = yield* bridge({ ok: true, url: "https://never.invalid" }, 200, {
        report: {
          ok: false,
          needsSetup: true,
          targets: [],
          error: "Connect and link a Vercel project in Vector Cloud before publishing.",
          nextStep: "Ask the user to connect Vercel and link a project in Vector Cloud > Connections.",
        },
      })
      const asks = recordAsks()
      const result = yield* execute({ action: "publish" }, asks.ask)
      expect(asks.permissions).toEqual([])
      expect(requests).toEqual([expect.objectContaining({ command: "describe", action: "publish" })])
      expect(result.output).toContain("Connect and link a Vercel project")
      expect(result.output).toContain("Vector Cloud > Connections")
      expect(result.output).not.toContain("publish completed")
    }),
  )

  it.instance("asks with the Vercel project and environment before publishing, and makes no fallback request", () =>
    Effect.gen(function* () {
      const requests = yield* bridge(
        { ok: false, error: "The selected Vercel project is unavailable." },
        400,
        scope(
          "Vercel",
          "website",
          "preview",
          "Publish this project to the Vercel project website as a preview release.",
        ),
      )
      const asks = recordAsks()
      const result = yield* execute({ action: "publish", production: false }, asks.ask)
      expect(requests.map((item) => item.command)).toEqual(["describe", "publish"])
      expect(requests[1]).toMatchObject({ command: "publish", production: false })
      expect(requests[1]).not.toHaveProperty("target")
      expect(asks.permissions).toEqual([
        expect.objectContaining({
          permission: "vector_cloud_publish",
          // The pattern names the action; a publish asks every time, so nothing can be remembered.
          patterns: ["vercel/website/preview/publish"],
          always: [],
          metadata: expect.objectContaining({
            provider: "Vercel",
            project: "website",
            environment: "preview",
            summary: "Publish this project to the Vercel project website as a preview release.",
            production: false,
          }),
        }),
      ])
      expect(result.output).toContain("The selected Vercel project is unavailable.")
      expect(result.output).not.toContain("publish completed")
    }),
  )

  it.instance("an agent workspace publish reports its preview and how production moves", () =>
    Effect.gen(function* () {
      yield* bridge(
        {
          ok: true,
          url: "https://agent-preview.vercel.app",
          nextStep:
            "This agent workspace was published as a preview. Merge it into the main project before promoting it to production.",
        },
        200,
        scope("Vercel", "website", "preview", "Publish this agent workspace to the Vercel project website."),
      )
      const result = yield* execute({ action: "publish" })
      expect(result.output).toContain("URL: https://agent-preview.vercel.app")
      expect(result.output).toContain("Merge it into the main project before promoting it to production.")
    }),
  )

  it.instance("a publish without production asks for a preview and reports one", () =>
    Effect.gen(function* () {
      const requests = yield* bridge(
        {
          ok: true,
          environment: "preview",
          url: "https://shop-git-abc.vercel.app",
          deploymentId: "dep_1",
          checks: [
            { label: "Production build", status: "passed", required: true },
            { label: "Browser smoke test", status: "passed", required: true },
          ],
        },
        200,
        scope("Vercel", "shop", "preview", "Publish this project to the Vercel project shop as a preview release."),
      )
      const asks = recordAsks()
      const result = yield* execute({ action: "publish" }, asks.ask)
      expect(requests[1]).toMatchObject({ command: "publish" })
      expect(requests[1]).not.toHaveProperty("production")
      expect(asks.permissions[0]?.metadata).toMatchObject({ environment: "preview", production: false })
      expect(result.output).toContain("published a preview release. Production is unchanged.")
      expect(result.output).toContain("URL: https://shop-git-abc.vercel.app")
      expect(result.output).toContain("Checks: Production build passed; Browser smoke test passed")
      expect(result.output).toContain("publish again with production: true")
    }),
  )

  it.instance("a failed build reaches the agent as evidence, not as a setup hint", () =>
    Effect.gen(function* () {
      const output = Array.from({ length: 60 }, (_, index) => `build line ${index + 1}`).join("\n")
      yield* bridge(
        {
          ok: false,
          target: "vercel",
          error: "Required pre-deploy checks failed. Review the evidence, repair the project, and publish again.",
          log: `install output\n${output}`,
          checks: [
            { label: "Install dependencies", status: "passed", required: true, output: "added 12 packages" },
            {
              label: "Production build",
              status: "failed",
              required: true,
              details: "Production build failed.",
              output: `${output}\nsrc/App.tsx(4,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
            },
          ],
        },
        400,
        scope("Vercel", "shop", "preview", "Publish this project to the Vercel project shop as a preview release."),
      )
      const result = yield* execute({ action: "publish" })
      expect(result.output).toContain("Vector Cloud publish failed: Required pre-deploy checks failed.")
      expect(result.output).toContain("- Production build: Production build failed.")
      expect(result.output).toContain("error TS2322")
      expect(result.output).toContain("build line 60")
      // Only the end of a long build log reaches the model.
      expect(result.output).not.toContain("build line 20\n")
      // A passing check's output and the duplicated log stay out.
      expect(result.output).not.toContain("added 12 packages")
      expect(result.output).not.toContain("install output")
      expect(result.output).not.toContain("Vector Cloud > Connections")
      expect(result.output).not.toContain("publish completed")
    }),
  )

  it.instance("a deploy that failed without a check shows the end of the publish log", () =>
    Effect.gen(function* () {
      yield* bridge(
        {
          ok: false,
          target: "vercel",
          error: "Vercel exited with code 1.",
          log: "Vercel CLI 39.0.0\nError: Project not found in this scope.",
          checks: [{ label: "Secret scan", status: "passed", required: true }],
        },
        400,
        scope("Vercel", "shop", "preview", "Publish this project to the Vercel project shop as a preview release."),
      )
      const result = yield* execute({ action: "publish" })
      expect(result.output).toContain("Vector Cloud publish failed: Vercel exited with code 1.")
      expect(result.output).toContain("--- last lines of the publish log ---")
      expect(result.output).toContain("Error: Project not found in this scope.")
      expect(result.output).not.toContain("Failed checks:")
    }),
  )

  it.instance("names the Connections screen only when setup is missing", () =>
    Effect.gen(function* () {
      yield* bridge({ ok: false, needsSetup: true, error: "Supabase rejected the saved access token." })
      const setup = yield* execute({ action: "supabase_services" })
      expect(setup.output).toContain("Supabase rejected the saved access token.")
      expect(setup.output).toContain("connect Vercel or Supabase in Vector Cloud > Connections")
    }),
  )

  it.instance("leaves the setup hint off a failure that is not about setup", () =>
    Effect.gen(function* () {
      yield* bridge({ ok: false, error: "Supabase is temporarily unavailable." })
      const result = yield* execute({ action: "supabase_services" })
      expect(result.output).toContain("Supabase is temporarily unavailable.")
      expect(result.output).not.toContain("Vector Cloud > Connections")
    }),
  )

  it.instance("its description agrees with the system prompt's cloud rules", () =>
    Effect.gen(function* () {
      const info = yield* VectorCloudTool
      const tool = yield* info.init()
      for (const text of [tool.description, VECTOR_CLOUD_POLICY]) {
        expect(text).toContain("create_database")
        expect(text).toContain("Vector Cloud > Database")
        expect(text).toContain("production: true")
        expect(text).toMatch(/offer (vector_cloud )?rollback/)
        expect(text).toContain("link_database")
        expect(text).toContain("Vector Cloud > Environment variables")
        expect(text).toContain("Vector Cloud > Connections")
        expect(text).toMatch(/Never ask (the user )?(to paste|for secret values)/)
        expect(text).not.toMatch(/Netlify|AWS|Cloud Services|Integrations/)
      }
      expect(tool.description).toContain("publishes a preview by default")
      // One rule for every account change: it asks each time, whatever auto-accept or earlier approvals say.
      expect(tool.description).toContain("asks the user first, every time")
      expect(tool.description).not.toContain("allowed that kind of action always")
      // Values Vector writes to .env are secrets the model must not read.
      expect(tool.description).not.toContain("which you can read")
      expect(VECTOR_CLOUD_POLICY).toContain("do not read .env files")
      expect(VECTOR_CLOUD_POLICY).toContain("Publish previews by default")
    }),
  )

  it.instance("a denied publish never reaches the provider", () =>
    Effect.gen(function* () {
      const requests = yield* bridge(
        { ok: true, url: "https://never.invalid" },
        200,
        scope(
          "Vercel",
          "website",
          "production",
          "Publish this project to the Vercel project website as a production release.",
        ),
      )
      const result = yield* execute({ action: "publish" }, () => Effect.die(new Error("permission rejected"))).pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(requests.map((item) => item.command)).toEqual(["describe"])
    }),
  )

  it.instance("asks before database and host environment changes with the project they touch", () =>
    Effect.gen(function* () {
      const cases = [
        {
          params: { action: "create_database", organizationId: "org_1", region: "eu-west-2" } as const,
          permission: "vector_cloud_database",
          scope: scope(
            "Supabase",
            "a new project",
            "production",
            "Create a new Supabase project in organization org_1.",
          ),
        },
        {
          params: { action: "create_organization", organizationName: "Ada Labs" } as const,
          permission: "vector_cloud_database",
          scope: scope(
            "Supabase",
            "organization Ada Labs",
            "account",
            "Create a Supabase organization named Ada Labs on the connected Supabase account.",
          ),
        },
        {
          params: { action: "apply_migrations" } as const,
          permission: "vector_cloud_database",
          scope: scope("Supabase", "shop-db", "production", "Apply this project's pending migrations to shop-db."),
        },
        {
          params: { action: "apply_migrations", dryRun: true } as const,
          permission: "vector_cloud_inspect",
          scope: scope("Supabase", "shop-db", "production", "Read which migrations shop-db has applied."),
        },
        {
          params: { action: "prepare_auth" } as const,
          permission: "vector_cloud_database",
          scope: scope("Supabase", "shop-db", "local .env", "Write shop-db's public client settings to .env."),
        },
        {
          params: { action: "sync_environment" } as const,
          permission: "vector_cloud_environment",
          scope: scope("Vercel", "website", "production, preview and development", "Write 2 environment variables."),
        },
      ]
      for (const item of cases) {
        const requests = yield* bridge({ ok: true }, 200, item.scope)
        const asks = recordAsks()
        yield* execute(item.params, asks.ask)
        const described = item.scope.report as { scope: Record<string, string> }
        const pattern = [
          described.scope.provider.toLowerCase(),
          described.scope.project,
          described.scope.environment,
          item.params.action,
        ].join("/")
        expect(asks.permissions).toEqual([
          expect.objectContaining({
            permission: item.permission,
            patterns: [pattern],
            // Only the read-only dry run may be remembered; every account change asks each time.
            always: item.permission === "vector_cloud_inspect" ? [pattern] : [],
            metadata: expect.objectContaining(described.scope),
          }),
        ])
        expect(requests.map((request) => request.command)).toEqual(["describe", item.params.action])
        expect(requests[0]).toMatchObject({ action: item.params.action })
        if ("organizationName" in item.params) {
          expect(requests[1]).toMatchObject({ organizationName: item.params.organizationName })
        }
      }
    }),
  )

  it.instance("reports which migrations the Supabase CLI applied and which files changed", () =>
    Effect.gen(function* () {
      yield* bridge(
        {
          ok: true,
          error: "0001_init.sql failed: 0001_init.sql changed after it was applied.",
          migrations: {
            dryRun: true,
            directory: "supabase/migrations",
            projectRef: "shopref",
            alreadyApplied: ["0001_init.sql", "20240101000000_cli.sql"],
            appliedByCli: ["20240101000000_cli.sql"],
            changed: ["0001_init.sql"],
            pending: ["0002_likes.sql"],
            applied: [],
            failed: { name: "0001_init.sql", error: "0001_init.sql changed after it was applied." },
          },
        },
        200,
        scope("Supabase", "shop-db", "production", "Read which migrations shop-db has applied."),
      )
      const result = yield* execute({ action: "apply_migrations", dryRun: true })
      expect(result.output).toContain("1 migration(s) would run against Supabase project shopref (production)")
      expect(result.output).toContain("Recorded by the Supabase CLI, so not run again: 20240101000000_cli.sql")
      expect(result.output).toContain(
        "Changed after they were applied, so nothing runs until they are restored: 0001_init.sql",
      )
    }),
  )

  it.instance("asks every time for each Supabase change and maps its fields", () =>
    Effect.gen(function* () {
      const cases = [
        {
          params: { action: "run_sql", sql: "delete from sessions", allowWrite: true } as const,
          sent: { sql: "delete from sessions", write: true },
        },
        {
          params: { action: "create_bucket", bucket: "avatars", publicBucket: false } as const,
          sent: { bucket: "avatars", public: false },
        },
        {
          params: {
            action: "update_auth",
            authProvider: "google",
            providerEnabled: true,
            clientId: "google-client",
            redirectUrls: ["https://shop.example.com/**"],
          } as const,
          sent: {
            providers: { google: { enabled: true, clientId: "google-client" } },
            redirectUrls: ["https://shop.example.com/**"],
          },
        },
        {
          params: { action: "delete_user", userId: "00000000-0000-0000-0000-000000000000" } as const,
          sent: { userId: "00000000-0000-0000-0000-000000000000" },
        },
      ]
      for (const item of cases) {
        const described = scope("Supabase", "shop-db", "production", `Change shop-db with ${item.params.action}.`)
        const requests = yield* bridge({ ok: true }, 200, described)
        const asks = recordAsks()
        yield* execute(item.params, asks.ask)
        expect(asks.permissions).toEqual([
          expect.objectContaining({
            permission: "vector_cloud_database",
            patterns: [`supabase/shop-db/production/${item.params.action}`],
            always: [],
            metadata: expect.objectContaining({ provider: "Supabase", project: "shop-db", action: item.params.action }),
          }),
        ])
        expect(requests.map((request) => request.command)).toEqual(["describe", item.params.action])
        expect(requests[1]).toMatchObject(item.sent)
      }
    }),
  )

  it.instance("a denied Supabase change never reaches the project", () =>
    Effect.gen(function* () {
      const requests = yield* bridge(
        { ok: true },
        200,
        scope("Supabase", "shop-db", "production", "Delete the storage bucket avatars from shop-db."),
      )
      const result = yield* execute({ action: "delete_bucket", bucket: "avatars", emptyBucket: true }, () =>
        Effect.die(new Error("permission rejected")),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(requests).toEqual([expect.objectContaining({ command: "describe", action: "delete_bucket", empty: true })])
    }),
  )

  it.instance("writes a new migration only after the edit permission, which plan mode refuses", () =>
    Effect.gen(function* () {
      const files = [
        "supabase/migrations/20261010120000_add_profiles.sql",
        "supabase/migrations/down/20261010120000_add_profiles.down.sql",
      ]
      const statements = [
        {
          label: `Migration ${files[0]}`,
          sql: "create table profiles (id uuid primary key);",
          length: 44,
          truncated: false,
        },
        { label: `Down migration ${files[1]}`, sql: "drop table profiles;", length: 20, truncated: false },
      ]
      const params = {
        action: "create_migration",
        migrationName: "add profiles",
        sql: "create table profiles (id uuid primary key);",
        downSql: "drop table profiles;",
      } as const
      const requests = yield* bridge({ ok: true, file: files[0] }, 200, {
        report: { ok: true, files, statements, approved: { version: "20261010120000" } },
      })
      const asks = recordAsks()
      const result = yield* execute(params, asks.ask)
      // Both files are in the prompt: the down SQL is what rollback_migration
      // later runs against the live database.
      expect(asks.permissions).toEqual([
        expect.objectContaining({
          permission: "edit",
          patterns: [
            expect.stringMatching(/supabase\/migrations\/20261010120000_add_profiles\.sql$/),
            expect.stringMatching(/supabase\/migrations\/down\/20261010120000_add_profiles\.down\.sql$/),
          ],
          metadata: expect.objectContaining({
            filepath: expect.stringContaining(files[0]),
            diff: expect.stringContaining("+create table profiles (id uuid primary key);"),
            statements,
          }),
        }),
      ])
      expect(String(asks.permissions[0].metadata.diff)).toContain("+drop table profiles;")
      expect(requests.map((item) => item.command)).toEqual(["describe", "create_migration"])
      // The file written is the one the prompt named.
      expect(requests[1]).toMatchObject({ name: "add profiles", sql: params.sql, version: "20261010120000" })
      expect(result.output).toContain(files[0])

      const refused = yield* bridge({ ok: true }, 200, { report: { ok: true, files } })
      const denied = yield* execute(params, () => Effect.die(new Error("edit is denied in plan mode"))).pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(denied)).toBe(true)
      expect(refused.map((item) => item.command)).toEqual(["describe"])
    }),
  )

  it.instance("shows forward SQL and passes its exact approval to the runner", () =>
    Effect.gen(function* () {
      const statements = [{ label: "Migration 1.sql", sql: "create table posts ();", length: 22, truncated: false }]
      const requests = yield* bridge({ ok: true }, 200, {
        report: {
          ok: true,
          scope: {
            provider: "Supabase",
            project: "shop-db",
            environment: "production",
            summary: "Apply reviewed SQL.",
          },
          statements,
          approved: { approvalID: "approved-forward-plan" },
        },
      })
      const asks = recordAsks()
      yield* execute({ action: "apply_migrations" }, asks.ask)
      expect(asks.permissions).toEqual([
        expect.objectContaining({
          permission: "vector_cloud_database",
          always: [],
          metadata: expect.objectContaining({ statements }),
        }),
      ])
      expect(requests[1]).toMatchObject({ command: "apply_migrations", approvalID: "approved-forward-plan" })
    }),
  )

  it.instance("shows the SQL a database change runs, and runs only what was shown", () =>
    Effect.gen(function* () {
      const statements = [
        {
          label: "Down migration supabase/migrations/down/20261010120000_add_profiles.down.sql",
          sql: "drop table profiles;",
          length: 20,
          truncated: false,
        },
      ]
      const requests = yield* bridge({ ok: true, rolledBack: "20261010120000_add_profiles.sql" }, 200, {
        report: {
          ok: true,
          scope: {
            provider: "Supabase",
            project: "shop-db",
            environment: "production",
            summary: "Roll back 20261010120000_add_profiles.sql.",
          },
          statements,
          approved: { name: "20261010120000_add_profiles.sql", downChecksum: "abc123" },
        },
      })
      const asks = recordAsks()
      yield* execute({ action: "rollback_migration" }, asks.ask)
      expect(asks.permissions).toEqual([
        expect.objectContaining({
          permission: "vector_cloud_database",
          always: [],
          metadata: expect.objectContaining({ summary: "Roll back 20261010120000_add_profiles.sql.", statements }),
        }),
      ])
      expect(requests.map((item) => item.command)).toEqual(["describe", "rollback_migration"])
      expect(requests[1]).toMatchObject({ name: "20261010120000_add_profiles.sql", downChecksum: "abc123" })
    }),
  )

  it.instance("reads Supabase logs, query results and the security check without asking", () =>
    Effect.gen(function* () {
      const asks = recordAsks()
      yield* bridge({
        ok: true,
        label: "Auth",
        from: "2026-10-10T09:00:00.000Z",
        to: "2026-10-10T10:00:00.000Z",
        truncated: false,
        entries: [{ at: "2026-10-10T09:30:00.000Z", message: "login failed: invalid grant" }],
      })
      const logs = yield* execute({ action: "supabase_logs", service: "auth" }, asks.ask)
      expect(logs.output).toContain("Auth logs from 2026-10-10T09:00:00.000Z")
      expect(logs.output).toContain("2026-10-10T09:30:00.000Z login failed: invalid grant")

      yield* bridge({
        ok: true,
        security: {
          status: "failed",
          detail: "1 security problem must be fixed before a production release.",
          advisors: [
            { level: "ERROR", title: "RLS Disabled in Public", entity: "public.orders", remediation: "Enable RLS" },
          ],
          environment: [],
          bundle: [{ level: "ERROR", where: "assets/index.js", reason: "ships a Supabase secret key" }],
        },
      })
      const security = yield* execute({ action: "security_check" }, asks.ask)
      expect(security.output).toContain("Supabase security check: failed.")
      expect(security.output).toContain("ERROR · RLS Disabled in Public · public.orders (Enable RLS)")
      expect(security.output).toContain("ERROR · assets/index.js ships a Supabase secret key")
      expect(asks.permissions).toEqual([])
    }),
  )

  it.instance("shows run_sql rows as a table, and relays a refused write", () =>
    Effect.gen(function* () {
      const described = scope("Supabase", "shop-db", "production", "Run a read-only SQL query against shop-db.")
      yield* bridge(
        {
          ok: true,
          project: { ref: "shopref", name: "shop-db" },
          result: {
            columns: ["id", "email"],
            rows: [
              [1, "a@example.com"],
              [2, null],
            ],
            rowCount: 2,
            truncated: false,
            readOnly: true,
          },
        },
        200,
        described,
      )
      const result = yield* execute({ action: "run_sql", sql: "select id, email from profiles" })
      expect(result.output).toContain("Read-only query on Supabase project shop-db: 2 of 2 row(s).")
      expect(result.output).toContain("id | email\n1 | a@example.com\n2 | null")

      yield* bridge(
        {
          ok: true,
          project: { ref: "shopref", name: "shop-db" },
          result: {
            columns: ["id", "encrypted_password"],
            rows: [[1, "[hidden]"]],
            rowCount: 1,
            truncated: false,
            readOnly: true,
            hiddenColumns: ["encrypted_password"],
          },
        },
        200,
        described,
      )
      const hidden = yield* execute({ action: "run_sql", sql: "select id, encrypted_password from auth.users" })
      expect(hidden.output).toContain("Hidden because they hold sign-in credentials: encrypted_password.")

      yield* bridge(
        {
          ok: false,
          needsConfirmation: true,
          error: "Supabase refused this query in read-only mode.",
          nextStep: "Run it again with allowWrite only if the user wants this change made to the live database.",
        },
        400,
        described,
      )
      const refused = yield* execute({ action: "run_sql", sql: "delete from profiles" })
      expect(refused.output).toContain(
        "Vector Cloud could not run run_sql: Supabase refused this query in read-only mode.",
      )
      expect(refused.output).toContain("allowWrite")
    }),
  )

  it.instance("rejects a response without an explicit operation result", () =>
    Effect.gen(function* () {
      yield* bridge({ error: "Unauthorized" }, 401)
      const result = yield* execute({ action: "status" }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("Vector Cloud command failed (401)")
    }),
  )

  it.instance("does not report success from an HTTP failure", () =>
    Effect.gen(function* () {
      yield* bridge(
        { ok: true, url: "https://example.invalid" },
        502,
        scope("Vercel", "website", "production", "Publish this project to the Vercel project website."),
      )
      const result = yield* execute({ action: "publish" }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("Vector Cloud command failed (502)")
    }),
  )
})

describe("vector_cloud release checks", () => {
  it.instance("probes and re-runs release checks without asking, and relays the bridge's words", () =>
    Effect.gen(function* () {
      for (const params of [
        { action: "check_health" },
        { action: "check_health", deploymentId: "dpl_live" },
        { action: "rerun_checks", deploymentId: "dpl_live" },
      ] as const) {
        const requests = yield* bridge({ ok: true, text: "https://shop.vercel.app (dpl_live) · ready · HTTP 200" })
        const asks = recordAsks()
        const result = yield* execute(params, asks.ask)
        expect(asks.permissions).toEqual([])
        expect(requests).toEqual([
          expect.objectContaining({
            command: params.action,
            ...("deploymentId" in params ? { deploymentId: params.deploymentId } : {}),
          }),
        ])
        expect(result.title).toBe("Release checks")
        expect(result.output).toBe("https://shop.vercel.app (dpl_live) · ready · HTTP 200")
      }
    }),
  )

  it.instance("asks under hosting settings, every time, before changing the required checks", () =>
    Effect.gen(function* () {
      const requests = yield* bridge(
        { ok: true, text: "Saved Vector's release settings: Secret scan no longer blocks a production release." },
        200,
        scope(
          "Vector Cloud",
          "shop",
          "release checks",
          "Change the release settings Vector uses before it publishes: Secret scan no longer blocks a production release.",
        ),
      )
      const asks = recordAsks()
      const result = yield* execute(
        { action: "set_release_settings", requiredChecks: { secrets: false }, testCommand: "bun test" },
        asks.ask,
      )
      expect(asks.permissions).toEqual([
        expect.objectContaining({
          permission: "vector_cloud_hosting",
          patterns: ["vector cloud/shop/release checks/set_release_settings"],
          always: [],
          metadata: expect.objectContaining({ summary: expect.stringContaining("Secret scan no longer blocks") }),
        }),
      ])
      expect(requests.map((item) => item.command)).toEqual(["describe", "set_release_settings"])
      expect(requests[1]).toMatchObject({ requiredChecks: { secrets: false }, testCommand: "bun test" })
      expect(result.output).toContain("Secret scan no longer blocks")
    }),
  )
})

describe("vector_cloud Vercel actions", () => {
  it.instance("asks before moving production, naming the action, and offers no 'always'", () =>
    Effect.gen(function* () {
      const requests = yield* bridge(
        { ok: true, text: "Production now serves https://shop-abc.vercel.app (dpl_abc).", url: "https://shop.example" },
        200,
        scope("Vercel", "shop", "production", "Point production traffic of the Vercel project shop at dpl_abc."),
      )
      const asks = recordAsks()
      const result = yield* execute({ action: "promote", deploymentId: "dpl_abc" }, asks.ask)
      expect(asks.permissions).toEqual([
        expect.objectContaining({
          permission: "vector_cloud_publish",
          patterns: ["vercel/shop/production/promote"],
          always: [],
          metadata: expect.objectContaining({
            provider: "Vercel",
            project: "shop",
            environment: "production",
            action: "promote",
          }),
        }),
      ])
      expect(requests.map((item) => item.command)).toEqual(["describe", "promote"])
      expect(requests[1]).toMatchObject({ deploymentId: "dpl_abc" })
      expect(result.output).toBe("Production now serves https://shop-abc.vercel.app (dpl_abc).")
    }),
  )

  it.instance("puts project, protection and domain changes under hosting settings", () =>
    Effect.gen(function* () {
      for (const params of [
        { action: "add_domain", domain: "shop.example" },
        { action: "create_project", name: "shop" },
        { action: "update_project_settings", nodeVersion: "22.x" },
        { action: "enable_protection_bypass" },
      ] as const) {
        yield* bridge({ ok: true, text: "done" }, 200, scope("Vercel", "shop", "production", "Change shop."))
        const asks = recordAsks()
        yield* execute(params, asks.ask)
        expect(asks.permissions.map((item) => item.permission)).toEqual(["vector_cloud_hosting"])
      }
    }),
  )

  it.instance("sends a variable's value to the bridge but never shows it", () =>
    Effect.gen(function* () {
      const requests = yield* bridge(
        {
          ok: true,
          text: "Created STRIPE_KEY on shop for production.",
          nextStep: "Redeploy for the new value to take effect.",
        },
        200,
        scope("Vercel", "shop", "production", "Set STRIPE_KEY on the Vercel project shop for production."),
      )
      const asks = recordAsks()
      const result = yield* execute(
        { action: "set_env", key: "STRIPE_KEY", value: "sk_test_fixture", targets: ["production"] },
        asks.ask,
      )
      expect(asks.permissions.map((item) => item.permission)).toEqual(["vector_cloud_environment"])
      expect(JSON.stringify(asks.permissions)).not.toContain("sk_test_fixture")
      expect(requests[1]).toMatchObject({ command: "set_env", value: "sk_test_fixture", targets: ["production"] })
      expect(result.output).not.toContain("sk_test_fixture")
      expect(result.output).toContain("Redeploy")
    }),
  )

  it.instance("applies the environment plan the user approved, and asks nothing when there is none", () =>
    Effect.gen(function* () {
      const requests = yield* bridge({ ok: true, text: "Applied the plan to shop: create API_URL (preview)." }, 200, {
        report: {
          ok: true,
          scope: {
            provider: "Vercel",
            project: "shop",
            environment: "preview",
            summary: "Sync: create API_URL (preview).",
          },
          carry: { planId: "plan-fixture", targets: ["preview"] },
        },
      })
      const result = yield* execute({ action: "sync_environment", targets: ["preview"] })
      expect(requests[1]).toMatchObject({ command: "sync_environment", planId: "plan-fixture", targets: ["preview"] })
      expect(result.output).toContain("Applied the plan")

      const idle = yield* bridge({ ok: true, text: "never runs" }, 200, {
        report: { ok: true, noop: true, text: "Sync plan for shop: Nothing to change." },
      })
      const asks = recordAsks()
      const nothing = yield* execute({ action: "sync_environment" }, asks.ask)
      expect(asks.permissions).toEqual([])
      expect(idle.map((item) => item.command)).toEqual(["describe"])
      expect(nothing.output).toBe("Sync plan for shop: Nothing to change.")
    }),
  )

  it.instance("lists, writes and removes Vector's stored variables, asking before each change", () =>
    Effect.gen(function* () {
      const listed = yield* bridge({
        ok: true,
        variables: [
          { key: "STRIPE_SECRET_KEY", visibility: "server" },
          { key: "VITE_SITE_NAME", visibility: "public" },
        ],
      })
      const reads = recordAsks()
      const names = yield* execute({ action: "stored_env" }, reads.ask)
      expect(reads.permissions).toEqual([])
      expect(listed.map((item) => item.command)).toEqual(["stored_env"])
      expect(names.output).toBe(
        "Variables Vector stores for this project (names only; values never reach you): STRIPE_SECRET_KEY (server-only), VITE_SITE_NAME (public)",
      )

      const written = yield* bridge(
        { ok: true, applied: { written: ".env", gitignoreUpdated: true } },
        200,
        scope("Vector", "shop", "local .env", "Write this project's 2 stored environment variables to .env."),
      )
      const writes = recordAsks()
      const wrote = yield* execute({ action: "write_env_file" }, writes.ask)
      expect(writes.permissions).toMatchObject([
        { permission: "vector_cloud_environment", patterns: ["vector/shop/local .env/write_env_file"], always: [] },
      ])
      expect(written.map((item) => item.command)).toEqual(["describe", "write_env_file"])
      expect(wrote.output).toContain('"gitignoreUpdated":true')
      expect(wrote.output).toContain("Do not read .env")

      const removed = yield* bridge(
        { ok: true, removed: "VITE_SITE_NAME", variables: ["STRIPE_SECRET_KEY"] },
        200,
        scope("Vector", "shop", "stored variables", "Remove VITE_SITE_NAME from the variables Vector stores."),
      )
      const removes = recordAsks()
      const gone = yield* execute({ action: "remove_stored_env", key: "VITE_SITE_NAME" }, removes.ask)
      expect(removes.permissions.map((item) => [item.permission, item.always])).toEqual([
        ["vector_cloud_environment", []],
      ])
      expect(removed[1]).toMatchObject({ command: "remove_stored_env", key: "VITE_SITE_NAME" })
      expect(gone.output).toContain("Still stored: STRIPE_SECRET_KEY")
    }),
  )

  it.instance("reads Vercel state without asking", () =>
    Effect.gen(function* () {
      for (const action of ["list_env", "vercel_projects", "list_domains", "env_plan", "inspect_deployment"] as const) {
        const requests = yield* bridge({ ok: true, text: `${action} report` })
        const asks = recordAsks()
        const result = yield* execute({ action }, asks.ask)
        expect(asks.permissions).toEqual([])
        expect(requests.map((item) => item.command)).toEqual([action])
        expect(result.output).toBe(`${action} report`)
      }
    }),
  )

  it.instance("a failed publish shows the failed check and the end of the log, not a setup hint", () =>
    Effect.gen(function* () {
      yield* bridge(
        {
          ok: false,
          error: "Required pre-deploy checks failed.",
          errorCode: "checks_failed",
          checks: [
            {
              label: "Production build",
              status: "failed",
              required: true,
              details: "Production build failed.",
              output: "src/app.ts(3,1): error TS2304",
            },
            { label: "Install dependencies", status: "passed", required: true },
          ],
          log: "line 1\nnpm ERR! build failed",
          nextStep: "Read the failed checks above, fix the cause, and publish again.",
        },
        200,
        scope("Vercel", "shop", "preview", "Publish a preview."),
      )
      const result = yield* execute({ action: "publish" })
      expect(result.output).toContain("Vector Cloud publish failed: Required pre-deploy checks failed.")
      expect(result.output).toContain("- Production build: Production build failed.")
      expect(result.output).toContain("error TS2304")
      // The failed check's own output is the evidence; the log it came from is not repeated.
      expect(result.output).not.toContain("npm ERR! build failed")
      expect(result.output).toContain("fix the cause")
      expect(result.output).not.toContain("Vector Cloud > Connections")
    }),
  )

  it.instance("labels runtime logs as the running app's output", () =>
    Effect.gen(function* () {
      const requests = yield* bridge({
        ok: true,
        deploymentId: "dpl_abc",
        url: "https://shop.vercel.app",
        logs: {
          provider: "vercel",
          source: "runtime",
          environment: "production",
          status: "ready",
          createdAt: "2026-10-10",
          lines: 1,
          droppedLines: 0,
          tail: "[error] GET /cart 500 · boom",
        },
      })
      const result = yield* execute({ action: "logs", source: "runtime" })
      expect(requests[0]).toMatchObject({ command: "logs", source: "runtime" })
      expect(result.output).toContain("Source: Vercel runtime logs.")
      expect(result.output).toContain("GET /cart 500")
    }),
  )
})
