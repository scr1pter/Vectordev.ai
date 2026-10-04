// Desktop builds from 1.17.29 to 1.99.8 ask these routes whether they may open at all. An answer they read as
// "licence required" or "offline" covers the whole app, and on Windows and Linux that also hides Check for Updates.
// The requests copy what those builds send from Electron's main-process fetch (Node's), which follows redirects.
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export async function verifyLegacyDesktopAccess(origin: string) {
  const send = async (route: "config" | "status", init: RequestInit) => {
    const path = `/api/billing/${route}`
    // The old builds give up after 15 seconds.
    const response = await fetch(new URL(path, origin), {
      ...init,
      headers: oldClientHeaders(origin),
      signal: AbortSignal.timeout(15_000),
    })
    const problem = await legacyAccessProblem(route, response)
    if (problem) throw new Error(`${path}: ${problem}`)
    return { path, status: response.status, url: response.url }
  }
  return Promise.all([
    send("config", { method: "GET" }),
    send("status", { method: "POST", body: JSON.stringify({ activationToken: "smoke", deviceId: "smoke" }) }),
  ])
}

// Returns why old builds would stay behind their licence screen with this answer, or nothing when they open.
export async function legacyAccessProblem(route: "config" | "status", response: Response) {
  if (response.status !== 200) return `expected HTTP 200, received ${response.status}`
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim()
  if (mime !== "application/json") return `expected application/json, received ${mime ?? "no content type"}`
  const body: LegacyAnswer | null | undefined = await response.json().catch(() => undefined)
  if (typeof body !== "object" || body === null) return "expected a JSON object"
  if (route === "config") {
    // 1.17.29 to 1.19.98 open when `available` is falsy; 1.99.2 and 1.99.8 read `licenseRequired ?? available`.
    if (body.available || (body.licenseRequired ?? body.available))
      return `old builds would ask for a licence key: ${JSON.stringify(body)}`
    return
  }
  if (body.access !== true) return `old builds would stay on the licence screen: ${JSON.stringify(body)}`
  // Old builds store this answer, and a later launch that cannot reach vectordev.ai keeps the app open for 7 days
  // after the last check only while expiresAt is still ahead.
  if (!(Date.parse(String(body.expiresAt)) > Date.now() + OFFLINE_GRACE_MS))
    return `expiresAt must be more than 7 days ahead or activated copies lose their offline grace: ${JSON.stringify(body)}`
}

// The headers old builds' fetch (undici) sends to this origin.
export function oldClientHeaders(origin: string) {
  return {
    accept: "*/*",
    // Undici picks this by scheme: "br, gzip, deflate" over https and "gzip, deflate" over plain http. Old builds always
    // call https://vectordev.ai, so the production check must offer br to exercise the edge's brotli responses. Undici
    // re-picks it on each redirect hop while this value stays fixed, which only matters if a redirect changes scheme.
    "accept-encoding": new URL(origin).protocol === "https:" ? "br, gzip, deflate" : "gzip, deflate",
    "accept-language": "*",
    "content-type": "application/json",
    "sec-fetch-mode": "cors",
    "user-agent": "node",
    "x-vector-version": "1.99.2",
  }
}

// The fields old builds read from these answers.
type LegacyAnswer = { available?: unknown; licenseRequired?: unknown; access?: unknown; expiresAt?: unknown }

if (import.meta.main) {
  const origin = process.argv[2] ?? "https://vectordev.ai"
  console.log(JSON.stringify(await verifyLegacyDesktopAccess(origin), null, 2))
}
