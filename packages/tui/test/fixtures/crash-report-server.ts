import { openCrashReportDraft } from "../../src/util/crash-report"

const server = openCrashReportDraft("Synthetic terminal crash for browser acceptance")
const keepAlive = setInterval(() => undefined, 1_000)
console.log(server.url)
process.on("SIGTERM", () => {
  clearInterval(keepAlive)
  server.stop()
})
