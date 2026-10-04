import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  macUpdateInstallerScript,
  prepareMacUpdateInstaller,
  recordUpdateFailure,
  takeUpdateFailure,
} from "./mac-update-installer"
import { isReadOnlyMacLocation, macAppBundlePath } from "./mac-update-path"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vector-mac-update-"))
  const applications = join(root, "Applications")
  const target = join(applications, "Vector.app")
  mkdirSync(join(target, "Contents", "MacOS"), { recursive: true })
  writeFileSync(join(target, "Contents", "MacOS", "Vector"), "old", { mode: 0o755 })
  const archive = join(root, "Vector-2.0.0-mac.zip")
  writeFileSync(archive, "zip")
  const userData = join(root, "userData")
  mkdirSync(join(userData, "logs"), { recursive: true })
  return { root, applications, target, archive, userData, executable: join(target, "Contents", "MacOS", "Vector") }
}

describe("mac update path", () => {
  test("finds the containing app bundle from the packaged executable", () => {
    expect(macAppBundlePath("/Applications/Vector.app/Contents/MacOS/Vector")).toBe("/Applications/Vector.app")
  })

  test("rejects executables outside an app bundle", () => {
    expect(() => macAppBundlePath("/usr/local/bin/vector")).toThrow("application bundle")
  })

  test("recognises copies macOS runs read-only", () => {
    expect(isReadOnlyMacLocation("/Volumes/Vector 2.0.0/Vector.app")).toBe(true)
    expect(isReadOnlyMacLocation("/private/var/folders/xy/T/AppTranslocation/0F2B-11AA/d/Vector.app")).toBe(true)
    expect(isReadOnlyMacLocation("/Applications/Vector.app")).toBe(false)
    expect(isReadOnlyMacLocation("/Users/me/Applications/Vector.app")).toBe(false)
  })
})

describe("mac update preparation", () => {
  test("refuses a missing download before touching the app folder", async () => {
    const app = fixture()

    await expect(
      prepareMacUpdateInstaller({
        archive: undefined,
        executable: app.executable,
        userData: app.userData,
        version: "2.0.0",
        from: "1.0.0",
      }),
    ).rejects.toThrow("downloaded update")
    await expect(
      prepareMacUpdateInstaller({
        archive: join(app.root, "missing.zip"),
        executable: app.executable,
        userData: app.userData,
        version: "2.0.0",
        from: "1.0.0",
      }),
    ).rejects.toThrow("downloaded update")

    expect(readdirSync(app.applications)).toEqual(["Vector.app"])
  })

  test("refuses an app running from a disk image or a translocated copy", async () => {
    const app = fixture()

    for (const executable of [
      "/Volumes/Vector/Vector.app/Contents/MacOS/Vector",
      "/private/var/folders/xy/T/AppTranslocation/0F2B/d/Vector.app/Contents/MacOS/Vector",
    ]) {
      await expect(
        prepareMacUpdateInstaller({
          archive: app.archive,
          executable,
          userData: app.userData,
          version: "2.0.0",
          from: "1.0.0",
        }),
      ).rejects.toThrow("Move Vector to your Applications folder")
    }
  })

  // Root may write to any folder, so the permission check can only be observed as a normal user.
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses an app whose folder is not writable",
    async () => {
      const app = fixture()
      chmodSync(app.applications, 0o555)

      await expect(
        prepareMacUpdateInstaller({
          archive: app.archive,
          executable: app.executable,
          userData: app.userData,
          version: "2.0.0",
          from: "1.0.0",
        }),
      ).rejects.toThrow("not writable")
      chmodSync(app.applications, 0o755)
    },
  )

  test("stages the helper next to the app without starting it", async () => {
    const app = fixture()

    const installer = await prepareMacUpdateInstaller({
      archive: app.archive,
      executable: app.executable,
      userData: app.userData,
      version: "2.0.0",
      from: "1.0.0",
    })

    expect(typeof installer.launch).toBe("function")
    const stages = readdirSync(app.applications).filter((entry) => entry.startsWith(".vector-update-"))
    expect(stages).toHaveLength(1)
    expect(readFileSync(join(app.applications, stages[0], "install-vector-update.sh"), "utf8")).toBe(
      macUpdateInstallerScript,
    )
  })

  test("leaves nothing in the app folder when the install fails after preparation", async () => {
    const app = fixture()
    const installer = await prepareMacUpdateInstaller({
      archive: app.archive,
      executable: app.executable,
      userData: app.userData,
      version: "2.0.0",
      from: "1.0.0",
    })

    await installer.discard()

    expect(readdirSync(app.applications)).toEqual(["Vector.app"])
  })

  // The caller only gets discard once preparation succeeds, so a failure while staging must not leave a stage behind.
  test("leaves nothing in the app folder when staging the helper fails", async () => {
    const app = fixture()
    rmSync(join(app.userData, "logs"), { recursive: true })
    writeFileSync(join(app.userData, "logs"), "not a folder")

    await expect(
      prepareMacUpdateInstaller({
        archive: app.archive,
        executable: app.executable,
        userData: app.userData,
        version: "2.0.0",
        from: "1.0.0",
      }),
    ).rejects.toThrow("EEXIST")

    expect(readdirSync(app.applications)).toEqual(["Vector.app"])
  })
})

describe("update failure marker", () => {
  test("hands a recorded failure to the next launch once", () => {
    const app = fixture()

    recordUpdateFailure(app.userData, { from: "1.0.0", version: "2.0.0", reason: "Could not reopen Vector" })

    expect(takeUpdateFailure(app.userData)).toEqual({
      from: "1.0.0",
      version: "2.0.0",
      reason: "Could not reopen Vector",
    })
    expect(takeUpdateFailure(app.userData)).toBeUndefined()
  })

  test("ignores a malformed marker", () => {
    const app = fixture()
    writeFileSync(join(app.userData, "updater-failed.json"), "{not json")

    expect(takeUpdateFailure(app.userData)).toBeUndefined()
    expect(existsSync(join(app.userData, "updater-failed.json"))).toBe(false)
  })

  test("ignores a marker that does not say which version recorded it", () => {
    const app = fixture()
    writeFileSync(join(app.userData, "updater-failed.json"), JSON.stringify({ version: "2.0.0", reason: "Timed out" }))

    expect(takeUpdateFailure(app.userData)).toBeUndefined()
  })
})

describe.skipIf(process.platform === "win32")("mac update helper", () => {
  // Runs the real helper with stand-ins for macOS's ditto and open, which Linux does not have.
  function helper(input: { ditto: "fails" | "empty" | "extracts"; open?: "fails-new"; mv?: "fails-new" }) {
    const app = fixture()
    const bin = join(app.root, "bin")
    mkdirSync(bin)
    const opened = join(app.root, "opened.log")
    const script = (lines: string[]) => `#!/bin/sh\n${lines.join("\n")}\n`
    writeFileSync(
      join(bin, "ditto"),
      script(
        {
          fails: ["exit 1"],
          empty: ["exit 0"],
          extracts: [
            'mkdir -p "$4/Vector.app/Contents/MacOS"',
            'printf new > "$4/Vector.app/Contents/MacOS/Vector"',
            'chmod 755 "$4/Vector.app/Contents/MacOS/Vector"',
          ],
        }[input.ditto],
      ),
      { mode: 0o755 },
    )
    writeFileSync(
      join(bin, "open"),
      script([
        `echo "$1" >> "${opened}"`,
        input.open === "fails-new" ? 'grep -q new "$1/Contents/MacOS/Vector" && exit 1' : "",
        "exit 0",
      ]),
      { mode: 0o755 },
    )
    const mv = spawnSync("sh", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim()
    if (input.mv === "fails-new")
      writeFileSync(
        join(bin, "mv"),
        script(['case "$1" in */payload/Vector.app) exit 1 ;; esac', `exec "${mv}" "$@"`]),
        { mode: 0o755 },
      )

    const stage = mkdtempSync(join(app.applications, ".vector-update-"))
    const file = join(stage, "install-vector-update.sh")
    writeFileSync(
      file,
      macUpdateInstallerScript
        .replaceAll("/usr/bin/ditto", join(bin, "ditto"))
        .replaceAll("/usr/bin/open", join(bin, "open")),
    )
    const marker = join(app.userData, "updater-failed.json")
    writeFileSync(marker, JSON.stringify({ version: "1.9.0", reason: "stale" }))
    const exited = spawnSync("sh", ["-c", "true"]).pid
    const log = join(app.userData, "logs", "updater-helper.log")
    const result = spawnSync(
      "/bin/sh",
      [
        file,
        String(exited),
        app.archive,
        app.target,
        stage,
        log,
        marker,
        JSON.stringify("2.0.0"),
        JSON.stringify("1.0.0"),
      ],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" },
    )
    return {
      status: result.status,
      app: readFileSync(join(app.target, "Contents", "MacOS", "Vector"), "utf8"),
      opened: existsSync(opened) ? readFileSync(opened, "utf8").trim().split("\n") : [],
      failure: takeUpdateFailure(app.userData),
      log: readFileSync(log, "utf8"),
      leftovers: readdirSync(app.applications).filter((entry) => entry !== "Vector.app"),
      target: app.target,
    }
  }

  test("reports a failed extraction and reopens the current app", () => {
    const run = helper({ ditto: "fails" })

    expect(run.status).toBe(1)
    expect(run.app).toBe("old")
    expect(run.failure).toEqual({ from: "1.0.0", version: "2.0.0", reason: "Could not extract the downloaded update" })
    expect(run.opened).toEqual([run.target])
    expect(run.log).toContain("Could not extract the downloaded update")
    expect(run.leftovers).toEqual([])
  })

  test("reports an update without a usable app and reopens the current app", () => {
    const run = helper({ ditto: "empty" })

    expect(run.status).toBe(1)
    expect(run.app).toBe("old")
    expect(run.failure).toEqual({
      from: "1.0.0",
      version: "2.0.0",
      reason: "The downloaded update does not contain a valid Vector.app",
    })
    expect(run.opened).toEqual([run.target])
  })

  test("restores the current app when the new one cannot be moved into place", () => {
    const run = helper({ ditto: "extracts", mv: "fails-new" })

    expect(run.status).toBe(1)
    expect(run.app).toBe("old")
    expect(run.failure).toEqual({ from: "1.0.0", version: "2.0.0", reason: "Could not move the new app into place" })
    expect(run.opened).toEqual([run.target])
    expect(run.leftovers).toEqual([])
  })

  test("restores and reopens the current app when the new one will not open", () => {
    const run = helper({ ditto: "extracts", open: "fails-new" })

    expect(run.status).toBe(1)
    expect(run.app).toBe("old")
    expect(run.failure?.from).toBe("1.0.0")
    expect(run.failure?.version).toBe("2.0.0")
    expect(run.failure?.reason).toContain("Could not open the updated Vector")
    expect(run.opened).toEqual([run.target, run.target])
  })

  test("installs the update, reopens Vector and leaves no failure behind", () => {
    const run = helper({ ditto: "extracts" })

    expect(run.status).toBe(0)
    expect(run.app).toBe("new")
    expect(run.failure).toBeUndefined()
    expect(run.opened).toEqual([run.target])
    expect(run.log).toContain("Vector update installed successfully")
    expect(run.leftovers).toEqual([])
  }, 15_000)
})
