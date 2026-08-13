import { createClient } from "@supabase/supabase-js"

const origin = process.env.VECTOR_PUBLIC_URL || "https://vectordev.ai"
const url = process.env.SUPABASE_URL
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (process.env.VECTOR_ALLOW_PRODUCTION_SMOKE !== "1") {
  throw new Error("Set VECTOR_ALLOW_PRODUCTION_SMOKE=1 to run the disposable production smoke test.")
}
if (!url || !publishableKey || !serviceRoleKey) {
  throw new Error("Supabase production credentials are required.")
}

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})
const client = createClient(url, publishableKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
const email = `vector-builder-smoke-${stamp}@example.com`
const password = `Vector-Smoke-${crypto.randomUUID()}`
let userId = ""
let accessToken = ""
let projectId = ""
let runId = ""

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${accessToken}`)
  if (init.body) headers.set("content-type", "application/json")
  const response = await fetch(new URL(path, origin), { ...init, headers })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${path} returned ${response.status}: ${JSON.stringify(payload)}`)
  }
  return payload
}

try {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error || !created.data.user) throw created.error || new Error("The smoke user was not created.")
  userId = created.data.user.id

  const subscription = await admin.from("vector_subscriptions").insert({
    user_id: userId,
    stripe_customer_id: `cus_smoke_${stamp}`,
    stripe_subscription_id: `sub_smoke_${stamp}`,
    plan: "monthly",
    status: "active",
    current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
    cancel_at_period_end: false,
  })
  if (subscription.error) throw subscription.error

  const signedIn = await client.auth.signInWithPassword({ email, password })
  if (signedIn.error || !signedIn.data.session) throw signedIn.error || new Error("The smoke user could not sign in.")
  accessToken = signedIn.data.session.access_token

  const project = await api("/api/builder/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Builder smoke test" }),
  })
  projectId = project.project?.id
  if (!projectId) throw new Error("Vector did not return a Builder project ID.")

  const createdRun = await api("/api/builder/runs", {
    method: "POST",
    body: JSON.stringify({
      projectId,
      name: "Production Builder smoke test",
      prompt: "Create a minimal web app whose page visibly says VECTOR_BUILDER_OK, then finish.",
    }),
  })
  runId = createdRun.run?.id
  if (!runId) throw new Error("Vector did not return a Builder run ID.")
  console.log(`Builder run created: ${runId}`)

  for (let attempt = 1; attempt <= 36; attempt++) {
    await Bun.sleep(10_000)
    const state = await api(`/api/builder/run?id=${encodeURIComponent(runId)}`)
    const run = state.run || {}
    console.log(`[${attempt}] ${run.status || "unknown"} - ${run.current_step || ""}`)
    if (!["complete", "failed", "needs_input", "canceled"].includes(run.status)) continue

    if (run.status !== "complete") throw new Error(`Builder ended with status ${run.status}.`)
    if (!String(run.diff || "").includes("VECTOR_BUILDER_OK")) {
      throw new Error("Builder completed without returning the expected workspace diff.")
    }
    console.log("Builder production smoke test passed.")
    process.exitCode = 0
    break
  }
  if (process.exitCode === undefined) throw new Error("Builder did not finish within six minutes.")
} finally {
  if (runId && accessToken) {
    await api(`/api/builder/run?id=${encodeURIComponent(runId)}`, { method: "DELETE" }).catch(() => undefined)
  }
  if (projectId && accessToken) {
    await api(`/api/builder/projects?id=${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(
      () => undefined,
    )
  }
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => undefined)
}
