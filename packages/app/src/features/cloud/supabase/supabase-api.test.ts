import { describe, expect, test } from "bun:test"
import { supabaseClient, type SupabaseBridge, type SupabaseProgress } from "./supabase-api"

// A stand-in for window.api.cloud.supabase that records what the console sends.
function recordingBridge(reply: (command: string) => Record<string, unknown> | Error = () => ({ ok: true })) {
  const sent: { command: string; input: Record<string, unknown> }[] = []
  const listeners: ((event: SupabaseProgress) => void)[] = []
  const bridge: SupabaseBridge = {
    run: async (command, input) => {
      sent.push({ command, input })
      const answer = reply(command)
      if (answer instanceof Error) throw answer
      return { ok: true, ...answer }
    },
    subscribe: (cb) => {
      listeners.push(cb)
      return () => listeners.splice(listeners.indexOf(cb), 1)
    },
  }
  return { bridge, sent, listeners }
}

describe("Supabase console client", () => {
  test("sends each control as the shared command, in the open project's scope", async () => {
    const { bridge, sent } = recordingBridge()
    const client = supabaseClient(() => ({ projectPath: "/work/shop", taskId: "task-1" }), () => bridge)
    await client.link("fixtureref")
    await client.runSql("delete from sessions", true)
    await client.updateAuth({ addRedirectUrls: ["https://shop.example.com/**"] })
    await client.createBucket({ bucket: "avatars", public: false })
    await client.deleteBucket("avatars", true)
    await client.deployFunction("hello")
    await client.setSecret("RESEND_KEY", "fixture-value")
    await client.logs({ service: "auth", minutes: 60 })
    await client.writeDatabaseUrl()
    await client.rotatePassword({ writeDatabaseUrl: true, syncVercel: false })
    expect(sent).toEqual([
      { command: "link_database", input: { projectPath: "/work/shop", taskId: "task-1", projectRef: "fixtureref" } },
      { command: "run_sql", input: { projectPath: "/work/shop", taskId: "task-1", sql: "delete from sessions", write: true } },
      {
        command: "update_auth",
        input: { projectPath: "/work/shop", taskId: "task-1", addRedirectUrls: ["https://shop.example.com/**"] },
      },
      { command: "create_bucket", input: { projectPath: "/work/shop", taskId: "task-1", bucket: "avatars", public: false } },
      { command: "delete_bucket", input: { projectPath: "/work/shop", taskId: "task-1", bucket: "avatars", empty: true } },
      { command: "deploy_function", input: { projectPath: "/work/shop", taskId: "task-1", functionName: "hello" } },
      {
        command: "set_function_secrets",
        input: { projectPath: "/work/shop", taskId: "task-1", secrets: [{ name: "RESEND_KEY", value: "fixture-value" }] },
      },
      { command: "supabase_logs", input: { projectPath: "/work/shop", taskId: "task-1", service: "auth", minutes: 60 } },
      // The console only sends this after its own confirmation.
      { command: "write_database_url", input: { projectPath: "/work/shop", taskId: "task-1", consent: true } },
      {
        command: "rotate_database_password",
        input: { projectPath: "/work/shop", taskId: "task-1", writeDatabaseUrl: true, syncVercel: false },
      },
    ])
  })

  test("turns a failed IPC call into a report, and works without the desktop bridge", async () => {
    const { bridge } = recordingBridge(() => new Error("Error invoking remote method"))
    const client = supabaseClient(() => ({ projectPath: "/work/shop" }), () => bridge)
    expect(await client.projects()).toEqual({ ok: false, error: "Error invoking remote method" })
    const offline = supabaseClient(() => ({ projectPath: "/work/shop" }), () => undefined)
    expect(await offline.auth()).toEqual({ ok: false, error: "Supabase controls run in the Vector desktop app." })
    expect(offline.subscribe(() => undefined)).toBeFunction()
  })

  test("relays creation progress and stops when unsubscribed", () => {
    const { bridge, listeners } = recordingBridge()
    const client = supabaseClient(() => ({ projectPath: "/work/shop" }), () => bridge)
    const seen: string[] = []
    const stop = client.subscribe((event) => seen.push(event.stage))
    listeners.forEach((listener) => listener({ stage: "creating", message: "Creating shop", projectPath: "/work/shop" }))
    stop()
    expect(listeners).toEqual([])
    expect(seen).toEqual(["creating"])
  })
})
