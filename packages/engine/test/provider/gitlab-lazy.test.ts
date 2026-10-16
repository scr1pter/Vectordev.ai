import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")

// `vector models` in a separate process, so modules other test files already loaded do not count. The fixture
// catalog lists GitLab, as the shipped one does.
async function listModels(env: Record<string, string>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "vector-gitlab-lazy-"))
  const out = path.join(home, "modules.json")
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        "--preload",
        path.join(import.meta.dir, "../fixture/loaded-modules.ts"),
        "src/index.ts",
        "models",
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          VECTOR_TEST_HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local/share"),
          XDG_STATE_HOME: path.join(home, ".local/state"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
          VECTOR_CONFIG_CONTENT: "{}",
          VECTOR_AUTH_CONTENT: "{}",
          VECTOR_DISABLE_PROJECT_CONFIG: "1",
          VECTOR_PURE: "1",
          VECTOR_DISABLE_AUTOUPDATE: "1",
          VECTOR_DISABLE_MODELS_FETCH: "1",
          VECTOR_MODELS_PATH: path.join(import.meta.dir, "../tool/fixtures/models-api.json"),
          VECTOR_TEST_MODULES_OUT: out,
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const loaded = (JSON.parse(await readFile(out, "utf8")) as string[]).map((file) => file.replaceAll("\\", "/"))
    return {
      exitCode,
      stderr: exitCode === 0 ? "" : stderr,
      models: stdout.split("\n").filter((line) => line.startsWith("gitlab/")),
      sdk: loaded.some((file) => file.includes("/node_modules/gitlab-ai-provider/")),
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

test("the GitLab SDK loads only when GitLab can be used", async () => {
  const without = await listModels({})
  expect(without).toMatchObject({ exitCode: 0, stderr: "", models: [], sdk: false })

  const withToken = await listModels({ GITLAB_TOKEN: "fixture-gitlab-token" })
  expect({ exitCode: withToken.exitCode, stderr: withToken.stderr, sdk: withToken.sdk }).toEqual({
    exitCode: 0,
    stderr: "",
    sdk: true,
  })
  expect(withToken.models).toContain("gitlab/duo-chat-sonnet-4-6")
}, 120_000)
