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
const email = `vector-cloud-smoke-${stamp}@example.com`
const password = `Vector-Smoke-${crypto.randomUUID()}`
let userId = ""
let accessToken = ""
let runId = ""

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${accessToken}`)
  if (init.body) headers.set("content-type", "application/json")
  const response = await fetch(new URL(path, origin), {
    ...init,
    headers,
  })
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

  const createdRun = await api("/api/agents/runs", {
    method: "POST",
    body: JSON.stringify({
      name: "Production Cloud Agent smoke test",
      prompt:
        "Create a file named VECTOR_CLOUD_SMOKE.txt containing exactly VECTOR_CLOUD_OK and no other text. Then finish.",
      model: "openrouter/poolside/laguna-s-2.1:free",
    }),
  })
  runId = createdRun.run?.id
  if (!runId) throw new Error("Vector did not return a Cloud Agent run ID.")
  console.log(`Cloud Agent run created: ${runId}`)

  for (let attempt = 1; attempt <= 36; attempt++) {
    await Bun.sleep(10_000)
    const state = await api(`/api/agents/run?id=${encodeURIComponent(runId)}`)
    const run = state.run || {}
    console.log(`[${attempt}] ${run.status || "unknown"} - ${run.current_step || ""}`)
    if (!["complete", "failed", "needs_input", "canceled"].includes(run.status)) continue

    console.log(
      JSON.stringify(
        {
          status: run.status,
          step: run.current_step,
          error: run.error,
          summary: run.summary,
          diffStats: run.diff_stats,
          tokenUsage: run.token_usage,
          costUsd: run.cost_usd,
        },
        null,
        2,
      ),
    )
    if (run.status !== "complete") throw new Error(`Cloud Agent ended with status ${run.status}.`)
    if (!String(run.diff || "").includes("VECTOR_CLOUD_OK")) {
      throw new Error("Cloud Agent completed without returning the expected workspace diff.")
    }
    console.log("Cloud Agent production smoke test passed.")
    process.exitCode = 0
    break
  }
  if (process.exitCode === undefined) throw new Error("Cloud Agent did not finish within six minutes.")
} finally {
  if (runId && accessToken) {
    await api(`/api/agents/run?id=${encodeURIComponent(runId)}`, { method: "DELETE" }).catch(() => undefined)
  }
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => undefined)
}
