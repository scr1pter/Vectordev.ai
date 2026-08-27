export function sessionIDFromEvent(event: { properties?: unknown }) {
  if (!event.properties || typeof event.properties !== "object") return
  const sessionID = (event.properties as { sessionID?: unknown }).sessionID
  return typeof sessionID === "string" && sessionID ? sessionID : undefined
}
