import { insecurePasswordReason } from "@/context/server"

export function terminalWebSocketURL(input: {
  url: string
  id: string
  directory: string
  cursor: number
  ticket?: string
  sameOrigin?: boolean
  username?: string
  password?: string
}) {
  const insecure = insecurePasswordReason({ url: input.url, password: input.password })
  if (insecure) throw new Error(insecure)
  const next = new URL(`${input.url}/pty/${input.id}/connect`)
  next.searchParams.set("directory", input.directory)
  next.searchParams.set("cursor", String(input.cursor))
  next.protocol = next.protocol === "https:" ? "wss:" : "ws:"
  if (input.ticket) {
    next.searchParams.set("ticket", input.ticket)
    return next
  }
  return next
}
