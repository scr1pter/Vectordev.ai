import { describe, expect, test } from "bun:test"
import type { Agent, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { directoryKey, normalizeAgentList, normalizeProviderList } from "./utils"

const agent = (name = "build") =>
  ({
    name,
    mode: "primary",
    permission: {},
    options: {},
  }) as Agent

describe("normalizeAgentList", () => {
  test("keeps array payloads", () => {
    expect(normalizeAgentList([agent("build"), agent("docs")])).toEqual([agent("build"), agent("docs")])
  })

  test("wraps a single agent payload", () => {
    expect(normalizeAgentList(agent("docs"))).toEqual([agent("docs")])
  })

  test("extracts agents from keyed objects", () => {
    expect(
      normalizeAgentList({
        build: agent("build"),
        docs: agent("docs"),
      }),
    ).toEqual([agent("build"), agent("docs")])
  })

  test("drops invalid payloads", () => {
    expect(normalizeAgentList({ name: "AbortError" })).toEqual([])
    expect(normalizeAgentList([{ name: "build" }, agent("docs")])).toEqual([agent("docs")])
  })
})

describe("normalizeProviderList", () => {
  // Only the fields the list reads.
  const model = (id: string, name: string, status = "active") => ({
    id,
    name,
    status,
    release_date: "2026-03-11",
    cost: { input: 0, output: 0 },
  })
  const provider = (id: string, options: Record<string, unknown>, models: ReturnType<typeof model>[]) => ({
    id,
    name: id,
    source: "custom",
    env: [],
    options,
    models: Object.fromEntries(models.map((item) => [item.id, item])),
  })
  const names = (input: ReturnType<typeof provider>[], id: string) =>
    Object.values(
      normalizeProviderList({ all: input, default: {}, connected: [] } as unknown as ProviderListResponse).all.get(id)
        ?.models ?? {},
    ).map((item) => item.name)

  test("drops retired providers from the catalog, connected ids and defaults", () => {
    const ids = ["opencode", "opencode-go", "opencode-zen", "opencode-custom"]
    const list = ids.map((id) => provider(id, { apiKey: "test-only" }, [model("coding", "Coding")]))
    const result = normalizeProviderList({
      all: [...list, provider("anthropic", {}, [model("new", "New"), model("old", "Old", "deprecated")])],
      connected: [...ids, "anthropic"],
      default: Object.fromEntries([...ids, "anthropic"].map((id) => [id, "new"])),
    } as unknown as ProviderListResponse)
    expect([...result.all.keys()]).toEqual(["anthropic"])
    expect(result.connected).toEqual(["anthropic"])
    expect(result.default).toEqual({ anthropic: "new" })
    expect(Object.keys(result.all.get("anthropic")!.models)).toEqual(["new"])
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\opencode"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/Repos/sst/opencode"))).toBe("C:/Repos/sst/opencode")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/opencode/"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})
