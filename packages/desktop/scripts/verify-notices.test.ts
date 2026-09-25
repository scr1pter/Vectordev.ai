import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { verifyNotices } from "./verify-notices"

for (const platform of ["darwin", "win32", "linux"] as const) {
  test(`${platform} packaging requires every nonempty notice`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "vector-notices-"))
    try {
      const resources =
        platform === "darwin" ? path.join(directory, "Contents/Resources") : path.join(directory, "resources")
      const files = [
        ...["LICENSE.txt", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"].map((file) => path.join(resources, file)),
        ...(platform === "darwin"
          ? ["Electron-LICENSE.txt", "LICENSES.chromium.html"].map((file) => path.join(resources, file))
          : ["LICENSE", "LICENSES.chromium.html"].map((file) => path.join(directory, file))),
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
