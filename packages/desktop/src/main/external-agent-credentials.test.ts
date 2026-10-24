import { describe, expect, test } from "bun:test"
import { join, relative } from "node:path"
import { ExternalAgent } from "@vectordevai/schema/external-agent"

// Vector runs the user's own agent CLIs and must never read, copy or pass what
// they sign in with. This guard scans every source file on the paths that
// detect, set up, launch and show those agents: desktop's main process and
// preload, the app, and the shared schema. None of them may name an agent's
// credential store or reach for the keychain. A real need for one of these
// locations is a design change to discuss, not a pattern to loosen.
const PACKAGES = join(import.meta.dir, "../../..")
const ROOTS = ["desktop/src", "app/src", "schema/src"].map((root) => join(PACKAGES, root))

// A path written either way code builds one: "a/b" in a string, or join("a", "b").
const SEPARATOR = "(?:[/\\\\]|[\"'`]\\s*,\\s*[\"'`])"
const location = (...segments: string[]) => new RegExp(segments.join(SEPARATOR), "i")
// gh holds the GitHub token Copilot CLI can sign in with.
const AGENT_DIRECTORIES =
  "(?:cline|kilo|goose|github-copilot|copilot|gh|amp|droid|factory|gemini|qwen|kimi|junie|muse|cursor)\\b"
// A dot folder named on its own, as a path segment: after a quote or a separator, so an i18n key such as
// "session.header.open.app.antigravity" is not one.
const dotFolder = (name: string) => new RegExp(`(?<=["'\`/\\\\])\\.${name}(?=["'\`/\\\\])`, "i")

const CREDENTIAL_LOCATIONS: [string, RegExp][] = [
  ["~/.claude and ~/.claude.json", /\.claude(?:\.json)?(?=["'`/\\])/],
  ["~/.codex", /\.codex(?=["'`/\\])/],
  ["auth.json files", /auth\.json/i],
  ["~/.gemini", /\.gemini(?=["'`/\\])/],
  ["~/.qwen", /\.qwen(?=["'`/\\])/],
  ["~/.kimi", /\.kimi(?=["'`/\\])/],
  ["~/.factory", /\.factory(?=["'`/\\])/],
  ["~/.copilot", /\.copilot(?=["'`/\\])/],
  ["~/.junie", /\.junie(?=["'`/\\])/],
  ["~/.muse", /\.muse(?=["'`/\\])/],
  ["~/.pi/agent", location("\\.pi", "agent")],
  ["~/.cline", dotFolder("cline")],
  ["~/.kilocode", dotFolder("kilocode")],
  ["~/.antigravity", dotFolder("antigravity")],
  // Cursor's bin folder is where its CLI lives; anything else under ~/.cursor is its configuration.
  ["Cursor's CLI config", location("\\.cursor", "(?!bin\\b)[\\w.-]+")],
  ["~/.config/<agent>", location("\\.config", AGENT_DIRECTORIES)],
  ["~/.local/share/<agent>", location("\\.local", "share", "(?:kilo|amp|goose|cline|droid)\\b")],
  ["the keychain", /find-(?:generic|internet)-password|\bkeytar\b|SecKeychain|Claude Code-credentials/i],
]

async function sources() {
  const files = await Promise.all(
    ROOTS.map(async (root) =>
      [...new Bun.Glob("**/*.{ts,tsx}").scanSync(root)]
        .filter((file) => !/\.test\.tsx?$/.test(file) && !file.includes("node_modules"))
        .map((file) => join(root, file)),
    ),
  )
  return Promise.all(
    files.flat().map(async (path) => ({ path: relative(PACKAGES, path), text: await Bun.file(path).text() })),
  )
}

describe("agent credentials stay out of Vector", () => {
  test("no source file on the external-agent paths names an agent's credential store or the keychain", async () => {
    const files = await sources()
    // The scan must actually see the files it guards.
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "desktop/src/main/external-agents.ts",
        "desktop/src/preload/index.ts",
        "app/src/features/agents/external-runtimes.ts",
        "schema/src/external-agent.ts",
      ]),
    )
    const hits = files.flatMap((file) =>
      CREDENTIAL_LOCATIONS.filter(([, pattern]) => pattern.test(file.text)).map(([name]) => `${file.path}: ${name}`),
    )
    expect(hits).toEqual([])
  })

  test("the patterns catch the reads they exist to stop", () => {
    const caught = (text: string) => CREDENTIAL_LOCATIONS.some(([, pattern]) => pattern.test(text))
    for (const read of [
      'join(homedir(), ".claude", ".credentials.json")',
      'readFile("~/.claude.json")',
      'join(home, ".codex", "auth.json")',
      "`${home}/.gemini/oauth_creds.json`",
      'join(home, ".qwen", "settings.json")',
      'join(home, ".config", "cline")',
      'join(home, ".local", "share", "kilo")',
      'join(home, ".cursor", "cli-config.json")',
      '"~/.pi/agent/auth.json"',
      'join(home, ".cline", "data")',
      "`${home}/.kilocode/cli/config.json`",
      'join(homedir(), ".antigravity")',
      'readFile("~/.config/gh/hosts.yml")',
      'execFile("security", ["find-generic-password", "-s", "Claude Code-credentials"])',
    ])
      expect({ read, caught: caught(read) }).toEqual({ read, caught: true })
    // What Vector does touch: an agent's bin folder, and its vendor's web domains.
    for (const fine of [
      'join(home, ".cursor", "bin")',
      "https://code.claude.com/docs",
      "https://docs.claude.com",
      '"session.header.open.app.antigravity"',
      "https://docs.cline.bot/cline-cli/overview",
    ])
      expect({ fine, caught: caught(fine) }).toEqual({ fine, caught: false })
  })

  test("no catalog command takes a credential, and a status probe is never a credential dump", () => {
    for (const agent of ExternalAgent.catalog) {
      const argv = [
        ...(agent.statusProbe?.args ?? []),
        ...agent.signIn.args,
        ...(agent.models.kind === "live" ? agent.models.args : []),
      ]
      expect(argv.join(" ")).not.toMatch(/--?(?:api-?key|apikey|token|auth|credentials?|password)\b|-k\b|print-bearer/i)
    }
  })
})
