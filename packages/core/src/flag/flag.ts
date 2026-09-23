import { Config } from "effect"
import { readEnv, configEnv } from "./compat"

export function truthy(key: string) {
  const value = readEnv(key)?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = readEnv("VECTOR_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
const fff = readEnv("VECTOR_DISABLE_FFF")

function enabledByExperimental(key: string) {
  return readEnv(key) === undefined ? truthy("VECTOR_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: readEnv("OTEL_EXPORTER_OTLP_ENDPOINT"),
  OTEL_EXPORTER_OTLP_HEADERS: readEnv("OTEL_EXPORTER_OTLP_HEADERS"),

  VECTOR_AUTO_HEAP_SNAPSHOT: truthy("VECTOR_AUTO_HEAP_SNAPSHOT"),
  VECTOR_GIT_BASH_PATH: readEnv("VECTOR_GIT_BASH_PATH"),
  VECTOR_CONFIG: readEnv("VECTOR_CONFIG"),
  get VECTOR_CONFIG_CONTENT() {
    return readEnv("VECTOR_CONFIG_CONTENT")
  },
  VECTOR_DISABLE_AUTOUPDATE: truthy("VECTOR_DISABLE_AUTOUPDATE"),
  VECTOR_ALWAYS_NOTIFY_UPDATE: truthy("VECTOR_ALWAYS_NOTIFY_UPDATE"),
  VECTOR_DISABLE_PRUNE: truthy("VECTOR_DISABLE_PRUNE"),
  VECTOR_DISABLE_TERMINAL_TITLE: truthy("VECTOR_DISABLE_TERMINAL_TITLE"),
  VECTOR_SHOW_TTFD: truthy("VECTOR_SHOW_TTFD"),
  VECTOR_DISABLE_AUTOCOMPACT: truthy("VECTOR_DISABLE_AUTOCOMPACT"),
  VECTOR_DISABLE_MODELS_FETCH: truthy("VECTOR_DISABLE_MODELS_FETCH"),
  VECTOR_DISABLE_MOUSE: truthy("VECTOR_DISABLE_MOUSE"),
  VECTOR_FAKE_VCS: readEnv("VECTOR_FAKE_VCS"),
  VECTOR_SERVER_PASSWORD: readEnv("VECTOR_SERVER_PASSWORD"),
  VECTOR_SERVER_USERNAME: readEnv("VECTOR_SERVER_USERNAME"),
  VECTOR_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("VECTOR_DISABLE_FFF"),

  // Experimental
  VECTOR_EXPERIMENTAL_FILEWATCHER: configEnv("VECTOR_EXPERIMENTAL_FILEWATCHER", Config.boolean).pipe(
    Config.withDefault(false),
  ),
  VECTOR_EXPERIMENTAL_DISABLE_FILEWATCHER: configEnv("VECTOR_EXPERIMENTAL_DISABLE_FILEWATCHER", Config.boolean).pipe(
    Config.withDefault(false),
  ),
  VECTOR_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("VECTOR_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  VECTOR_MODELS_URL: readEnv("VECTOR_MODELS_URL"),
  VECTOR_MODELS_PATH: readEnv("VECTOR_MODELS_PATH"),
  VECTOR_DB: readEnv("VECTOR_DB"),

  VECTOR_WORKSPACE_ID: readEnv("VECTOR_WORKSPACE_ID"),
  VECTOR_EXPERIMENTAL_WORKSPACES: enabledByExperimental("VECTOR_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get VECTOR_DISABLE_PROJECT_CONFIG() {
    return truthy("VECTOR_DISABLE_PROJECT_CONFIG")
  },
  get VECTOR_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("VECTOR_EXPERIMENTAL_REFERENCES")
  },
  get VECTOR_TUI_CONFIG() {
    return readEnv("VECTOR_TUI_CONFIG")
  },
  get VECTOR_CONFIG_DIR() {
    return readEnv("VECTOR_CONFIG_DIR")
  },
  get VECTOR_PURE() {
    return truthy("VECTOR_PURE")
  },
  get VECTOR_PERMISSION() {
    return readEnv("VECTOR_PERMISSION")
  },
  get VECTOR_PLUGIN_META_FILE() {
    return readEnv("VECTOR_PLUGIN_META_FILE")
  },
  get VECTOR_CLIENT() {
    return readEnv("VECTOR_CLIENT") ?? "cli"
  },
}
