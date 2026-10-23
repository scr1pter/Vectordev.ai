import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { LocalStartup } from "../../src/local-mode/startup"
import { tmpdir } from "../fixture/tmpdir"

// Whether the backstop starts Egress pending: every source Vector Local is read from at start can turn it on, and a
// block Vector cannot decode counts as on, since config keeps it on too.

const folders = (root: string) => ({
  managed: [path.join(root, "managed")],
  preferences: path.join(root, "preferences"),
  config: path.join(root, "config"),
  state: path.join(root, "state"),
})
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe("LocalStartup.enabled", () => {
  test("is off when nothing turns Vector Local on", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(false)
    write(path.join(input.config, "vector.json"), JSON.stringify({ model: "a/b", local: { enabled: false } }))
    write(path.join(input.managed[0]!, "vector.json"), JSON.stringify({ share: "disabled" }))
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(false)
  })

  test("is on for the environment, the company's policy and the user's own config files", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    expect(LocalStartup.enabled({ ...input, env: { VECTOR_LOCAL: "1" } })).toBe(true)
    const on = JSON.stringify({ local: { enabled: true } })
    for (const file of [
      path.join(input.managed[0]!, "vector.jsonc"),
      path.join(input.config, "config.json"),
      path.join(input.config, "vector.json"),
      path.join(input.config, "vector.jsonc"),
    ]) {
      write(file, on)
      expect({ file, enabled: LocalStartup.enabled({ ...input, env: {} }) }).toEqual({ file, enabled: true })
      fs.rmSync(file)
    }
    // A company's lock forces it on.
    write(path.join(input.managed[0]!, "vector.json"), JSON.stringify({ local: { lock: true } }))
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(true)
  })

  test("is on for the desktop's config folder, the config overrides and VECTOR_CONFIG_CONTENT", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    const desktop = path.join(dir.path, "desktop")
    write(path.join(desktop, "vector.local.jsonc"), `{ "local": { "enabled": true } }`)
    expect(LocalStartup.enabled({ ...input, env: { VECTOR_AGENT_CONFIG_DIR: desktop } })).toBe(true)
    const override = path.join(dir.path, "override.json")
    write(override, JSON.stringify({ local: { enabled: true } }))
    expect(LocalStartup.enabled({ ...input, env: { VECTOR_AGENT_CONFIG: override } })).toBe(true)
    expect(LocalStartup.enabled({ ...input, env: { VECTOR_CONFIG_CONTENT: `{"local":{"enabled":true}}` } })).toBe(true)
  })

  test("reads JSON with comments and trailing commas, as config does", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    const file = path.join(input.config, "vector.jsonc")
    write(
      file,
      `{\n  "$schema": "https://vectordev.ai/config.json", // the schema\n  /* Vector Local */ "local": { "enabled": true, "web": "none", },\n}`,
    )
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(true)
    // A comment's or a bracket's characters inside a string are the string's.
    write(file, `{ "$schema": "https://vectordev.ai/config.json", "share": "// ,} /*", "local": { "enabled": false } }`)
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(false)
    // Text that is not JSON counts when it names a local block, which config's lenient reader may still find.
    write(file, `{ "local": { "enabled": true }`)
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(true)
    write(file, `{ "model": `)
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(false)
  })

  test("is on for a local block Vector cannot decode, which config keeps on too", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { enabled: "yes" } }))
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(true)
  })

  test("is on while the block the owner last let apply still turns it on", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    // An edit that turned it off while Vector was closed waits for the owner; config keeps the confirmed block.
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { enabled: false } }))
    write(path.join(input.state, "local-confirmed-0123456789abcdef.json"), JSON.stringify({ local: { enabled: true } }))
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(true)
    write(path.join(input.state, "local-confirmed-0123456789abcdef.json"), JSON.stringify({ local: null }))
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(false)
  })

  test("is on for a macOS profile that sets Vector Local, which it cannot convert without running a program", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    write(path.join(input.preferences, "ai.vector.managed.plist"), "bplist00Ñ\u0001\u0002Ulocal")
    expect(LocalStartup.enabled({ ...input, env: {}, platform: "darwin" })).toBe(true)
    expect(LocalStartup.enabled({ ...input, env: {}, platform: "linux" })).toBe(false)
  })
})

// The policy of a process whose config never resolves it, the desktop's main process: the user's own config and the
// environment decide it, and every other source can only turn it on.
describe("LocalStartup.policy", () => {
  test("is the user's own policy, from the global folder and the desktop's own folder", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    const desktop = path.join(dir.path, "desktop")
    const env = { VECTOR_CLIENT: "desktop", VECTOR_AGENT_CONFIG_DIR: desktop }
    expect(LocalStartup.policy({ ...input, env })).toMatchObject({ enabled: false })
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { web_domains: { deny: ["a.example"] } } }))
    write(
      path.join(desktop, "vector.json"),
      JSON.stringify({ local: { enabled: true, web: "network", endpoints: ["http://127.0.0.1:11434"] } }),
    )
    const resolved = LocalStartup.policy({ ...input, env })
    expect(resolved).toMatchObject({
      enabled: true,
      web: "network",
      web_domains: { deny: ["a.example"] },
      endpoints: [{ origin: "http://127.0.0.1:11434", from: "user" }],
    })
    expect(resolved.pending).toBeUndefined()
    // A block Vector cannot decode keeps it on with no web.
    write(path.join(desktop, "vector.json"), JSON.stringify({ local: { enabled: "yes" } }))
    expect(LocalStartup.policy({ ...input, env })).toMatchObject({ enabled: true, web: "none" })
  })

  test("lets a company's file, an override and the confirmed block only turn it on and tighten Web access", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { web: "ask" } }))
    const company = path.join(input.managed[0]!, "vector.json")
    write(
      company,
      JSON.stringify({
        local: {
          lock: true,
          web: "network",
          endpoints: ["http://10.0.0.5:8000"],
          allow: [{ source: "usage", reason: "Counts", added_at: 1, added_by: "app" }],
        },
      }),
    )
    // Its owner is not checked here, so what it would let through does not apply.
    expect(LocalStartup.policy({ ...input, env: {} })).toMatchObject({
      enabled: true,
      web: "network",
      lock: false,
      endpoints: [],
      allow: [],
    })
    fs.rmSync(company)
    expect(
      LocalStartup.policy({ ...input, env: { VECTOR_CONFIG_CONTENT: `{"local":{"enabled":true}}` } }),
    ).toMatchObject({ enabled: true, web: "ask" })
    write(path.join(input.state, "local-confirmed-0123456789abcdef.json"), JSON.stringify({ local: { enabled: true } }))
    expect(LocalStartup.policy({ ...input, env: {} })).toMatchObject({ enabled: true })
  })

  test("turns it on with Web access None for a company policy file it cannot read, as config does", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { enabled: false } }))
    // A folder where the company's file belongs: the file system refuses to read it, as it refuses a file without
    // permission, whoever runs the test.
    const company = path.join(input.managed[0]!, "vector.json")
    fs.mkdirSync(company, { recursive: true })
    expect(LocalStartup.enabled({ ...input, env: {} })).toBe(true)
    expect(LocalStartup.policy({ ...input, env: {} })).toMatchObject({ enabled: true, web: "none" })
    fs.rmSync(company, { recursive: true })
    // A file it may not read, where permissions apply to the user running the test.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      write(company, JSON.stringify({ local: { enabled: false } }))
      fs.chmodSync(company, 0o000)
      expect(LocalStartup.policy({ ...input, env: {} })).toMatchObject({ enabled: true, web: "none" })
      fs.chmodSync(company, 0o644)
    }
    // A missing file says nothing.
    fs.rmSync(company, { force: true })
    expect(LocalStartup.policy({ ...input, env: {} })).toMatchObject({ enabled: false })
  })

  test("does not turn it on for a macOS profile, which it cannot read without running a program", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    write(path.join(input.preferences, "ai.vector.managed.plist"), "bplist00Ñ\u0001\u0002Ulocal")
    expect(LocalStartup.enabled({ ...input, env: {}, platform: "darwin" })).toBe(true)
    expect(LocalStartup.policy({ ...input, env: {}, platform: "darwin" })).toMatchObject({ enabled: false })
  })
})

describe("LocalStartup.managed", () => {
  test("is whether a company policy file is in a managed folder", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    expect(LocalStartup.managed({ ...input, env: {} })).toBe(false)
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { enabled: true } }))
    expect(LocalStartup.managed({ ...input, env: {} })).toBe(false)
    write(path.join(input.managed[0]!, "vector.json"), JSON.stringify({ share: "disabled" }))
    expect(LocalStartup.managed({ ...input, env: {} })).toBe(true)
  })
})

describe("LocalStartup.ca", () => {
  test("names the company's certificate files, then the user's, read from the folder of the file that names them", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    expect(LocalStartup.ca({ ...input, env: {} })).toEqual([])
    write(path.join(input.managed[0]!, "vector.json"), JSON.stringify({ local: { ca: { files: ["corp-root.pem"] } } }))
    write(
      path.join(input.config, "vector.jsonc"),
      `{
        // the lab's own root, written with a comment and an absolute path
        "local": { "ca": { "files": [${JSON.stringify(path.join(dir.path, "lab.pem"))}, "../corp-root-copy.pem",] } },
      }`,
    )
    expect(LocalStartup.ca({ ...input, env: {} })).toEqual([
      path.join(input.managed[0]!, "corp-root.pem"),
      path.join(dir.path, "lab.pem"),
      path.join(dir.path, "corp-root-copy.pem"),
    ])
  })

  test("reads only the company's files under a lock, and none from the environment or a block it cannot decode", async () => {
    await using dir = await tmpdir()
    const input = folders(dir.path)
    const user = path.join(dir.path, "user.pem")
    const corp = path.join(dir.path, "corp.pem")
    write(path.join(input.config, "vector.json"), JSON.stringify({ local: { ca: { files: [user] } } }))
    write(path.join(input.config, "config.json"), `{ "local": { "ca": 7 } }`)
    const env = {
      VECTOR_CONFIG_CONTENT: JSON.stringify({ local: { ca: { files: [path.join(dir.path, "env.pem")] } } }),
    }
    expect(LocalStartup.ca({ ...input, env })).toEqual([user])
    write(path.join(input.managed[0]!, "vector.json"), JSON.stringify({ local: { lock: true, ca: { files: [corp] } } }))
    expect(LocalStartup.ca({ ...input, env })).toEqual([corp])
  })
})
