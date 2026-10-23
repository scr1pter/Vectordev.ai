export function brainWorkerModule(source: string) {
  // electron-vite's ESM shim scans imports with a regex, including imports inside strings. Keep the worker opaque
  // through the desktop bundling pass so the shim cannot insert statements into its quoted source.
  return `export default Buffer.from(${JSON.stringify(Buffer.from(source, "utf8").toString("base64"))}, "base64").toString("utf8")`
}
