import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname } from "node:path"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"
import { injectLaunchScreen, readLaunchParts } from "./src/features/launch/launch-inject.js"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

// The local transcription worker `?url`-imports the ONNX wasm runtime so it
// ships with the bundle instead of loading from a CDN at runtime. onnxruntime-web
// is a transitive dependency of @huggingface/transformers that bun's isolated
// node_modules keep out of the app's resolution scope, so resolve it through the
// transformers package and alias its dist directory for those imports.
const require = createRequire(import.meta.url)
const ortRequire = createRequire(require.resolve("@huggingface/transformers"))
const ortDist = dirname(ortRequire.resolve("onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm"))

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
            "onnxruntime-web/dist": ortDist,
          },
        },
        define: {
          "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  {
    // The glass launch screen (src/features/launch): inline CSS and host script
    // right after the theme preload, markup right after <body>, so it is on the
    // first painted frame of both the web app and the desktop renderer. "post"
    // so Vite never reprocesses or hoists the inline style, and so the preload
    // tag is matched in both its inlined (web) and ./ (desktop) forms.
    name: "vector:launch-screen",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        try {
          return injectLaunchScreen(html, readLaunchParts())
        } catch (error) {
          if (!ctx.server) throw error
          ctx.server.config.logger.warn(
            `[vector:launch-screen] not injected: ${error instanceof Error ? error.message : String(error)}`,
          )
          return html
        }
      },
    },
  },
  tailwindcss(),
  solidPlugin(),
]
