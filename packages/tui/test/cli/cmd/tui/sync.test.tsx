/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import { useConnected } from "../../../../src/component/use-connected"
import type { GlobalEvent } from "@vectordevai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("bootstrap hydrates provider and configuration data without hosted console requests", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const requests: string[] = []
    const provider = {
      id: "custom-gateway",
      name: "Custom gateway",
      source: "config" as const,
      env: [],
      options: {},
      models: {},
    }
    const agent = { name: "build", mode: "primary" as const, options: {}, permission: [] }
    const { app, sync } = await mount((url) => {
      requests.push(url.pathname)
      if (url.pathname === "/provider") return json({ all: [provider], connected: [provider.id], default: {} })
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: {} })
      if (url.pathname === "/provider/auth") return json({ [provider.id]: [{ type: "api", label: "API key" }] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === "/config") return json({ model: "custom-gateway/model" })
      if (url.pathname === "/experimental/capabilities") return json({ backgroundSubagents: true })
    }, tmp.path)
    try {
      expect(sync.data.provider_next.connected).toEqual([provider.id])
      expect(sync.data.provider).toEqual([provider])
      expect(sync.data.provider_auth[provider.id]).toEqual([{ type: "api", label: "API key" }])
      expect(sync.data.agent).toEqual([agent])
      expect(sync.data.config.model).toBe("custom-gateway/model")
      expect(sync.data.capabilities.experimentalBackgroundSubagents).toBe(true)
      expect(requests.some((request) => request.startsWith("/experimental/console"))).toBe(false)
      expect("console_state" in sync.data).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })

  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })
})

test.each([
  { providers: [], expected: false },
  { providers: ["unlisted-service"], expected: false },
  { providers: ["unlisted-service", "anthropic"], expected: true },
])("connected state follows supported providers: $providers", async ({ providers, expected }) => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let connected!: ReturnType<typeof useConnected>
  const { app } = await mount(
    (url) =>
      url.pathname === "/config/providers"
        ? json({ providers: providers.map((id) => ({ id, name: id, models: {} })), default: {} })
        : undefined,
    tmp.path,
    () => {
      connected = useConnected()
    },
  )
  try {
    expect(connected()).toBe(expected)
  } finally {
    app.renderer.destroy()
  }
})
