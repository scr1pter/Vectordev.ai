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

  test("drops deprecated models and names included ones as the picker does", () => {
    const list = [
      provider("opencode", {}, [
        model("nemotron-3-ultra-free", "Nemotron 3 Ultra Free"),
        model("old-free", "Old Free", "deprecated"),
        // Defined only in config: no release date, and on a Zen key it bills the Zen balance.
        { ...model("my-model", "My model Free"), release_date: "" },
        { ...model("muse-spark-1.3", "Muse Spark 1.3 Free"), cost: { input: 1.25, output: 10 } },
      ]),
    ]

    // Only an included model loses its "Free"; the others keep the name the catalogue gives them.
    expect(names(list, "opencode")).toEqual(["Nemotron 3 Ultra", "My model Free", "Muse Spark 1.3 Free"])
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
