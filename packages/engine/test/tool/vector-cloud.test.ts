import { describe, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Cause, Effect, Exit, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { Parameters, VectorCloudTool } from "../../src/tool/vector-cloud"
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
          nextStep: "Ask the user to connect Vercel and link a project in Cloud Services > Integrations.",
        },
      })
      const asks = recordAsks()
      const result = yield* execute({ action: "publish" }, asks.ask)
      expect(asks.permissions).toEqual([])
      expect(requests).toEqual([expect.objectContaining({ command: "describe", action: "publish" })])
      expect(result.output).toContain("Connect and link a Vercel project")
      expect(result.output).toContain("Cloud Services > Integrations")
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
          patterns: ["vercel/website/preview"],
          always: ["vercel/website/preview"],
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
        expect(asks.permissions).toEqual([
          expect.objectContaining({
            permission: item.permission,
            metadata: expect.objectContaining(described.scope),
          }),
        ])
        expect(requests.map((request) => request.command)).toEqual(["describe", item.params.action])
        expect(requests[0]).toMatchObject({ action: item.params.action })
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

  it.instance("asks per Supabase action, never offers always for destructive ones, and maps its fields", () =>
    Effect.gen(function* () {
      const cases = [
        {
          params: { action: "run_sql", sql: "delete from sessions", allowWrite: true } as const,
          repeatable: false,
          sent: { sql: "delete from sessions", write: true },
        },
        {
          params: { action: "create_bucket", bucket: "avatars", publicBucket: false } as const,
          repeatable: true,
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
          repeatable: true,
          sent: {
            providers: { google: { enabled: true, clientId: "google-client" } },
            redirectUrls: ["https://shop.example.com/**"],
          },
        },
        {
          params: { action: "delete_user", userId: "00000000-0000-0000-0000-000000000000" } as const,
          repeatable: false,
          sent: { userId: "00000000-0000-0000-0000-000000000000" },
        },
      ]
      for (const item of cases) {
        const described = scope("Supabase", "shop-db", "production", `Change shop-db with ${item.params.action}.`)
        const requests = yield* bridge({ ok: true }, 200, {
          report: { ...(described.report as object), repeatable: item.repeatable },
        })
        const asks = recordAsks()
        yield* execute(item.params, asks.ask)
        const pattern = `supabase/shop-db/production/${item.params.action}${item.repeatable ? "" : "/each-time"}`
        expect(asks.permissions).toEqual([
          expect.objectContaining({
            permission: "vector_cloud_database",
            patterns: [pattern],
            always: item.repeatable ? [pattern] : [],
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
          advisors: [{ level: "ERROR", title: "RLS Disabled in Public", entity: "public.orders", remediation: "Enable RLS" }],
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
          result: { columns: ["id", "email"], rows: [[1, "a@example.com"], [2, null]], rowCount: 2, truncated: false, readOnly: true },
        },
        200,
        described,
      )
      const result = yield* execute({ action: "run_sql", sql: "select id, email from profiles" })
      expect(result.output).toContain("Read-only query on Supabase project shop-db: 2 of 2 row(s).")
      expect(result.output).toContain("id | email\n1 | a@example.com\n2 | null")

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
      expect(refused.output).toContain("Vector Cloud could not run run_sql: Supabase refused this query in read-only mode.")
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
