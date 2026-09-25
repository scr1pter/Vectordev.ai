/** GitHub attachments may redirect to its CDN; credentials never follow that redirect. */
export async function downloadGithubAttachment(
  input: {
    url: string
    token: string
    signal?: AbortSignal
  },
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const initial = new URL(input.url)
  if (!allowed(initial) || initial.hostname !== "github.com") return
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000)
  let url = initial
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request(url.href, {
      redirect: "manual",
      signal,
      headers:
        attempt === 0 ? { Authorization: `Bearer ${input.token}`, Accept: "application/vnd.github.v3+json" } : {},
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location")
      await response.body?.cancel()
      if (!location) return
      url = new URL(location, url)
      if (!allowed(url)) return
      continue
    }
    const reader = response.body?.getReader()
    if (!reader) return
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      if (!response.ok) return
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 5_000_000) return
        chunks.push(chunk.value)
      }
      const contentType = response.headers.get("content-type")
      return {
        mime: contentType?.startsWith("image/") ? contentType : "text/plain",
        content: Buffer.concat(chunks).toString("base64"),
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}

function allowed(url: URL) {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    ((url.hostname === "github.com" && url.pathname.startsWith("/user-attachments/")) ||
      ["user-images.githubusercontent.com", "private-user-images.githubusercontent.com"].includes(url.hostname))
  )
}
