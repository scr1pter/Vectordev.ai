#!/usr/bin/env bun
import path from "node:path"
import os from "node:os"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { stageSdk, verifySdk } from "./stage"

const directory = path.resolve(import.meta.dirname, "..")
const output = process.argv.includes("--skip-build") ? path.join(directory, "dist-publish") : await stageSdk()
await verifySdk(output)
const consumer = await realpath(await mkdtemp(path.join(os.tmpdir(), "vector-sdk-consumer-")))
const manifest = await Bun.file(path.join(output, "package.json")).json()
const catalog = (await Bun.file(path.resolve(directory, "../../../package.json")).json()).workspaces.catalog
const environment = {
  PATH: process.env.PATH,
  HOME: consumer,
  NPM_CONFIG_USERCONFIG: path.join(consumer, "user.npmrc"),
  NPM_CONFIG_GLOBALCONFIG: path.join(consumer, "global.npmrc"),
  NPM_CONFIG_CACHE: path.join(consumer, "npm-cache"),
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
}
async function run(command: string[], cwd = consumer) {
  const child = Bun.spawn(command, { cwd, env: environment, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${command[0]} failed (${code})\n${stdout}\n${stderr}`)
  return stdout
}
try {
  for (const file of ["user.npmrc", "global.npmrc"]) await Bun.write(path.join(consumer, file), "")
  const packed = JSON.parse(
    await run(["npm", "pack", "--offline", "--json", "--pack-destination", consumer], output),
  )[0]
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md", "README.md"])
    if (!packed.files.some((entry: { path: string }) => entry.path === file))
      throw new Error(`SDK tarball omits ${file}`)
  await Bun.write(
    path.join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      scripts: { typecheck: "tsc --noEmit" },
      dependencies: { "@vectordevai/sdk": `file:./${packed.filename}` },
      devDependencies: {
        typescript: catalog.typescript,
        "@types/node": catalog["@types/node"],
        "@types/cross-spawn": "6.0.6",
      },
    }),
  )
  await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"])
  const installed = await realpath(path.join(consumer, "node_modules/@vectordevai/sdk"))
  if (!installed.startsWith(consumer + path.sep)) throw new Error("SDK consumer resolved a workspace symlink")
  await Bun.write(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: false,
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: ["node"],
      },
      include: ["consumer.ts"],
    }),
  )
  await Bun.write(
    path.join(consumer, "consumer.ts"),
    `import { createVectorClient, type Session } from "@vectordevai/sdk/v2/client"
import { createVectorServer } from "@vectordevai/sdk/v2/server"
const legacy = await import("@vectordevai/sdk/client")
const client = createVectorClient({ baseUrl: "http://127.0.0.1:4096", directory: process.cwd(), throwOnError: true })
export async function check() {
  const session: Session | undefined = (await client.session.create({ title: "consumer" })).data
  await legacy.createVectorClient().session.create({ body: { title: "legacy" } })
  const server = await createVectorServer({ port: 0 }); server.close()
  return session
}
`,
  )
  await run([process.execPath, "typecheck"])
  await Bun.write(
    path.join(consumer, "smoke.mjs"),
    `import assert from "node:assert/strict"
import http from "node:http"
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises"
import path from "node:path"
for (const name of ${JSON.stringify(Object.keys(manifest.exports))}) await import("@vectordevai/sdk" + (name === "." ? "" : name.slice(1)))
const { createVectorClient } = await import("@vectordevai/sdk/v2/client")
const requests = []
const server = http.createServer((request, response) => {
  requests.push(request.url)
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify({ healthy: true, version: "fixture" }))
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
try {
  const client = createVectorClient({ baseUrl: "http://127.0.0.1:" + server.address().port, throwOnError: true })
  assert.equal((await client.global.health()).data.healthy, true)
  assert.deepEqual(requests, ["/global/health"])
} finally { await new Promise(resolve => server.close(resolve)) }
const bin = await mkdtemp(path.join(process.cwd(), "bin-"))
const script = path.join(bin, "vector")
const pid = path.join(bin, "child.pid")
await writeFile(script, "#!" + process.execPath + "\\n" + 'import fs from "node:fs"; fs.writeFileSync(' + JSON.stringify(pid) + ', String(process.pid)); console.log("vector server listening on http://127.0.0.1:43210"); setInterval(() => {}, 1000)')
await chmod(script, 0o700)
if (process.platform === "win32") await writeFile(script + ".cmd", '@"' + process.execPath + '" "' + script + '" %*\\r\\n')
process.env.PATH = bin + path.delimiter + process.env.PATH
const { createVectorServer } = await import("@vectordevai/sdk/v2/server")
const abort = new AbortController()
const launched = await createVectorServer({ port: 0, signal: abort.signal })
assert.equal(launched.url, "http://127.0.0.1:43210")
abort.abort()
launched.close()
const { readFile } = await import("node:fs/promises")
const childPID = Number(await readFile(pid, "utf8"))
await new Promise(resolve => setTimeout(resolve, 250))
assert.throws(() => process.kill(childPID, 0))
await rm(bin, { recursive: true, force: true })
console.log("Every export, real Node HTTP, and launcher cleanup passed")
`,
  )
  await run(["node", "smoke.mjs"])
  console.log(
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        tarball: packed.filename,
        shasum: packed.shasum,
        integrity: packed.integrity,
        exports: Object.keys(manifest.exports),
        typecheck: "passed",
        runtime: "passed",
        workspaceSymlinks: false,
        publication: "not attempted",
      },
      null,
      2,
    ),
  )
} finally {
  await rm(consumer, { recursive: true, force: true })
}
