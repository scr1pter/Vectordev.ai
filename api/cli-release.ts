import { CliRelease } from "../packages/schema/src/cli-release.js"
import { Schema } from "effect"
import { currentCliManifest } from "./_lib/cli-release.js"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "./_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  return handleCliRelease(request, response, currentCliManifest)
}

export async function handleCliRelease(
  request: ApiRequest,
  response: ApiResponse,
  loadManifest: typeof currentCliManifest,
) {
  try {
    requireMethod(request, "GET")
    const params = new URL(request.url ?? "/", "https://vectordev.ai").searchParams
    const value = (name: string) => {
      const query = request.query?.[name]
      if (Array.isArray(query) || params.getAll(name).length > 1)
        throw new ApiError(400, "CLI_RELEASE_QUERY", "Specify each CLI release option once.")
      return query ?? params.get(name) ?? undefined
    }
    const version = value("version") ?? "latest"
    const target = value("target")
    const format = value("format") ?? "json"
    if (
      (!Schema.is(CliRelease.Channel)(version) && !Schema.is(CliRelease.Version)(version)) ||
      (target !== undefined && !Schema.is(CliRelease.Target)(target)) ||
      !["json", "tsv"].includes(format) ||
      (format === "tsv" && !target)
    )
      throw new ApiError(400, "CLI_RELEASE_QUERY", "Choose a supported Vector CLI version, target and format.")
    const manifest = await loadManifest(version)
    response.setHeader("cache-control", "no-store")
    response.setHeader("x-content-type-options", "nosniff")
    response.setHeader("x-vector-release", manifest.version)
    if (!target) return json(response, 200, manifest)
    const selected = CliRelease.select(manifest, Schema.decodeUnknownSync(CliRelease.Target)(target))
    if (format === "json") return json(response, 200, selected)
    response.statusCode = 200
    response.setHeader("content-type", "text/plain; charset=utf-8")
    response.end(CliRelease.tsv(selected))
  } catch (error) {
    handleApiError(response, error)
  }
}
