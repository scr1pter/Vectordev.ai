import { registerHooks } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

// The same built Node engine the desktop sidecar loads; no published CLI and no account credentials.
const bundle = process.argv[2]
if (!bundle) throw new Error("A built desktop engine is required")
const desktop = new URL("../package.json", import.meta.url).href
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error
      return next(specifier, { ...context, parentURL: desktop })
    }
  },
})
const engine = await import(pathToFileURL(path.resolve(bundle)).href)
const listener = await engine.Server.listen({
  port: 0,
  hostname: "127.0.0.1",
  username: "",
  password: "",
  cors: [process.env.VECTOR_CAPTURE_WEB_ORIGIN],
})
console.log(`capture:listening ${listener.url.href}`)
