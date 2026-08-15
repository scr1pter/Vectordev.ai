type ActivityPart = {
  type: string
  tool?: string
  state?: {
    status: string
    input?: Record<string, unknown>
  }
}

const verificationAgents = new Set(["judge", "test", "review", "security"])
const verificationCommand =
  /(?:^|\s)(?:bun\s+(?:test|typecheck|run\s+(?:test|lint|typecheck|build))|npm\s+(?:test|run\s+(?:test|lint|typecheck|build))|pnpm\s+(?:test|lint|typecheck|build)|yarn\s+(?:test|lint|typecheck|build)|pytest|python\s+-m\s+pytest|vitest|jest|playwright\s+test|cargo\s+test|go\s+test|dotnet\s+test|gradle\s+test|mvn\s+test)(?:\s|$)/i

function active(part: ActivityPart) {
  return part.state?.status === "pending" || part.state?.status === "running"
}

function inputText(input: Record<string, unknown> | undefined) {
  if (!input) return ""
  return Object.values(input)
    .filter((value): value is string => typeof value === "string")
    .join(" ")
}

export function isActiveVerification(part: ActivityPart) {
  if (part.type !== "tool" || !active(part)) return false
  if (part.tool === "task") {
    const subagent = part.state?.input?.subagent_type
    return typeof subagent === "string" && verificationAgents.has(subagent)
  }
  if (part.tool !== "bash" && part.tool !== "shell") return false
  return verificationCommand.test(inputText(part.state?.input))
}

export function hasActiveVerification(parts: readonly ActivityPart[]) {
  return parts.some(isActiveVerification)
}
