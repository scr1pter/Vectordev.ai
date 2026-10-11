import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export async function createPrivateTempFile(prefix: string, name: string, content: string | Uint8Array = "") {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  await chmod(directory, 0o700)
  const file = path.join(directory, name)
  await writeFile(file, content, { flag: "wx", mode: 0o600 }).catch(async (error) => {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  })
  return {
    file,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
