export * as ConfigPluginVersion from "./plugin-version"

import desktop from "../../../desktop/package.json"

declare const VECTOR_PLUGIN_VERSION: string

// The CLI and the plugin SDK are published together at one version. A CLI build embeds its own release version; the
// desktop engine embeds the CLI version its release requires (vectorRequiredCliVersion), because a desktop release can
// ship without a matching npm publication. Source runs fall back to that same required CLI version.
export const PluginDependencyVersion =
  typeof VECTOR_PLUGIN_VERSION === "string" ? VECTOR_PLUGIN_VERSION : desktop.vectorRequiredCliVersion
