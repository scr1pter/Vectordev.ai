import { InstallationVersion } from "../installation/version"

/** Attribute actual tool continuations; background session labels do not override the request role. */
export function copilotHeaders(body: unknown) {
  const value = typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : undefined
  const messages = Array.isArray(value?.input) ? value.input : Array.isArray(value?.messages) ? value.messages : []
  const last = messages.at(-1)
  const user =
    last?.role === "user" &&
    (!Array.isArray(last.content) || last.content.some((part: { type?: string }) => part.type !== "tool_result"))
  return {
    "x-initiator": user ? "user" : "agent",
    ...(JSON.stringify(messages).match(/"type":"(?:image_url|input_image|image)"/)
      ? { "Copilot-Vision-Request": "true" }
      : {}),
  }
}

export function copilotFetch(access: () => Promise<string>, fetcher: typeof fetch = fetch): typeof fetch {
  return Object.assign(
    async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : String(request))
      if (url.origin !== "https://api.githubcopilot.com" || url.username || url.password)
        throw new Error("Copilot OAuth cannot use another API origin.")
      const headers = new Headers(request instanceof Request ? request.headers : undefined)
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
      headers.delete("x-api-key")
      headers.delete("x-initiator")
      headers.set("authorization", `Bearer ${await access()}`)
      headers.set("user-agent", `vector/${InstallationVersion}`)
      headers.set("openai-intent", "conversation-edits")
      for (const [key, value] of Object.entries(copilotHeaders(init?.body))) headers.set(key, value)
      return fetcher(request, { ...init, headers, redirect: "error" })
    },
    { preconnect: fetcher.preconnect },
  )
}
