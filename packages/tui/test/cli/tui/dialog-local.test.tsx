/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
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
import { VectorLocalProvider, badge } from "../../../src/context/vector-local"
import { DialogLocal, summaryLines } from "../../../src/component/dialog-local"

// /local in the terminal UI against a fake engine: the switch reads the server's policy, and turning Vector Local off,
// which loosens it, is sent with `confirm` only after the owner confirms the dialog that lists what it loosens.

const policy = (enabled: boolean) => ({
  enabled,
  web: "ask",
  lock: false,
  endpoints: [],
  web_domains: { allow: [], deny: [] },
  allow: [],
  user_may: [],
  locked_keys: [],
  endpoint_domains: [],
  warnings: [],
})
const status = (enabled: boolean) => ({
  policy: policy(enabled),
  locked: [],
  log: { directory: "/tmp/vector/local", retain_days: 30 },
  agent: false,
  sources: [],
})

describe("/local", () => {
  test.each([["confirms"], ["keeps it on"]] as const)(
    "turning Vector Local off asks first; the owner %s",
    async (answer) => {
      await using tmp = await tmpdir()
      await mkdir(path.join(tmp.path, "state"), { recursive: true })
      await Bun.write(path.join(tmp.path, "state/kv.json"), "{}")
      const state = { enabled: true }
      const patches: unknown[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request): Promise<Response> {
          const url = new URL(request.url)
          if (url.pathname !== "/local") return Response.json({})
          if (request.method === "GET") return Response.json(status(state.enabled))
          const body = (await request.json()) as { enabled?: boolean; confirm?: boolean }
          patches.push(body)
          if (body.enabled === false && body.confirm !== true)
            return Response.json(
              {
                name: "LocalConfirmError",
                data: {
                  message: "This change would loosen Vector Local. Apply it?",
                  changes: ["turns Vector Local off"],
                },
              },
              { status: 409 },
            )
          state.enabled = body.enabled ?? state.enabled
          return Response.json(status(state.enabled))
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
                      <SDKProvider url={server.url.origin} events={{ subscribe: async () => () => undefined }}>
                        <VectorLocalProvider>
                          <DialogProvider>
                            <DialogLocal />
                          </DialogProvider>
                        </VectorLocalProvider>
                      </SDKProvider>
                    </ToastProvider>
                  </ThemeProvider>
                </KVProvider>
              </TuiConfigProvider>
            </VectorKeymapProvider>
          </TestTuiContexts>
        )
      }
      const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: 120, height: 40 })
      const frame = async (text: string) => {
        const start = Date.now()
        while (Date.now() - start < 4000) {
          await app.renderOnce()
          if (app.captureCharFrame().includes(text)) return
          await Bun.sleep(10)
        }
        throw new Error(`Frame missing ${text}: ${app.captureCharFrame()}`)
      }
      try {
        await frame("Turn Vector Local off")
        app.mockInput.pressEnter()
        await frame("Loosen Vector Local?")
        expect(app.captureCharFrame()).toContain("turns Vector Local off.")
        expect(patches).toEqual([{ enabled: false }])
        expect(state.enabled).toBe(true)
        if (answer === "keeps it on") {
          app.mockInput.pressArrow("left")
          app.mockInput.pressEnter()
          await frame("Turn Vector Local off")
          // Nothing was sent with confirm, so Vector Local stays on.
          expect(patches).toEqual([{ enabled: false }])
          expect(state.enabled).toBe(true)
          return
        }
        app.mockInput.pressEnter()
        await frame("Turn Vector Local on")
        expect(patches).toEqual([{ enabled: false }, { enabled: false, confirm: true }])
        expect(state.enabled).toBe(false)
      } finally {
        app.renderer.destroy()
        server.stop(true)
      }
    },
  )
})

describe("the Local badge", () => {
  test("names Web access, and who set it, only while Vector Local is on", () => {
    expect(badge(undefined)).toBeUndefined()
    expect(badge({ enabled: false, web: "none", lock: false })).toBeUndefined()
    expect(badge({ enabled: true, web: "ask", lock: false })).toBe("Local")
    expect(badge({ enabled: true, web: "network", lock: false })).toBe("Local · your network")
    expect(badge({ enabled: true, web: "none", lock: true })).toBe("Local · no web · set by your company")
  })
})

describe("What Vector sent", () => {
  test("counts model calls by origin, pages, searches, memory carried and blocks", () => {
    expect(
      summaryLines({
        model_calls: { "http://127.0.0.1:11434": 42 },
        pages: 6,
        hosts: 41,
        searches: 8,
        carried: { personal: 9, documents: 4 },
        blocked: { "model-catalog": 1, unlabelled: 1 },
        helper_requests: 3,
      }),
    ).toEqual([
      "Model calls: 42 to http://127.0.0.1:11434",
      "Web: 6 pages, 41 hosts, 8 searches",
      "Memory sent: 9 personal cards, 4 document passages",
      "Blocked: 2",
      "Including 3 helper requests",
    ])
  })
})
