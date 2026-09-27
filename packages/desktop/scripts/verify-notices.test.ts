import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import os from "node:os"
import { verifyNotices } from "./verify-notices"

for (const platform of ["darwin", "win32", "linux"] as const) {
  test(`${platform} packaging requires every nonempty notice`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "vector-notices-"))
    try {
      const resources =
        platform === "darwin" ? path.join(directory, "Contents/Resources") : path.join(directory, "resources")
      // Mirrors electron-builder output: Windows and Linux keep Electron's notices at the unpacked root.
      const files = [
        ...["LICENSE.txt", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"].map((file) => path.join(resources, file)),
        ...(platform === "darwin"
          ? ["Electron-LICENSE.txt", "LICENSES.chromium.html"].map((file) => path.join(resources, file))
          : ["LICENSE.electron.txt", "LICENSES.chromium.html"].map((file) => path.join(directory, file))),
      ]
      for (const file of files) await Bun.write(file, "Fixture license text")
      await verifyNotices(directory, platform)
      for (const file of files) {
        await Bun.write(file, "")
        await expect(verifyNotices(directory, platform)).rejects.toThrow("missing or empty")
        await rm(file)
        await expect(verifyNotices(directory, platform)).rejects.toThrow("missing or empty")
        await Bun.write(file, "Fixture license text")
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test("the pinned electron-builder renames Electron's LICENSE on Windows and Linux", async () => {
  // verify-notices.ts looks for this name; an electron-builder upgrade that changes it must fail here, not in CI.
  expect(
    await Bun.file(
      createRequire(createRequire(import.meta.url).resolve("electron-builder/package.json")).resolve(
        "app-builder-lib/out/electron/ElectronFramework.js",
      ),
    ).text(),
  ).toContain('path.join(out, "LICENSE"), path.join(out, "LICENSE.electron.txt")')
})
