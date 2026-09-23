import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { providerAllowed } from "@vectordevai/core/provider-policy"
import { Provider } from "@/provider/provider"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { testEffect } from "../lib/effect"

const root = path.resolve(import.meta.dir, "../../../..")
const notices = new Set([
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "packages/ui/LICENSE",
  "packages/http-recorder/LICENSE",
  "DEPENDENCY_NOTICES.md",
])
const borrowedClients = /Ov23li8tweQw6odWQebz|app_EMoamEEZ73f0CkXaXp7hrann|b1a00492-073a-47ea-816f-4c329264a828/

async function trackedText() {
  const command = Bun.spawn(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const output = await new Response(command.stdout).text()
  expect(await command.exited).toBe(0)
  return Promise.all(
    output
      .split("\0")
      .filter(Boolean)
      .map(async (name) => {
        if (notices.has(name) || name.startsWith("licenses/")) return { name, text: "" }
        const file = Bun.file(path.join(root, name))
        const text = (await file.exists()) ? await file.text() : ""
        return { name, text: text.includes("\0") ? "" : text }
      }),
  )
}

const tracked = trackedText()

describe("Vector source independence", () => {
  test("tracked paths and text keep the upstream holder only in license notices", async () => {
    // Read the upstream holder from its required MIT notice so the guard itself
    // does not introduce the prohibited product name into application source.
    const license = await Bun.file(path.join(root, "THIRD_PARTY_NOTICES.md")).text()
    const holder = license
      .match(/^Copyright \(c\) \d{4} (.+)$/m)?.[1]
      ?.trim()
      .toLowerCase()
    expect(holder).toBeDefined()
    if (!holder) throw new Error("The upstream MIT copyright notice is missing")
    const violations = (await tracked).flatMap(({ name, text }) => {
      if (notices.has(name) || name.startsWith("licenses/")) return []
      return [
        ...(name.toLowerCase().includes(holder) ? [`path: ${name}`] : []),
        ...(text.toLowerCase().includes(holder) ? [`content: ${name}`] : []),
      ]
    })
    expect(violations).toEqual([])
  })

  test("request construction uses Vector identities and no borrowed app registrations", async () => {
    const violations = (await tracked).flatMap(({ name, text }) => {
      if (!/^(?:packages\/[^/]+\/src\/|api\/)/.test(name) || /\.(?:test|spec)\./.test(name)) return []
      const identities = [
        ...text.matchAll(/(?:["']?(?:User-Agent|originator)["']?|USER_AGENT)\s*[:=]\s*(["'`])([^"'`]+)\1/gi),
        ...text.matchAll(/(?:set|setHeader)\(["'](?:User-Agent|originator)["'],\s*(["'`])([^"'`]+)\1/gi),
      ]
      return [
        ...(borrowedClients.test(text) ? [`borrowed registration: ${name}`] : []),
        ...identities.filter((match) => !/^vector(?:[\/\s]|$)/i.test(match[2])).map((match) => `${name}: ${match[0]}`),
      ]
    })
    expect(violations).toEqual([])
  })
})

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))
it.instance(
  "an unlisted provider never loads even with a configured credential",
  () =>
    Effect.gen(function* () {
      expect(providerAllowed("unlisted-fixture-provider")).toBe(false)
      const providers = yield* Provider.use.list()
      expect(Object.keys(providers)).not.toContain("unlisted-fixture-provider")
    }),
  {
    config: {
      provider: {
        "unlisted-fixture-provider": {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "fixture-credential", baseURL: "http://127.0.0.1:1" },
          models: { example: { name: "Example" } },
        },
      },
    },
  },
)
