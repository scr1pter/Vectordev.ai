export function normalizeDeployUrl(value?: string) {
  const candidate = value?.match(/https?:\/\/[^\s"'`,}\]]+/i)?.[0]?.replace(/[);.]+$/, "")
  if (!candidate || !URL.canParse(candidate)) return undefined
  const parsed = new URL(candidate)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  return parsed.toString()
}

export function extractDeployUrl(output: string, target: "vercel" | "netlify") {
  if (target === "netlify") {
    return normalizeDeployUrl(
      output.match(/(?:Website|Deploy) URL:\s*(https:\/\/\S+)/i)?.[1] ??
        output.match(/(https:\/\/[a-z0-9-]+\.netlify\.app\S*)/i)?.[1],
    )
  }
  const matches = output.match(/https:\/\/[a-z0-9.-]+\.vercel\.app\S*/gi)
  return normalizeDeployUrl(matches?.at(-1))
}
