import fs from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"

// Takes no argument, so tests can hand it to Effect.promise, which passes an AbortSignal.
export const tmpdir = () => tmpdirIn(osTmpdir())

export const tmpdirIn = async (parent: string) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(parent, "vector-core-test-")))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await remove(dir)
    },
  }
}

async function remove(dir: string, retries = 30): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (error) {
    if (retries === 0 || !error || typeof error !== "object" || !("code" in error) || error.code !== "EBUSY")
      throw error
    Bun.gc(true)
    await Bun.sleep(100)
    return remove(dir, retries - 1)
  }
}
