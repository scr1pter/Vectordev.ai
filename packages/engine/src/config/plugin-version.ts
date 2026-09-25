export * as ConfigPluginVersion from "./plugin-version"

import desktop from "../../../desktop/package.json"

declare const VECTOR_PLUGIN_VERSION: string

// Published CLI, desktop, and plugin SDK artifacts share the selected release version.
export const PluginDependencyVersion =
  typeof VECTOR_PLUGIN_VERSION === "string" ? VECTOR_PLUGIN_VERSION : desktop.version
