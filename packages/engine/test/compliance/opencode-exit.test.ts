import { describe, expect, test } from "bun:test"
import path from "node:path"
import { providerAllowed, providerEndpointAllowed } from "@vectordevai/core/provider-policy"

const root = path.resolve(import.meta.dir, "../../../..")
const retiredHosts = /(?:opencode\.ai|opncd\.ai|models\.dev|social-cards\.sst\.dev)/
const borrowedClients =
  /Ov23li8tweQw6odWQebz|app_EMoamEEZ73f0CkXaXp7hrann|b1a00492-073a-47ea-816f-4c329264a828|\bopencode-cli\b/

// Match exact lines, not whole files: a new request URL in any of these files must fail.
const permittedLines: Record<string, string[]> = {
  // This exact legacy schema value is read only to migrate configs written by Vector.
  "packages/engine/src/config/schema.ts": [
    'const legacy = kind === "config" ? "https://opencode.ai/config.json" : "https://opencode.ai/tui.json"',
  ],
  // The only host literals in this module are a denylist, never destinations.
  "packages/core/src/provider-policy.ts": [
    '!["opencode.ai", "opncd.ai", "models.dev"].some((host) => hostname === host || hostname.endsWith(`.${host}`))',
  ],
  // Existing webfetch guards reject upstream identity lookups before any network call.
  "packages/core/src/tool/webfetch.ts": ['if (hostname === "opencode.ai" || hostname.endsWith(".opencode.ai")) {'],
  "packages/engine/src/tool/webfetch.ts": [
    'if (url.hostname === "opencode.ai" || url.hostname.endsWith(".opencode.ai")) {',
  ],
}

const sourceFiles = async () => {
  const command = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(command.stdout).text()
  expect(await command.exited).toBe(0)
  return [...new Set(output.split("\0"))].filter((name) => /^(?:packages\/[^/]+\/src\/|api\/)/.test(name))
}

describe("Vector upstream separation", () => {
  test("source contains no retired request hosts, borrowed client registrations, or upstream request identity", async () => {
    const violations = (
      await Promise.all(
        (await sourceFiles()).map(async (name) => {
          const file = Bun.file(path.join(root, name))
          if (!(await file.exists())) return [] // Tracked files deleted by the current change.
          const text = await file.text()
          if (text.includes("\0")) return [] // Binary assets are not executable source.
          return text.split(/\r?\n/).flatMap((line, index) => {
            const retired = retiredHosts.test(line) && !permittedLines[name]?.includes(line.trim())
            const borrowed = borrowedClients.test(line)
            const identity =
              /originator\s*[:=]\s*["'`]opencode["'`]/.test(line) ||
              /(?:user.agent|USER_AGENT).*?["'`]opencode\//i.test(line)
            return retired || borrowed || identity ? [`${name}:${index + 1}: ${line.trim()}`] : []
          })
        }),
      )
    ).flat()
    expect(violations).toEqual([])
  })

  test("policy rejects every upstream provider family and hosted alias", () => {
    for (const id of ["opencode", "opencode-go", "opencode-zen", "opencode-custom"])
      expect(providerAllowed(id)).toBe(false)
    for (const host of [
      "opencode.ai",
      "api.opencode.ai",
      "app.opencode.ai",
      "console.opencode.ai",
      "opncd.ai",
      "models.dev",
    ]) {
      expect(providerEndpointAllowed(`https://${host}/v1`)).toBe(false)
    }
    expect(providerAllowed("openrouter")).toBe(true)
    expect(providerEndpointAllowed("https://vectordev.ai/api.json")).toBe(true)
  })
})
