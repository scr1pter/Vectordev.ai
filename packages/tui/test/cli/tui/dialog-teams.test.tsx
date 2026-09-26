/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
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
import { DialogTeams } from "../../../src/component/dialog-teams"

test.each([false, true])(
  "Teams picker uses verified account and preserves Personal recovery when list fails=%s",
  async (failedList) => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "state"), { recursive: true })
    await Bun.write(path.join(tmp.path, "state/kv.json"), "{}")
    const accountID = "11111111-1111-4111-8111-111111111111"
    const orgID = "22222222-2222-4222-8222-222222222222"
    const writes: unknown[] = []
    let reject = true
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "GET")
          return failedList
            ? Response.json(
                { name: "TeamsError", data: { code: "storage", message: "Invalid signed configuration" } },
                { status: 400 },
              )
            : Response.json({
                enabled: true,
                orgs: [
                  {
                    accountID,
                    accountEmail: "fixture@example.invalid",
                    accountUrl: "https://vectordev.ai",
                    orgID,
                    orgName: "Fixture team",
                    active: true,
                  },
                ],
              })
        writes.push(await request.json())
        return reject
          ? Response.json(
              { name: "TeamsError", data: { code: "unavailable", message: "Synthetic unavailable" } },
              { status: 400 },
            )
          : Response.json(true)
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
                        <DialogTeams />
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
    const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: 100, height: 35 })
    const frame = async (text: string) => {
      const deadline = Date.now() + 4000
      for (;;) {
        await app.renderOnce()
        if (app.captureCharFrame().includes(text)) return
        if (Date.now() > deadline) throw new Error(`Frame missing ${text}: ${app.captureCharFrame()}`)
        await Bun.sleep(10)
      }
    }
    try {
      await frame(failedList ? "could not refresh" : "integration defaults")
      expect(writes).toEqual([])
      expect(app.captureCharFrame()).toContain("Personal workspace")
      app.mockInput.pressEnter()
      await frame("could not confirm")
      expect(writes).toEqual([failedList ? { orgID: null } : { orgID, accountID }])
      expect(app.captureCharFrame()).not.toContain("configuration is reloading")
      reject = false
      app.mockInput.pressEnter()
      await frame(failedList ? "Personal workspace selected" : "Active team: Fixture team")
      expect(writes).toHaveLength(2)
    } finally {
      app.renderer.destroy()
      server.stop(true)
    }
  },
)
