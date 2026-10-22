import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs"
import path from "path"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Npm } from "@vectordevai/core/npm"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"
import { Auth } from "../../src/auth"
import { Env } from "../../src/env"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Company policy counts only when an administrator is the only one who could have written it. These tests check the
// trust rules on their own (POSIX modes, Windows access rules through a fake reader, the policy key's output) and then
// that the config loader leaves out a managed file a standard user could change.

const guard = NetworkGuard.use()

const managedDirectory = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!

const it = testEffect(
  LayerNode.compile(LayerNode.group([Config.node, FSUtil.node, Env.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Npm.node, NpmTest.noop],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.die(`unexpected http request: ${request.url}`)),
      ),
    ],
  ]),
)

afterEach(() => {
  rmSync(managedDirectory, { recursive: true, force: true })
  expect(guard.outside()).toEqual([])
})

const SYSTEM = "S-1-5-18"
const ADMINISTRATORS = "S-1-5-32-544"
const USERS = "S-1-5-32-545"
const EVERYONE = "S-1-1-0"
const CREATOR_OWNER = "S-1-3-0"
const SOMEONE = "S-1-5-21-1000-2000-3000-1001"
const FULL = 0x1f01ff
const READ = 0x1200a9

// Access rules as Get-Acl returns them for a folder an administrator made under C:\ProgramData: Users may create
// files there (and own what they create), which the file check catches.
const adminFolder = (...extra: ConfigManaged.AclRule[]): ConfigManaged.Acl => ({
  owner: ADMINISTRATORS,
  rules: [
    { sid: SYSTEM, rights: FULL, allow: true },
    { sid: ADMINISTRATORS, rights: FULL, allow: true },
    { sid: CREATOR_OWNER, rights: FULL, allow: true, inheritOnly: true },
    { sid: USERS, rights: READ | 0x2 | 0x4 | 0x10 | 0x100, allow: true },
    ...extra,
  ],
})
const adminFile = (...extra: ConfigManaged.AclRule[]): ConfigManaged.Acl => ({
  owner: ADMINISTRATORS,
  rules: [
    { sid: SYSTEM, rights: FULL, allow: true },
    { sid: ADMINISTRATORS, rights: FULL, allow: true },
    { sid: USERS, rights: READ, allow: true },
    ...extra,
  ],
})

async function managedFile() {
  const dir = await tmpdir()
  const folder = path.join(dir.path, "vector")
  mkdirSync(folder)
  const file = path.join(folder, "vector.json")
  writeFileSync(file, "{}")
  return { dir, folder, file }
}

function fakeAcl(folder: string, file: string, entries: { folder?: ConfigManaged.Acl; file?: ConfigManaged.Acl }) {
  const reads: (readonly string[])[] = []
  const reader: ConfigManaged.AclReader = (paths) => {
    reads.push(paths)
    return {
      user: SOMEONE,
      entries: Object.fromEntries(
        [
          [folder, entries.folder],
          [file, entries.file],
        ].filter((entry) => entry[1] !== undefined),
      ),
    }
  }
  return { reader, reads }
}

describe("POSIX ownership", () => {
  const owners = [0]

  test("a root-owned file or folder no one else may write is trusted", () => {
    expect(ConfigManaged.posixReason({ path: "/etc/vector/vector.json", uid: 0, gid: 0, mode: 0o100644 }, owners)).toBe(
      undefined,
    )
    expect(ConfigManaged.posixReason({ path: "/etc/vector", uid: 0, gid: 0, mode: 0o040755 }, owners)).toBe(undefined)
    // Root's own group may write: only root is in it.
    expect(ConfigManaged.posixReason({ path: "/etc/vector", uid: 0, gid: 0, mode: 0o040775 }, owners)).toBe(undefined)
  })

  test("a file owned by anyone but root is ignored", () => {
    expect(
      ConfigManaged.posixReason({ path: "/etc/vector/vector.json", uid: 501, gid: 20, mode: 0o100644 }, owners),
    ).toBe("/etc/vector/vector.json is not owned by root.")
  })

  test("a managed file writable by group or world is ignored", () => {
    expect(
      ConfigManaged.posixReason({ path: "/etc/vector/vector.json", uid: 0, gid: 20, mode: 0o100664 }, owners),
    ).toBe("/etc/vector/vector.json can be changed by other users.")
    expect(ConfigManaged.posixReason({ path: "/etc/vector/vector.json", uid: 0, gid: 0, mode: 0o100646 }, owners)).toBe(
      "/etc/vector/vector.json can be changed by other users.",
    )
    expect(ConfigManaged.posixReason({ path: "/etc/vector", uid: 0, gid: 0, mode: 0o040777 }, owners)).toBe(
      "/etc/vector can be changed by other users.",
    )
  })

  test("a world-writable folder with the sticky bit is trusted, since only owners can replace its entries", () => {
    expect(ConfigManaged.posixReason({ path: "/tmp", uid: 0, gid: 0, mode: 0o041777 }, owners)).toBe(undefined)
    // The sticky bit means nothing on a file.
    expect(ConfigManaged.posixReason({ path: "/tmp/vector.json", uid: 0, gid: 0, mode: 0o101666 }, owners)).toBe(
      "/tmp/vector.json can be changed by other users.",
    )
  })

  test.skipIf(process.platform === "win32")("checks the real file and every folder above it", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    // A file the test user made is not root's.
    expect(ConfigManaged.untrusted(file)).toEndWith("is not owned by root.")
    // The test managed folder lets the user own it; no one else may still write it.
    expect(ConfigManaged.untrusted(file, { user: true })).toBe(undefined)
    chmodSync(file, 0o666)
    expect(ConfigManaged.untrusted(file, { user: true })).toBe(`${realpathSync(file)} can be changed by other users.`)
    chmodSync(file, 0o644)
    chmodSync(folder, 0o777)
    expect(ConfigManaged.untrusted(file, { user: true })).toBe(`${realpathSync(folder)} can be changed by other users.`)
    chmodSync(folder, 0o755)
    expect(ConfigManaged.untrusted(path.join(folder, "missing.json"))).toBe(undefined)
  })

  test.skipIf(process.platform === "win32")("follows a link in the managed folder to the file it names", async () => {
    const { dir, folder } = await managedFile()
    await using _ = dir
    const target = path.join(dir.path, "elsewhere")
    mkdirSync(target)
    writeFileSync(path.join(target, "vector.json"), "{}")
    chmodSync(target, 0o777)
    const link = path.join(folder, "vector.jsonc")
    symlinkSync(path.join(target, "vector.json"), link)
    expect(ConfigManaged.untrusted(link, { user: true })).toEndWith("elsewhere can be changed by other users.")
  })
})

describe("Windows access rules", () => {
  test("a folder and file only administrators may change are trusted", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    const acl = fakeAcl(folder, file, { folder: adminFolder(), file: adminFile() })
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: acl.reader })).toBe(undefined)
    expect(acl.reads).toEqual([[folder, file]])
    // SYSTEM and TrustedInstaller own files too.
    expect(
      ConfigManaged.untrusted(file, {
        platform: "win32",
        acl: fakeAcl(folder, file, { folder: adminFolder(), file: { ...adminFile(), owner: SYSTEM } }).reader,
      }),
    ).toBe(undefined)
  })

  test("a file owned by a standard user is ignored", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    const acl = fakeAcl(folder, file, { folder: adminFolder(), file: { ...adminFile(), owner: SOMEONE } })
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: acl.reader })).toBe(
      `${file} is not owned by Administrators or SYSTEM.`,
    )
    // Only the test managed folder lets the user running Vector own it.
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: acl.reader, user: true })).toBe(undefined)
  })

  test("a file that grants Users or Everyone write access is ignored", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    for (const [sid, rights] of [
      [USERS, 0x2],
      [USERS, 0x4],
      [EVERYONE, 0x10000],
      [SOMEONE, 0x40000],
      [USERS, 0x10000000],
      [USERS, 0x40000000],
    ] as const) {
      const acl = fakeAcl(folder, file, { folder: adminFolder(), file: adminFile({ sid, rights, allow: true }) })
      expect(ConfigManaged.untrusted(file, { platform: "win32", acl: acl.reader })).toBe(
        `${file} lets ${sid} change it.`,
      )
    }
  })

  test("a folder that lets Users delete or replace its files is ignored; creating new files is not enough", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    const deleting = fakeAcl(folder, file, {
      folder: adminFolder({ sid: USERS, rights: 0x40, allow: true }),
      file: adminFile(),
    })
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: deleting.reader })).toBe(
      `${folder} lets ${USERS} change it.`,
    )
    const owned = fakeAcl(folder, file, { folder: { ...adminFolder(), owner: SOMEONE }, file: adminFile() })
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: owned.reader })).toBe(
      `${folder} is not owned by Administrators or SYSTEM.`,
    )
  })

  test("deny rules and rules for what is created inside a folder do not count against it", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    const acl = fakeAcl(folder, file, {
      folder: adminFolder({ sid: USERS, rights: FULL, allow: true, inheritOnly: true }),
      file: adminFile({ sid: EVERYONE, rights: FULL, allow: false }),
    })
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: acl.reader })).toBe(undefined)
  })

  test("a file whose access rules cannot be read is ignored", async () => {
    const { dir, folder, file } = await managedFile()
    await using _ = dir
    const acl = fakeAcl(folder, file, { folder: adminFolder() })
    expect(ConfigManaged.untrusted(file, { platform: "win32", acl: acl.reader })).toBe(
      `Vector could not read who may change ${file}.`,
    )
  })

  test.skipIf(process.platform !== "win32")("checks a real file's access rules with PowerShell", async () => {
    const { dir, file } = await managedFile()
    await using _ = dir
    // A file in the user's temporary folder is the user's, or grants them full control.
    expect(ConfigManaged.untrusted(file)).toBeString()
    expect(ConfigManaged.untrusted(file, { user: true })).toBe(undefined)
    const granted = Bun.spawnSync(["icacls", file, "/grant", `*${EVERYONE}:(W)`])
    expect(granted.exitCode).toBe(0)
    // The verdict is kept until the file changes; rewriting it makes sure this check reads the new rules.
    writeFileSync(file, "{ }")
    expect(ConfigManaged.untrusted(file, { user: true })).toBe(`${file} lets ${EVERYONE} change it.`)
  })
})

describe("the Windows policy key", () => {
  test("reads the Config value from reg query's output", () => {
    const text = '{"local":{"enabled":true,"lock":true}}'
    expect(
      ConfigManaged.parseRegistry(
        `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Vector\r\n    Config    REG_SZ    ${text}\r\n\r\n`,
      ),
    ).toBe(text)
    expect(
      ConfigManaged.parseRegistry(
        `\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Vector\n    Config    REG_EXPAND_SZ    {}\n`,
      ),
    ).toBe("{}")
  })

  test("reads nothing from a key without the value", () => {
    expect(ConfigManaged.parseRegistry("\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Vector\r\n")).toBe(undefined)
    expect(ConfigManaged.parseRegistry("    Other    REG_SZ    {}\r\n")).toBe(undefined)
    expect(ConfigManaged.parseRegistry("    Config    REG_DWORD    0x1\r\n")).toBe(undefined)
  })
})

describe("managed config", () => {
  test("lists a trusted managed file and leaves out one a standard user could change", () => {
    mkdirSync(managedDirectory, { recursive: true })
    const json = path.join(managedDirectory, "vector.json")
    const jsonc = path.join(managedDirectory, "vector.jsonc")
    writeFileSync(json, "{}")
    writeFileSync(jsonc, "{}")
    expect(ConfigManaged.read()).toEqual({ files: [json, jsonc], policies: [], ignored: [] })
    if (process.platform === "win32") return
    chmodSync(jsonc, 0o666)
    // A reason names the file it checked, as the system resolves it.
    expect(ConfigManaged.read()).toEqual({
      files: [json],
      policies: [],
      ignored: [{ source: jsonc, reason: `${realpathSync(jsonc)} can be changed by other users.` }],
    })
  })

  it.instance(
    "a trusted managed file still overrides the user's config",
    Effect.gen(function* () {
      mkdirSync(managedDirectory, { recursive: true })
      writeFileSync(path.join(managedDirectory, "vector.json"), JSON.stringify({ model: "managed/model" }))
      const config = yield* Config.use.get()
      expect(config.model).toBe("managed/model")
    }),
    { trusted: true, config: { model: "repository/model" } },
  )

  // Windows has no mode bits to loosen; its access rules are checked above.
  const posixInstance = process.platform === "win32" ? it.instance.skip : it.instance
  posixInstance(
    "a managed file a standard user could change is ignored by the config loader",
    Effect.gen(function* () {
      mkdirSync(managedDirectory, { recursive: true })
      const file = path.join(managedDirectory, "vector.json")
      writeFileSync(file, JSON.stringify({ model: "managed/model" }))
      chmodSync(file, 0o666)
      const config = yield* Config.use.get()
      expect(config.model).toBe("repository/model")
    }),
    { trusted: true, config: { model: "repository/model" } },
  )
})
