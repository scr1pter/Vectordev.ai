export * as ConfigPluginVersion from "./plugin-version"

import plugin from "../../../plugin/package.json"

declare const VECTOR_PLUGIN_VERSION: string

// The public plugin version is independent of preview/desktop release versions.
export const PluginDependencyVersion =
  typeof VECTOR_PLUGIN_VERSION === "string" ? VECTOR_PLUGIN_VERSION : plugin.version
