/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { SDKProvider } from "../../../src/context/sdk"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { ToastProvider } from "../../../src/ui/toast"
import { DialogProvider } from "../../../src/ui/dialog"
import { VectorKeymapProvider, registerVectorKeymap } from "../../../src/keymap"
import { DialogShareSession } from "../../../src/component/dialog-share-session"

test.each([
  [120, 50],
  [80, 24],
])("terminal consent uses the real SDK body and preserves retry at %i×%i", async (width, height) => {
  await using tmp = await tmpdir()
  await mkdir(path.join(tmp.path, "state"), { recursive: true })
  await Bun.write(path.join(tmp.path, "state/kv.json"), "{}")
  const id = "a".repeat(32)
  const info = {
    id,
    url: `https://vectordev.ai/s/${id}`,
    expiresAt: Date.now() + 86_400_000,
    updatedAt: Date.now(),
    revision: 1,
    updates: false,
  }
  const archive = {
    version: 1,
    engine: "v2",
    title: "Terminal preview",
    messages: [{ id: "message", role: "user", createdAt: 1, parts: [{ type: "text", text: "Full visible history" }] }],
  }
  const writes: { method: string; body?: unknown }[] = []
  let failRemoval = true
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      if (new URL(request.url).pathname.endsWith("/share/preview")) return Response.json(archive)
      if (request.method === "GET") return Response.json({})
      writes.push({ method: request.method, body: request.method === "POST" ? await request.json() : undefined })
      if (request.method === "POST") return Response.json(info)
      return failRemoval
        ? Response.json(
            { _tag: "PublicSessionError", code: "UNAVAILABLE", message: "Service unavailable" },
            { status: 503 },
          )
        : Response.json({})
    },
  })
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerVectorKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts
        directory={tmp.path}
        paths={{ home: tmp.path, state: path.join(tmp.path, "state"), worktree: tmp.path }}
      >
        <VectorKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <SDKProvider url={server.url.origin} events={{ subscribe: async () => () => undefined }}>
                      <DialogShareSession sessionID="session-fixture" />
                    </SDKProvider>
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </VectorKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(() => <Harness />, { kittyKeyboard: true, width, height })
  const frame = async (text: string) => {
    const start = Date.now()
    while (Date.now() - start < 4000) {
      await app.renderOnce()
      if (app.captureCharFrame().includes(text)) return
      await Bun.sleep(10)
    }
    throw new Error(`Frame missing ${text}: ${app.captureCharFrame()}`)
  }
  const tabs = (count: number) => {
    for (let index = 0; index < count; index++) app.mockInput.pressTab()
  }
  try {
    await frame("(1 messages)")
    app.mockInput.pressEnter()
    await frame("Full visible history")
    expect(writes).toEqual([])
    app.mockInput.pressEnter()
    await app.renderOnce()
    tabs(4)
    app.mockInput.pressEnter()
    await frame("[ ] Also consent")
    expect(app.captureCharFrame()).not.toContain("[x] Also consent")
    app.mockInput.pressArrow("up")
    app.mockInput.pressEnter()
    await frame("[x] Include future")
    tabs(1)
    app.mockInput.pressEnter()
    await frame("[x] Also consent")
    app.mockInput.pressArrow("up")
    app.mockInput.pressEnter()
    await frame("[ ] Include future")
    tabs(1)
    await frame("[ ] Also consent")
    app.mockInput.pressEnter()
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("[x] Also consent")
    tabs(2)
    app.mockInput.pressEnter()
    expect(writes).toEqual([])
    app.mockInput.pressArrow("up")
    app.mockInput.pressEnter()
    tabs(1)
    app.mockInput.pressEnter()
    await frame("Public copy created.")
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      method: "POST",
      body: {
        consent: { version: 1, public: true, updates: false },
        remember: false,
        previewHash: createHash("sha256").update(JSON.stringify(archive)).digest("hex"),
      },
    })
    tabs(4)
    app.mockInput.pressEnter()
    expect(writes).toHaveLength(1)
    app.mockInput.pressArrow("up")
    app.mockInput.pressEnter()
    tabs(1)
    app.mockInput.pressEnter()
    await frame("Public link retained for retry.")
    expect(app.captureCharFrame()).toContain(info.url)
    failRemoval = false
    app.mockInput.pressEnter()
    await frame("Public copy removed.")
    expect(writes.map((item) => item.method)).toEqual(["POST", "DELETE", "DELETE"])
  } finally {
    app.renderer.destroy()
    server.stop(true)
  }
})
