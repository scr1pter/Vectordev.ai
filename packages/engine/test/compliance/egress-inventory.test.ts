import { describe, expect, test } from "bun:test"
import path from "node:path"
import { LocalSources } from "@vectordevai/core/local-mode/sources"

// Vector Local's inventory of connections (plan section 4.5), as a lint over the engine's, core's and the llm package's
// source: every file that makes a connection of its own (a global fetch, a WebSocket, an http or https request, a raw
// socket, or Effect's HTTP client) is a call site the source registry lists, or is listed below with why it needs no
// source of its own. A new connection is added to the registry first. Dependency code (npm's installer, the embedding
// model's downloader) is covered by the backstop guard, not by this lint. The end-to-end check that nothing else
// connects is the strict-guard run in test/local-mode/local-run.test.ts.

const ROOT = path.resolve(import.meta.dir, "../../../..")

// What makes a connection, read with comments taken out. A function or method named fetch, whose first parameter has a
// type, is a declaration, not a call.
const PRIMITIVES: readonly RegExp[] = [
  /(?<![\w.$])(?<!function\s+)fetch\((?!\s*\w+\??\s*:)/,
  /globalThis\.fetch\(/,
  /new WebSocket\(/,
  /\bhttps?\.(?:request|get)\(/,
  /\bnet\.(?:connect|createConnection)\(/,
  /\btls\.connect\(/,
  /Bun\.connect\(/,
  /HttpClient\.HttpClient\b/,
]

// Files that connect, or hold the HTTP client, but make no request a source would name.
const WITHOUT_SOURCE: Readonly<Record<string, string>> = {
  "packages/core/src/plugin/internal.ts": "Hands plugins the HTTP client; it sends nothing itself.",
  "packages/engine/src/util/effect-http-client.ts": "Retry helpers for the HTTP client; it sends nothing itself.",
  "packages/engine/src/server/shared/ui.ts": "Takes the HTTP client but serves the embedded web UI from disk.",
  "packages/engine/src/server/routes/instance/httpapi/server.ts": "Provides the HTTP client to the server's routes.",
  "packages/core/src/local-mode/egress.ts": "Vector Local's own send: every labelled request goes out here.",
  "packages/core/src/local-mode/http-client.ts": "Vector Local's labelled HTTP client, which sends through Egress.",
  "packages/core/src/util/webfetch-request.ts":
    "The pinned fetch webfetch, remote skills and instruction URLs send through; each caller labels its requests.",
  "packages/core/src/oauth/page.ts": "A sign-in page's script, which runs in the browser that opened the page.",
  "packages/engine/src/tool/vector-cloud.ts":
    "The desktop app's bridge on this computer; the desktop makes Vector Cloud's requests (vector-cloud).",
  "packages/engine/src/control-plane/dev/debug-workspace-plugin.ts": "A development-only workspace plugin.",
  // Not labelled yet: the backstop guard decides these as unlabelled, so with Vector Local on they reach only this
  // computer and the model servers on the list.
  "packages/engine/src/control-plane/workspace.ts": "Experimental remote workspaces, decided by the backstop guard.",
  "packages/engine/src/server/routes/instance/httpapi/middleware/proxy.ts":
    "Experimental remote workspaces' proxy, decided by the backstop guard.",
  "packages/engine/src/server/routes/instance/httpapi/middleware/workspace-routing.ts":
    "Experimental remote workspaces' routing, decided by the backstop guard.",
}

// Call sites of the registry that consult Vector Local through another file, and how. Every other call site of an
// engine source consults it itself.
const DECIDED_ELSEWHERE: Readonly<Record<string, string>> = {
  "packages/llm/src/route/executor.ts":
    "Sends through the HTTP client LayerNodePlatform.requestExecutor gives it, which decides each request as a model call (EgressHttpClient.models).",
  "packages/core/src/plugin/provider/google-vertex.ts":
    "A V2 route's model calls are refused before the route is built (SessionRunnerModel.allowedInLocal); a V1 call goes through provider.ts's fetch first.",
  "packages/core/src/npm.ts":
    "Installs what its callers decided: plugin/index.ts and provider.ts (npm-plugins), and lsp/server.ts, which installs nothing under Vector Local (lsp-install).",
  "packages/engine/src/tool/mcp-websearch.ts":
    "Sends with the client tool/websearch.ts labels with the provider's source.",
  "packages/engine/src/git/index.ts":
    "Decides each git command that connects with Git.refusal (core git.ts) before git starts: the review's and the GitHub handler's fetches and pushes.",
  "packages/engine/src/review/source.ts":
    "Fetches a review's commits through Git.run (git/index.ts), which decides each fetch.",
  "packages/engine/src/worktree/index.ts":
    "Decides each git command that connects with Git.refusal (core git.ts) before git starts: a reset's fetch, a submodule update.",
}

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1")

async function sources() {
  const files = await Array.fromAsync(new Bun.Glob("packages/{core,engine,llm}/src/**/*.{ts,tsx}").scan({ cwd: ROOT }))
  return Promise.all(
    files
      .filter((file) => !/\.test\.tsx?$/.test(file))
      .toSorted()
      .map(async (file) => ({ file, text: strip(await Bun.file(path.join(ROOT, file)).text()) })),
  )
}

describe("Vector Local's connection inventory", () => {
  test("every file that connects is a call site in the source registry or says why it needs none", async () => {
    const listed = new Set(LocalSources.SOURCES.flatMap((source) => [...source.callSites, ...(source.planned ?? [])]))
    const connecting = (await sources())
      .filter((item) => PRIMITIVES.some((primitive) => primitive.test(item.text)))
      .map((item) => item.file)
    // The scan sees the call sites it should, so an empty result means something.
    expect(connecting).toEqual(
      expect.arrayContaining(["packages/engine/src/provider/provider.ts", "packages/core/src/model-catalog.ts"]),
    )
    expect(connecting.filter((file) => !listed.has(file) && !Object.hasOwn(WITHOUT_SOURCE, file))).toEqual([])
  })

  test("the files it excuses still exist and still connect", async () => {
    const all = new Map((await sources()).map((item) => [item.file, item.text]))
    const stale = Object.keys(WITHOUT_SOURCE).filter((file) => {
      const text = all.get(file)
      return text === undefined || !PRIMITIVES.some((primitive) => primitive.test(text))
    })
    expect(stale).toEqual([])
  })

  test("every call site of an engine source consults Vector Local, or says which file does", async () => {
    const all = new Map((await sources()).map((item) => [item.file, item.text]))
    // webAccess (tool/webfetch.ts) is how the browser tool decides a page, and githubFetch (cli/cmd/github.shared.ts)
    // how Vector's own GitHub requests are labelled.
    const gated = (file: string) => /local-mode\/|LocalPolicy|Egress|webAccess\(|githubFetch/.test(all.get(file) ?? "")
    const sites = LocalSources.SOURCES.filter((source) => source.where.includes("engine")).flatMap((source) =>
      source.callSites.filter((file) => all.has(file)).map((file) => ({ source: source.id, file })),
    )
    expect(sites.length).toBeGreaterThan(20)
    expect(sites.filter((site) => !gated(site.file) && !Object.hasOwn(DECIDED_ELSEWHERE, site.file))).toEqual([])
    // An excuse names a call site that still exists and has not gained a gate of its own.
    const stale = Object.keys(DECIDED_ELSEWHERE).filter(
      (file) => !sites.some((site) => site.file === file) || gated(file),
    )
    expect(stale).toEqual([])
  })
})
