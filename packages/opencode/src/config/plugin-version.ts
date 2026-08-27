export * as ConfigPluginVersion from "./plugin-version"

import { InstallationVersion } from "@opencode-ai/core/installation/version"

declare const OPENCODE_PLUGIN_VERSION: string

// Preview desktop builds intentionally use an ephemeral application version
// such as `0.0.0-prod-202608250143`. That version is not an npm release, so it
// must never be used when installing the public plugin SDK into config
// directories. Build scripts inject the exact SDK package version that was
// compiled with this server instead.
export const PluginDependencyVersion =
  typeof OPENCODE_PLUGIN_VERSION === "string" ? OPENCODE_PLUGIN_VERSION : InstallationVersion
