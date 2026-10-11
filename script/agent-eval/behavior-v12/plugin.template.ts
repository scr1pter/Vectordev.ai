import { join } from "node:path"
import { CodexAuthPlugin } from "__SOURCE__/packages/engine/src/plugin/openai/codex"
import { Control } from "__CONTROL__"
import { MainGate, mainShape } from "__HARNESS__/main-gate"
import { hash } from "__HARNESS__/decision-response"
import { capture } from "__HARNESS__/capture"
import { scripted } from "__HARNESS__/scripted"

export default async (input: Parameters<typeof CodexAuthPlugin>[0]) => {
  const output = process.env.EPISODE_OUTPUT!
  const mode = process.env.E12_MODE!
  const live = mode.startsWith("live-")
  const gate = new MainGate(3, 3)
  const attempts: Record<string, unknown>[] = []
  const simulation = live ? undefined : Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json()
      return new Response(scripted(body.model, mode === "rehearse" ? gate.attempts === 1
        ? [{ text: "SYNTHETIC_LEDGER_FORWARD_PROOF" }, { tool: "read", args: { filePath: join(Control.root, "src/store/key.ts") } }, { tool: "glob", args: { pattern: "src/store/*.ts" } }, { tool: "bash", args: { command: "git status --short", timeout: 120000 } }]
        : [{ tool: "apply_patch", args: { patchText: "*** Begin Patch\n*** End Patch" } }]
        : { text: "PREFLIGHT_DONE" }, gate.attempts), { headers: { "content-type": "text/event-stream" } })
    },
  })
  const hooks = await CodexAuthPlugin(input, {
    webSockets: { signIn: false, apiKey: false }, experimentalWebSockets: false,
    ...(simulation ? { codexApiEndpoint: `http://127.0.0.1:${simulation.port}/responses` } : {}),
  })
  if (!hooks.auth?.loader) throw new Error("RUNTIME_OPENAI_LOADER_MISSING")
  const loader = hooks.auth.loader
  return {
    ...hooks,
    async dispose() {
      await hooks.dispose?.()
      await simulation?.stop(true)
    },
    auth: {
      ...hooks.auth,
      methods: [],
      async loader(...args: Parameters<typeof loader>) {
        // The source runtime alone invokes its auth callback. The harness never reads
        // that callback, credential values, authorization headers or a credential store.
        const options = await loader(...args)
        if (typeof options.fetch !== "function") throw new Error("RUNTIME_OPENAI_FETCH_MISSING")
        const runtimeFetch = options.fetch
        return {
          ...options,
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            if (typeof init?.body !== "string") throw new Error("REQUEST_BODY_MISSING")
            const body = JSON.parse(init.body)
            const control = await Bun.file(join(output, "control.json")).json()
            const headers = new Headers(init.headers)
            const identity = {
              "session-id": headers.get("session-id") ?? "",
              "x-session-id": headers.get("x-session-id") ?? "",
            }
            if (!gate.active) {
              const expected = live
                ? (await Bun.file(join(process.env.E12_STUDY!, "preflight-shapes.json")).json())[control.id]
                : undefined
              gate.activate(control.id, control.sessionID, control.model, expected)
            }
            const grants = (await Bun.file(process.env.EPISODE_GRANTS_FILE!).text()).trim().split("\n").map((line) => JSON.parse(line))
            const reserved = gate.reserve(body, identity, grants, !live)
            const attempt = {
              grant: reserved.grant,
              turn: reserved.turn,
              requestSha256: hash(init.body),
              shape: mainShape(body),
              synthetic: !live,
              status: "reserved",
            }
            attempts.push(attempt)
            await Bun.write(join(output, "transport-attempts.json"), JSON.stringify(attempts, null, 2))
            await Bun.write(join(output, `request-${reserved.ordinal}.json`), init.body)
            try {
              const response = await runtimeFetch(request, { ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(120_000)]) })
              const captured = await capture(response, body.model)
              await Bun.write(join(output, `response-${reserved.ordinal}.sse`), captured.bytes)
              Object.assign(attempt, captured.evidence, {
                status: captured.evidence.success ? "recorded" : "failed",
                responseWirePath: `${control.id}/response-${reserved.ordinal}.sse`,
                responseWireSha256: hash(captured.bytes),
              })
              if (!captured.evidence.success) throw new Error("PROVIDER_CAPTURE_FAILED")
              return new Response(captured.bytes, { headers: { "content-type": "text/event-stream" } })
            } catch {
              // A transport rejection has no response to classify. Preserve the
              // reservation and explicitly unknown spend; never invent zero usage.
              if (attempt.status === "reserved") Object.assign(attempt, { status: "failed", errorCode: "RUNTIME_FETCH_OR_CAPTURE_FAILED", httpStatus: null, usageKnown: false, projectedUsage: null, responseWirePath: null, responseWireSha256: null })
              gate.fail("PROVIDER_CAPTURE_FAILED")
              throw new Error("PROVIDER_CAPTURE_FAILED")
            } finally {
              await Bun.write(join(output, "transport-attempts.json"), JSON.stringify(attempts, null, 2))
            }
          },
        }
      },
    },
    "tool.execute.before": Control.before,
    "tool.execute.after": Control.after,
    "shell.env": Control.shellEnv,
  }
}
