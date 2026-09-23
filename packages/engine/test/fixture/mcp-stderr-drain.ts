import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { drainStderr } from "../../src/mcp/index"

// A stdio "server" that floods stderr past the pipe + PassThrough capacity
// before it says anything on stdout. A typical server (node on Linux, python
// anywhere) blocks in write(2) on a full pipe; bun makes its own stdio
// non-blocking, so the retry loop below emulates that blocking write.
const floodingServer = `
const fs = require("node:fs")
const chunk = Buffer.alloc(64 * 1024, "e")
const sleep = new Int32Array(new SharedArrayBuffer(4))
function blockingWrite(fd, buf) {
  let offset = 0
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(fd, buf, offset)
    } catch (error) {
      if (error.code !== "EAGAIN") throw error
      Atomics.wait(sleep, 0, 0, 2)
    }
  }
}
for (let i = 0; i < 16; i++) blockingWrite(2, chunk)
blockingWrite(1, Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n"))
setTimeout(() => {}, 60_000)
`

const transport = new StdioClientTransport({
  stderr: "pipe",
  command: process.execPath,
  args: ["-e", floodingServer],
})
let drained = 0
drainStderr(transport.stderr, (text) => {
  drained += text.length
})
const pending = Promise.withResolvers<unknown>()
const timer = setTimeout(() => pending.resolve(undefined), 10_000)
transport.onmessage = pending.resolve

try {
  await transport.start()
  const message = await pending.promise
  process.stdout.write(JSON.stringify({ message, drained }))
} finally {
  clearTimeout(timer)
  await transport.close()
}
