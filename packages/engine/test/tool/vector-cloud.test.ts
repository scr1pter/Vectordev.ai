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

describe("vector_cloud Vercel actions", () => {
  it.instance("asks before moving production, naming the action in what 'always' approves", () =>
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
          always: ["vercel/shop/production/promote"],
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
      expect(result.output).toContain("FAILED Production build: Production build failed.")
      expect(result.output).toContain("error TS2304")
      expect(result.output).toContain("npm ERR! build failed")
      expect(result.output).toContain("fix the cause")
      expect(result.output).not.toContain("Connect an account")
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
