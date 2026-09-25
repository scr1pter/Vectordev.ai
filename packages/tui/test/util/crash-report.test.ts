import { expect, test } from "bun:test"
import { crashReport, openCrashReportDraft } from "../../src/util/crash-report"

test("crash report includes useful context and visibly bounds long traces", () => {
  const report = crashReport({
    message: "Synthetic failure",
    stack: "trace",
    version: "0.0.0",
    os: "fixture",
    terminal: "fixture",
  })
  expect(report).toContain("Vector terminal crash")
  expect(report).toContain("Version: 0.0.0")
  expect(report).toContain("Synthetic failure\n\ntrace")
  const large = crashReport({
    message: "Synthetic failure",
    stack: "x".repeat(9_000),
    version: "0.0.0",
    os: "fixture",
    terminal: "fixture",
  })
  expect(large.length).toBeLessThanOrEqual(8_000)
  expect(large).toEndWith("… (truncated)")
})

test("local review is escaped, private, restricted to its exact address, and explicitly disposable", async () => {
  const draft = openCrashReportDraft('Synthetic </textarea><script>alert("fixture")</script>')
  try {
    const url = new URL(draft.url)
    expect(url.hostname).toBe("127.0.0.1")
    expect(url.search).toBe("")
    expect(draft.url).not.toContain("Synthetic")
    const response = await fetch(draft.url)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    const html = await response.text()
    expect(html).toContain("Synthetic &lt;/textarea&gt;&lt;script&gt;")
    expect(html).not.toContain("Synthetic </textarea>")
    expect(html).toContain("Continue to Vector support")
    expect(html).toContain("https://vectordev.ai/support/report")
    expect((await fetch(`${draft.url}?report=wrong`)).status).toBe(404)
    expect((await fetch(new URL("/wrong", url))).status).toBe(404)
    expect((await fetch(draft.url, { method: "POST", body: "unexpected" })).status).toBe(404)
    expect((await fetch(draft.url, { headers: { origin: "https://unrelated.invalid" } })).status).toBe(404)
    expect((await fetch(draft.url, { headers: { host: `unrelated.invalid:${url.port}` } })).status).toBe(404)
  } finally {
    draft.stop()
  }
  expect(await fetch(draft.url).catch(() => undefined)).toBeUndefined()
})
