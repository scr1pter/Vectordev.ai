import type { McpLocalConfig, McpRemoteConfig } from "@opencode-ai/sdk/v2/client"
import type { PluginDef } from "./catalog"

export function pluginAuthValues(plugin: PluginDef, values: Record<string, string>) {
  if (plugin.auth.kind !== "token") return
  const result = Object.fromEntries(plugin.auth.fields.map((field) => [field.key, values[field.key]?.trim() ?? ""]))
  if (plugin.auth.fields.some((field) => field.required !== false && !result[field.key])) return
  return result
}

export function securePluginConfig(plugin: PluginDef, values: Record<string, string>) {
  if (!plugin.build) return
  const secrets =
    plugin.auth.kind === "token"
      ? Object.fromEntries(
          plugin.auth.fields
            .filter((field) => field.secret && values[field.key])
            .map((field) => [field.key, values[field.key]]),
        )
      : {}
  const protect = (value: string) =>
    Object.entries(secrets).reduce((result, [key, secret]) => result.replaceAll(secret, `{vault:${key}}`), value)
  const config = plugin.build(values)

  if (config.type === "remote") {
    return {
      config: {
        ...config,
        headers: config.headers
          ? Object.fromEntries(Object.entries(config.headers).map(([name, value]) => [name, protect(value)]))
          : undefined,
      } satisfies McpRemoteConfig,
      secrets: Object.keys(secrets).length ? secrets : undefined,
    }
  }

  return {
    config: {
      ...config,
      command: config.command.map(protect),
      environment: config.environment
        ? Object.fromEntries(Object.entries(config.environment).map(([name, value]) => [name, protect(value)]))
        : undefined,
    } satisfies McpLocalConfig,
    secrets: Object.keys(secrets).length ? secrets : undefined,
  }
}
