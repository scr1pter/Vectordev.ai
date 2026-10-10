// A local stand-in for the Supabase APIs Vector drives, served over real HTTP on
// 127.0.0.1. Every request Vector makes to api.supabase.com, <ref>.supabase.co
// or api.vercel.com is rewritten to this server by `request`, which keeps the
// original host in a header so the routes below can tell the surfaces apart.
// Shapes follow the providers' documentation:
// - Management API: https://supabase.com/docs/reference/api/introduction
// - Auth admin: https://supabase.com/docs/reference/javascript/auth-admin-listusers
// - Storage: https://supabase.com/docs/reference/javascript/storage-createbucket
// - Vercel deployments: https://vercel.com/docs/rest-api/reference/endpoints/deployments/list-deployments

export const MANAGEMENT_TOKEN = "sbp_fixture_management_token_0123456789"
export const SERVICE_KEY = "sb_secret_fixture_service_key_0123456789"
export const ANON_KEY = "sb_publishable_fixture_key"

export type FakeCall = {
  method: string
  host: string
  path: string
  query: Record<string, string>
  body?: unknown
  files?: { field: string; name: string; size: number }[]
  authorization?: string
  apikey?: string
}

type SqlReply = unknown[] | { error: string; status?: number }

export type FakeState = {
  organizations: { id: string; name: string; plan?: string }[]
  projects: { ref: string; name: string; organization_id: string; region: string; status: string }[]
  auth: Record<string, unknown>
  users: Record<string, unknown>[]
  buckets: Record<string, unknown>[]
  bucketFiles: Record<string, number>
  functions: Record<string, unknown>[]
  secrets: { name: string; value: string; updated_at?: string }[]
  password?: string
  logs: { timestamp: number; event_message: string; source: string }[]
  lints: Record<string, unknown>[]
  pooler: Record<string, unknown>[]
  vercelDeployments: { url: string }[]
  vercelEnv: unknown[]
  sql: (query: string, readOnly: boolean) => SqlReply
  fail?: (call: FakeCall) => Response | undefined
}

export async function startSupabaseFake(overrides: Partial<FakeState> = {}) {
  const calls: FakeCall[] = []
  const state: FakeState = {
    organizations: [{ id: "org-solo", name: "Solo", plan: "free" }],
    projects: [
      {
        ref: "fixtureref",
        name: "shop-db",
        organization_id: "org-solo",
        region: "us-east-1",
        status: "ACTIVE_HEALTHY",
      },
    ],
    auth: {
      site_url: "http://localhost:3000",
      uri_allow_list: "http://localhost:3000/**",
      external_email_enabled: true,
      disable_signup: false,
      external_google_enabled: false,
      external_github_enabled: false,
      external_apple_enabled: false,
    },
    users: [],
    buckets: [],
    bucketFiles: {},
    functions: [],
    secrets: [{ name: "SUPABASE_URL", value: "digest" }],
    logs: [],
    lints: [],
    pooler: [
      {
        identifier: "fixtureref",
        database_type: "PRIMARY",
        db_user: "postgres.fixtureref",
        db_host: "aws-0-us-east-1.pooler.supabase.com",
        db_port: 6543,
        db_name: "postgres",
        pool_mode: "transaction",
      },
    ],
    vercelDeployments: [],
    vercelEnv: [],
    sql: () => [],
    ...overrides,
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const host = request.headers.get("x-original-host") ?? ""
      const contentType = request.headers.get("content-type") ?? ""
      const call: FakeCall = {
        method: request.method,
        host,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        authorization: request.headers.get("authorization") ?? undefined,
        apikey: request.headers.get("apikey") ?? undefined,
      }
      if (contentType.startsWith("multipart/form-data")) {
        const form = await request.formData()
        call.body = JSON.parse(String(form.get("metadata")))
        call.files = form
          .getAll("file")
          .filter((item): item is File => typeof item !== "string")
          .map((file) => ({ field: "file", name: file.name, size: file.size }))
      } else {
        const text = await request.text()
        call.body = text ? JSON.parse(text) : undefined
      }
      calls.push(call)
      const failure = state.fail?.(call)
      if (failure) return failure
      if (host === "api.supabase.com") return management(call)
      if (host === "api.vercel.com") return vercel(call)
      if (host.endsWith(".supabase.co")) return service(call)
      return Response.json({ message: `unexpected host ${host}` }, { status: 500 })
    },
  })

  function management(call: FakeCall) {
    if (call.authorization !== `Bearer ${MANAGEMENT_TOKEN}`) {
      return Response.json({ message: "Unauthorized" }, { status: 401 })
    }
    const path = call.path.replace(/^\/v1/, "")
    if (path === "/organizations") return Response.json(state.organizations)
    if (path === "/projects" && call.method === "GET") return Response.json(state.projects)
    // https://supabase.com/docs/reference/api/v1-create-a-project
    if (path === "/projects" && call.method === "POST") {
      const body = call.body as Record<string, unknown>
      const created = {
        ref: "newprojectref01",
        name: String(body.name),
        organization_id: String(body.organization_id),
        region: String(body.region),
        status: "ACTIVE_HEALTHY",
      }
      state.password = String(body.db_pass)
      state.projects.push(created)
      return Response.json({ ...created, id: created.ref, status: "COMING_UP" }, { status: 201 })
    }
    const match = path.match(/^\/projects\/([^/]+)(\/.*)?$/)
    const project = state.projects.find((item) => item.ref === match?.[1])
    if (!match || !project) return Response.json({ message: "Project not found" }, { status: 404 })
    const rest = match[2] ?? ""
    const body = call.body as Record<string, unknown> | undefined
    if (rest === "" && call.method === "GET") return Response.json({ ...project, id: project.ref })
    // https://supabase.com/docs/reference/api/v1-get-project-api-keys
    if (rest === "/api-keys") {
      const reveal = call.query.reveal === "true"
      return Response.json([
        { name: "anon", type: "legacy", api_key: "eyJhbGciOiJIUzI1NiJ9.anon.fixture" },
        { name: "default", type: "publishable", api_key: ANON_KEY },
        { name: "default", type: "secret", api_key: reveal ? SERVICE_KEY : "sb_secret_fixt••••••••" },
      ])
    }
    if (rest === "/pause" && call.method === "POST") {
      project.status = "PAUSING"
      return new Response(null, { status: 200 })
    }
    if (rest === "/restore" && call.method === "POST") {
      project.status = "RESTORING"
      return new Response(null, { status: 200 })
    }
    // https://supabase.com/docs/reference/api/v1-update-database-password
    if (rest === "/database/password" && call.method === "PATCH") {
      state.password = String(body?.password)
      return Response.json({ message: "ok" })
    }
    // https://supabase.com/docs/reference/api/v1-get-pooler-config
    if (rest === "/config/database/pooler") return Response.json(state.pooler)
    // https://supabase.com/docs/reference/api/v1-run-a-query
    if (rest === "/database/query" && call.method === "POST") {
      const reply = state.sql(String(body?.query), body?.read_only === true)
      if (Array.isArray(reply)) return Response.json(reply, { status: 201 })
      return Response.json({ message: reply.error }, { status: reply.status ?? 400 })
    }
    // https://supabase.com/docs/reference/api/v1-get-auth-service-config
    if (rest === "/config/auth" && call.method === "GET") return Response.json(state.auth)
    if (rest === "/config/auth" && call.method === "PATCH") {
      state.auth = { ...state.auth, ...body }
      return Response.json(state.auth)
    }
    // https://supabase.com/docs/reference/api/v1-list-all-functions
    if (rest === "/functions" && call.method === "GET") return Response.json(state.functions)
    // https://supabase.com/docs/reference/api/v1-deploy-a-function
    if (rest === "/functions/deploy" && call.method === "POST") {
      const slug = call.query.slug
      const existing = state.functions.find((item) => item.slug === slug)
      const version = existing ? Number(existing.version) + 1 : 1
      const deployed = {
        id: `fn-${slug}`,
        slug,
        name: slug,
        status: "ACTIVE",
        version,
        created_at: 1_760_000_000_000,
        updated_at: 1_760_000_000_000,
        verify_jwt: (body as Record<string, unknown>).verify_jwt,
        entrypoint_path: (body as Record<string, unknown>).entrypoint_path,
      }
      state.functions = [...state.functions.filter((item) => item.slug !== slug), deployed]
      return Response.json(deployed, { status: 201 })
    }
    const fn = rest.match(/^\/functions\/([^/]+)$/)
    if (fn && call.method === "DELETE") {
      if (!state.functions.some((item) => item.slug === fn[1])) {
        return Response.json({ message: "Function not found" }, { status: 404 })
      }
      state.functions = state.functions.filter((item) => item.slug !== fn[1])
      return Response.json({})
    }
    // https://supabase.com/docs/reference/api/v1-list-all-secrets
    if (rest === "/secrets" && call.method === "GET") return Response.json(state.secrets)
    if (rest === "/secrets" && call.method === "POST") {
      const added = (body as unknown as { name: string; value: string }[]) ?? []
      state.secrets = [...state.secrets.filter((item) => !added.some((next) => next.name === item.name)), ...added]
      return Response.json({}, { status: 201 })
    }
    if (rest === "/secrets" && call.method === "DELETE") {
      const names = (call.body as string[]) ?? []
      state.secrets = state.secrets.filter((item) => !names.includes(item.name))
      return Response.json({})
    }
    // https://supabase.com/docs/reference/api/v1-get-project-logs: ClickHouse SQL
    // over one `logs` table whose `source` column names the service
    // (https://supabase.com/docs/guides/observability/advanced-log-filtering).
    // A query error comes back as `error` beside an empty result.
    if (rest === "/analytics/endpoints/logs") {
      const sources = call.query.sql?.match(/\bwhere source in \(([^)]*)\)/)?.[1]
      if (!sources) return Response.json({ result: [], error: { message: "Unknown identifier in the logs query." } })
      const wanted = sources.split(",").map((item) => item.trim().replace(/^'|'$/g, ""))
      return Response.json({
        result: state.logs
          .filter((item) => wanted.includes(item.source))
          .map((item) => ({ timestamp: item.timestamp, event_message: item.event_message })),
      })
    }
    // https://supabase.com/docs/reference/api/v1-get-security-advisors
    if (rest === "/advisors/security") return Response.json({ lints: state.lints })
    if (rest === "/storage/buckets") return Response.json(state.buckets)
    return Response.json({ message: `unexpected ${call.method} ${call.path}` }, { status: 404 })
  }

  function service(call: FakeCall) {
    if (call.apikey !== SERVICE_KEY) return Response.json({ message: "Invalid API key" }, { status: 401 })
    // A secret key is not a JWT and must not be sent as a bearer token.
    if (call.authorization) return Response.json({ message: "Invalid JWT" }, { status: 401 })
    const body = call.body as Record<string, unknown> | undefined
    if (call.path === "/auth/v1/admin/users" && call.method === "GET") {
      const page = Number(call.query.page ?? 1)
      const perPage = Number(call.query.per_page ?? 50)
      return Response.json({ users: state.users.slice((page - 1) * perPage, page * perPage), aud: "authenticated" })
    }
    if (call.path === "/auth/v1/invite" && call.method === "POST") {
      const user = { id: crypto.randomUUID(), email: body?.email, created_at: "2026-10-10T00:00:00Z" }
      state.users.push(user)
      return Response.json(user)
    }
    const user = call.path.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/)
    if (user && call.method === "DELETE") {
      if (!state.users.some((item) => item.id === user[1])) {
        return Response.json({ msg: "User not found" }, { status: 404 })
      }
      state.users = state.users.filter((item) => item.id !== user[1])
      return Response.json({})
    }
    if (call.path === "/storage/v1/bucket" && call.method === "GET") return Response.json(state.buckets)
    if (call.path === "/storage/v1/bucket" && call.method === "POST") {
      if (state.buckets.some((item) => item.id === body?.id)) {
        return Response.json(
          { statusCode: "409", error: "Duplicate", message: "The resource already exists" },
          { status: 409 },
        )
      }
      state.buckets.push({ ...body, created_at: "2026-10-10T00:00:00Z", updated_at: "2026-10-10T00:00:00Z" })
      return Response.json({ name: body?.name })
    }
    const bucket = call.path.match(/^\/storage\/v1\/bucket\/([^/]+)(\/empty)?$/)
    const found = state.buckets.find((item) => item.id === bucket?.[1])
    if (bucket && !found)
      return Response.json(
        { statusCode: "404", error: "Bucket not found", message: "Bucket not found" },
        { status: 404 },
      )
    if (bucket && found && bucket[2] && call.method === "POST") {
      state.bucketFiles[String(found.id)] = 0
      return Response.json({ message: "Successfully emptied" })
    }
    if (bucket && found && call.method === "GET") return Response.json(found)
    if (bucket && found && call.method === "PUT") {
      Object.assign(found, body)
      return Response.json({ message: "Successfully updated" })
    }
    if (bucket && found && call.method === "DELETE") {
      if (state.bucketFiles[String(found.id)]) {
        return Response.json(
          { statusCode: "409", error: "Bucket not empty", message: "The bucket you tried to delete is not empty" },
          { status: 409 },
        )
      }
      state.buckets = state.buckets.filter((item) => item !== found)
      return Response.json({ message: "Successfully deleted" })
    }
    return Response.json({ message: `unexpected ${call.method} ${call.path}` }, { status: 404 })
  }

  function vercel(call: FakeCall) {
    if (call.path === "/v6/deployments") return Response.json({ deployments: state.vercelDeployments })
    if (/^\/v10\/projects\/[^/]+\/env$/.test(call.path) && call.method === "POST") {
      state.vercelEnv = (call.body as unknown[]) ?? []
      return Response.json({ created: state.vercelEnv, failed: [] }, { status: 201 })
    }
    return Response.json({ error: { message: `unexpected ${call.method} ${call.path}` } }, { status: 404 })
  }

  // Sends what Vector would send to the real host to this server instead.
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(init?.headers)
    headers.set("x-original-host", target.hostname)
    return fetch(`${server.url.origin}${target.pathname}${target.search}`, { ...init, headers })
  }

  return {
    state,
    calls,
    request,
    stop: () => server.stop(true),
  }
}
