import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { createUpdateGate } from "./local-mode"
import { updateFeed } from "./update-feed"

// A company's update mirror (local.updates.url): the feed electron-updater reads, and the only place Vector Local lets
// automatic update checks reach.

const temporary: string[] = []
afterEach(() => temporary.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

// A packaged app's resources folder, with the app-update.yml electron-builder writes.
function resources() {
  const dir = mkdtempSync(path.join(tmpdir(), "vector-update-feed-"))
  temporary.push(dir)
  writeFileSync(path.join(dir, "app-update.yml"), "provider: generic\nurl: https://vectordev.ai/download/desktop\n")
  return dir
}

const company = (url: string, enabled = false) =>
  LocalPolicy.resolve({ managed: { enabled, updates: { url } }, global: {} })

describe("the update feed", () => {
  test("the mirror feed URL is set when the company's policy names one, Vector Local on or off", () => {
    for (const enabled of [false, true]) {
      const { feed, ignored } = updateFeed({
        policy: company("https://mirror.corp.example.com/vector/", enabled),
        resources: resources(),
      })
      expect(ignored).toBeUndefined()
      expect(feed).toEqual({
        url: "https://mirror.corp.example.com/vector/",
        mirror: true,
        options: { provider: "generic", url: "https://mirror.corp.example.com/vector/", channel: "latest" },
      })
    }
  })

  test("without a mirror it is the feed the app was built with, which needs no change", () => {
    expect(updateFeed({ policy: LocalPolicy.OFF, resources: resources() })).toEqual({
      feed: { url: "https://vectordev.ai/download/desktop", mirror: false },
    })
    // A development build has no app-update.yml.
    expect(updateFeed({ policy: LocalPolicy.OFF, resources: undefined })).toEqual({})
  })

  test("a mirror must use https without credentials, or be on this computer", () => {
    for (const url of [
      "http://mirror.corp.example.com/vector/",
      "https://user:secret@mirror.corp.example.com/vector/",
      "https://mirror.corp.example.com/vector/?token=x",
      "ftp://mirror.corp.example.com/vector/",
      "not a url",
    ]) {
      const { feed, ignored } = updateFeed({ policy: company(url), resources: resources() })
      expect(feed).toEqual({ url: "https://vectordev.ai/download/desktop", mirror: false })
      expect(ignored).toBe(
        `Ignored the update mirror ${url} in your company's policy: it must be an https address with no user name, password or query.`,
      )
    }
    expect(updateFeed({ policy: company("http://127.0.0.1:8080/vector/"), resources: undefined }).feed?.mirror).toBe(
      true,
    )
  })

  test("with Vector Local on, automatic checks go to the company's mirror and not to Vector's own feed", () => {
    const policy = company("https://mirror.corp.example.com/vector/", true)
    const gate = (url: string | undefined) =>
      createUpdateGate({
        feed: () => url,
        policy: () => policy,
        held: () => false,
        ask: async () => false,
        tell: async () => undefined,
        during: (_origins, run) => run(),
      })
    expect(gate(updateFeed({ policy, resources: resources() }).feed?.url).automatic()).toBe(true)
    expect(
      gate(updateFeed({ policy: { ...policy, updates: undefined }, resources: resources() }).feed?.url).automatic(),
    ).toBe(false)
  })
})
