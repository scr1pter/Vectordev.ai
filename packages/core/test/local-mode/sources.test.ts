import { describe, expect, test } from "bun:test"
import path from "node:path"
import { LocalMode } from "@vectordevai/schema/local-mode"
import { LocalPolicy } from "../../src/local-mode/policy"
import { LocalSources } from "../../src/local-mode/sources"

const ROOT = path.resolve(import.meta.dir, "../../../..")
const on = LocalPolicy.resolve({ global: { enabled: true } })

describe("LocalSources registry", () => {
  test("names each source once, in lower case with hyphens", () => {
    const ids = LocalSources.SOURCES.map((source) => source.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id) => !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id))).toEqual([])
    expect(LocalSources.get("webfetch")?.purpose).toBe("web-page")
    expect(LocalSources.get("nothing")).toBeUndefined()
  })

  test("covers every purpose", () => {
    const purposes = new Set(LocalSources.SOURCES.map((source) => source.purpose))
    expect(LocalMode.Purpose.literals.filter((purpose) => !purposes.has(purpose))).toEqual([])
  })

  test("points every call site at a file in the repository", async () => {
    const missing = (
      await Promise.all(
        LocalSources.SOURCES.flatMap((source) => source.callSites).map(async (file) =>
          (await Bun.file(path.join(ROOT, file)).exists()) ? undefined : file,
        ),
      )
    ).filter(Boolean)
    expect(missing).toEqual([])
    // A source with no call site yet names the files that will make its requests.
    expect(
      LocalSources.SOURCES.filter((source) => source.callSites.length === 0 && !source.planned?.length).map(
        (source) => source.id,
      ),
    ).toEqual([])
  })

  test("lists hosts as plain lower-case host names", () => {
    const hosts = LocalSources.SOURCES.flatMap((source) => source.hosts)
    expect(hosts.filter((host) => LocalPolicy.host(host) !== host)).toEqual([])
  })

  test("says what each source sends and why", () => {
    expect(LocalSources.SOURCES.filter((source) => !source.sends.trim() || !source.why.trim())).toEqual([])
  })

  test("decides each source's own hosts the way its Vector Local setting says", () => {
    const rows = LocalSources.SOURCES.flatMap((source) =>
      source.hosts.map((host) => {
        const verdict = LocalPolicy.decide(on, {
          purpose: source.purpose,
          url: `https://${host}/`,
          source: source.id,
          manual: source.purpose === "updates",
        })
        return { id: source.id, host, local: source.local, decision: verdict.decision, allowable: verdict.allowable }
      }),
    )
    const wrong = rows.filter((row) => {
      if (row.local === "not-allowable") return row.decision !== "block" || row.allowable
      if (row.local === "blocked") return row.decision !== "block"
      if (row.local === "allow-with-reason") return row.decision !== "block" || !row.allowable
      if (row.local === "ask-once") return row.decision !== "ask"
      if (row.local === "allowed") return row.decision === "block"
      return false
    })
    expect(wrong).toEqual([])
  })

  test("lets an allow entry open blocked and allow-with-reason sources, never a not-allowable one", () => {
    const sources = LocalSources.SOURCES.filter((source) => source.hosts.length > 0 && source.purpose !== "updates")
    const policy = LocalPolicy.resolve({
      global: {
        enabled: true,
        allow: sources.map((source) => ({ source: source.id, reason: "Test", added_at: 1, added_by: "app" as const })),
      },
    })
    const rows = sources.map((source) => ({
      id: source.id,
      local: source.local,
      decision: LocalPolicy.decide(policy, {
        purpose: source.purpose,
        url: `https://${source.hosts[0]}/`,
        source: source.id,
      }).decision,
    }))
    expect(rows.filter((row) => row.local === "not-allowable" && row.decision !== "block")).toEqual([])
    expect(
      rows.filter((row) => (row.local === "blocked" || row.local === "allow-with-reason") && row.decision !== "allow"),
    ).toEqual([])
  })

  test("the cheap gate skips blocked sources without an attempt, and decides model calls per request", () => {
    const blocked = (id: string, policy = on) => LocalPolicy.blocks(policy, LocalSources.get(id)!)
    expect(blocked("model-catalog")).toBe(true)
    expect(blocked("usage-checkin")).toBe(true)
    expect(blocked("chatgpt-signin")).toBe(true)
    expect(blocked("embedding-model")).toBe(false)
    expect(blocked("webfetch")).toBe(false)
    expect(blocked("cloud-inference")).toBe(false)
    expect(blocked("model-catalog", LocalPolicy.OFF)).toBe(false)
    const allowed = LocalPolicy.resolve({
      global: { enabled: true, allow: [{ source: "model-catalog", reason: "Prices", added_at: 1, added_by: "cli" }] },
    })
    expect(blocked("model-catalog", allowed)).toBe(false)
  })

  test("refuses the cloud AI hosts as a user's model servers by default", () => {
    const policy = LocalPolicy.resolve({
      global: { enabled: true, endpoints: LocalSources.CLOUD_INFERENCE_HOSTS.map((host) => `https://${host}`) },
    })
    expect(policy.endpoints).toEqual([])
    expect(policy.warnings).toHaveLength(LocalSources.CLOUD_INFERENCE_HOSTS.length)
  })
})
