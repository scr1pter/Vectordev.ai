import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { brainWorkerModule } from "../../engine/script/brain-worker-module"

test("preserves the embedded reader through Bun and electron-vite's ESM shim", async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "vector-brain-module-")))
  // The reader contains late imports inside its source string. These must never become insertion points for the
  // desktop bundler's CommonJS shim, even when Bun changes the outer string's quoting.
  const source = [
    String.raw`const text="Unicode: café 文 🧠";const quotes="\"double\" and 'single'";const file="C:\\reader\\document.pdf";`,
    "const template=`value ${text}`;",
    'import{createRequire}from"module";',
    "export default {text,quotes,file,template,createRequire};\n",
  ].join("")
  try {
    await Bun.write(path.join(directory, "package.json"), JSON.stringify({ type: "module" }))
    await Bun.write(path.join(directory, "entry.ts"), 'export { default } from "brain-worker.gen.ts"\n')
    const engine = await Bun.build({
      entrypoints: [path.join(directory, "entry.ts")],
      target: "node",
      format: "esm",
      files: { "brain-worker.gen.ts": brainWorkerModule(source) },
    })
    expect(engine.success, engine.logs.map(String).join("\n")).toBe(true)
    await Bun.write(path.join(directory, "engine.mjs"), await engine.outputs[0]!.text())
    await Bun.write(
      path.join(directory, "index.mjs"),
      'import source from "./engine.mjs";\nconsole.log(JSON.stringify({ source, file: require("node:path").basename(__filename), directory: __dirname }));\n',
    )
    await Bun.write(
      path.join(directory, "electron.vite.config.mjs"),
      `export default {
        main: {
          envFile: false,
          build: {
            rollupOptions: { input: "index.mjs", output: { format: "es", entryFileNames: "index.mjs" } }
          }
        }
      }\n`,
    )
    const build = Bun.spawnSync(
      [
        "node",
        path.join(
          path.dirname(Bun.resolveSync("electron-vite/package.json", import.meta.dir)),
          "bin",
          "electron-vite.js",
        ),
        "build",
      ],
      { cwd: directory, stdout: "pipe", stderr: "pipe", timeout: 20_000 },
    )
    expect(build.exitCode, `${build.stdout}\n${build.stderr}`).toBe(0)
    const result = Bun.spawnSync(["node", path.join(directory, "out/main/index.mjs")], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({
      source,
      file: "index.mjs",
      directory: path.join(directory, "out/main"),
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
