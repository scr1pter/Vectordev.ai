import { Config } from "effect"
import { readEnv, configEnv } from "./compat"

export function truthy(key: string) {
  const value = readEnv(key)?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = readEnv("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
const fff = readEnv("OPENCODE_DISABLE_FFF")

function enabledByExperimental(key: string) {
  return readEnv(key) === undefined ? truthy("OPENCODE_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: readEnv("OTEL_EXPORTER_OTLP_ENDPOINT"),
  OTEL_EXPORTER_OTLP_HEADERS: readEnv("OTEL_EXPORTER_OTLP_HEADERS"),

  OPENCODE_AUTO_HEAP_SNAPSHOT: truthy("OPENCODE_AUTO_HEAP_SNAPSHOT"),
  OPENCODE_GIT_BASH_PATH: readEnv("OPENCODE_GIT_BASH_PATH"),
  OPENCODE_CONFIG: readEnv("OPENCODE_CONFIG"),
  get OPENCODE_CONFIG_CONTENT() {
    return readEnv("OPENCODE_CONFIG_CONTENT")
  },
  OPENCODE_DISABLE_AUTOUPDATE: truthy("OPENCODE_DISABLE_AUTOUPDATE"),
  OPENCODE_ALWAYS_NOTIFY_UPDATE: truthy("OPENCODE_ALWAYS_NOTIFY_UPDATE"),
  OPENCODE_DISABLE_PRUNE: truthy("OPENCODE_DISABLE_PRUNE"),
  OPENCODE_DISABLE_TERMINAL_TITLE: truthy("OPENCODE_DISABLE_TERMINAL_TITLE"),
  OPENCODE_SHOW_TTFD: truthy("OPENCODE_SHOW_TTFD"),
  OPENCODE_DISABLE_AUTOCOMPACT: truthy("OPENCODE_DISABLE_AUTOCOMPACT"),
  OPENCODE_DISABLE_MODELS_FETCH: truthy("OPENCODE_DISABLE_MODELS_FETCH"),
  OPENCODE_DISABLE_MOUSE: truthy("OPENCODE_DISABLE_MOUSE"),
  OPENCODE_FAKE_VCS: readEnv("OPENCODE_FAKE_VCS"),
  OPENCODE_SERVER_PASSWORD: readEnv("OPENCODE_SERVER_PASSWORD"),
  OPENCODE_SERVER_USERNAME: readEnv("OPENCODE_SERVER_USERNAME"),
  OPENCODE_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("OPENCODE_DISABLE_FFF"),

  // Experimental
  OPENCODE_EXPERIMENTAL_FILEWATCHER: configEnv("OPENCODE_EXPERIMENTAL_FILEWATCHER", Config.boolean).pipe(
    Config.withDefault(false),
  ),
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: configEnv(
    "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER",
    Config.boolean,
  ).pipe(Config.withDefault(false)),
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OPENCODE_MODELS_URL: readEnv("OPENCODE_MODELS_URL"),
  OPENCODE_MODELS_PATH: readEnv("OPENCODE_MODELS_PATH"),
  OPENCODE_DB: readEnv("OPENCODE_DB"),

  OPENCODE_WORKSPACE_ID: readEnv("OPENCODE_WORKSPACE_ID"),
  OPENCODE_EXPERIMENTAL_WORKSPACES: enabledByExperimental("OPENCODE_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get OPENCODE_DISABLE_PROJECT_CONFIG() {
    return truthy("OPENCODE_DISABLE_PROJECT_CONFIG")
  },
  get OPENCODE_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("OPENCODE_EXPERIMENTAL_REFERENCES")
  },
  get OPENCODE_TUI_CONFIG() {
    return readEnv("OPENCODE_TUI_CONFIG")
  },
  get OPENCODE_CONFIG_DIR() {
    return readEnv("OPENCODE_CONFIG_DIR")
  },
  get OPENCODE_PURE() {
    return truthy("OPENCODE_PURE")
  },
  get OPENCODE_PERMISSION() {
    return readEnv("OPENCODE_PERMISSION")
  },
  get OPENCODE_PLUGIN_META_FILE() {
    return readEnv("OPENCODE_PLUGIN_META_FILE")
  },
  get OPENCODE_CLIENT() {
    return readEnv("OPENCODE_CLIENT") ?? "cli"
  },
}
