#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"
import { v1Schema } from "./v1-schema"

const engine = path.resolve(dir, "../../engine")

// Bootstrapping breaks the API-import/SDK-factory cycle during a generated client rename.
// Always follow it with a normal build so committed output comes from the current server.
const bootstrap = process.argv.includes("--bootstrap")
if (bootstrap) await Bun.write(`${dir}/openapi.json`, Bun.file(path.resolve(dir, "../openapi.json")))
else {
  await $`bun dev generate > ${dir}/openapi.json`.cwd(engine)
  await Bun.write(path.resolve(dir, "../openapi.json"), Bun.file(`${dir}/openapi.json`))
}

const document = (await Bun.file("./openapi.json").json()) as {
  components?: { schemas?: Record<string, unknown> }
  paths?: Record<string, Record<string, unknown>>
  [key: string]: unknown
}
const schemas = document.components?.schemas
if (schemas) {
  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length)
        if (reachable.has(name)) continue
        reachable.add(name)
        visit(schemas[name])
      } else {
        visit(child)
      }
    }
  }
  visit({ ...document, components: { ...document.components, schemas: undefined } })
  for (const name of Object.keys(schemas)) {
    if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
  }
  await Bun.write("./openapi.json", JSON.stringify(document))
}

await Bun.write("./openapi-v1.json", JSON.stringify(v1Schema(document)))
for (const target of ["./src/gen", "./src/v2/gen"]) {
  await createClient({
    input: target === "./src/gen" ? "./openapi-v1.json" : "./openapi.json",
    output: { path: target, tsConfigPath: path.join(dir, "tsconfig.json"), clean: true },
    plugins: [
      { name: "@hey-api/typescript", exportFromIndex: false },
      {
        name: "@hey-api/sdk",
        instance: "VectorClient",
        exportFromIndex: false,
        auth: false,
        paramsStructure: target === "./src/gen" ? "grouped" : "flat",
      },
      { name: "@hey-api/client-fetch", exportFromIndex: false, baseUrl: "http://localhost:4096" },
    ],
  })

  // The client calls adapters with one Request. typeof fetch also requires runtime-specific
  // static helpers (for example Bun preconnect), which an in-process HTTP adapter cannot provide.
  for (const file of ["client/types.gen.ts", "core/serverSentEvents.gen.ts"]) {
    const generated = await Bun.file(`${target}/${file}`).text()
    const patched = generated.replace("fetch?: typeof fetch", "fetch?: (request: Request) => Promise<Response>")
    if (patched === generated) throw new Error(`Request fetch adapter patch did not apply (${target}/${file})`)
    await Bun.write(`${target}/${file}`, patched)
  }

  const generatedTypes = await Bun.file(`${target}/types.gen.ts`).text()
  if (/export type SessionNext\w+1 =/.test(generatedTypes)) {
    throw new Error("Session history generated duplicate Session event variants")
  }
  const historyTypesPatched = generatedTypes.replace(
    /(export type V2SessionHistoryData = \{[\s\S]*?query\?: \{\s*limit\?: )string([;,]\s*after\?: )string/,
    "$1number$2number",
  )
  if (historyTypesPatched === generatedTypes) {
    throw new Error("Session history numeric query patch did not apply")
  }
  await Bun.write(`${target}/types.gen.ts`, historyTypesPatched)

  if (target === "./src/v2/gen") {
    const generatedSdk = await Bun.file("./src/v2/gen/sdk.gen.ts").text()
    const historySdkPatched = generatedSdk.replace(
      /(Get session history[\s\S]*?parameters: \{\s*sessionID: string[;,]\s*limit\?: )string([;,]\s*after\?: )string/,
      "$1number$2number",
    )
    if (historySdkPatched === generatedSdk) {
      throw new Error("Session history numeric SDK patch did not apply")
    }
    await Bun.write("./src/v2/gen/sdk.gen.ts", historySdkPatched)
  }

  // Patch a @hey-api/openapi-ts codegen bug: SseFn incorrectly passes the
  // endpoint's TError into the second generic of ServerSentEventsResult, which
  // is the AsyncGenerator's TReturn slot. Iterator return values have nothing
  // to do with HTTP errors, and any consumer that calls `.return()` or returns
  // from a mock generator gets type-checked against the wrong shape. Drop the
  // arg so TReturn defaults to void.
  const sseTypesPath = `${target}/client/types.gen.ts`
  const sseTypesFile = Bun.file(sseTypesPath)
  const sseTypesSource = await sseTypesFile.text()
  const sseTypesPatched = sseTypesSource.replace(
    "=> Promise<ServerSentEventsResult<TData, TError>>",
    "=> Promise<ServerSentEventsResult<TData>>",
  )
  if (sseTypesPatched === sseTypesSource) {
    throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${sseTypesPath})`)
  }
  await Bun.write(sseTypesPath, sseTypesPatched)
}

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun run emit`
await $`rm openapi.json openapi-v1.json`
