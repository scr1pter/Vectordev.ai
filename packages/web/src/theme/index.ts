import type { StarlightPlugin } from "@astrojs/starlight/types"
import { fileURLToPath } from "node:url"

/** Local integration for the vendored styles and the website's existing overrides. */
export default function theme(): StarlightPlugin {
  return {
    name: "vector-docs-theme",
    hooks: {
      "config:setup": ({ config, updateConfig }) => {
        updateConfig({
          components: {
            ...config.components,
            PageTitle: config.components?.PageTitle ?? fileURLToPath(new URL("./PageTitle.astro", import.meta.url)),
          },
          pagination: false,
          customCss: [
            "@fontsource/ibm-plex-mono/400.css",
            "@fontsource/ibm-plex-mono/400-italic.css",
            "@fontsource/ibm-plex-mono/500.css",
            "@fontsource/ibm-plex-mono/600.css",
            "@fontsource/ibm-plex-mono/700.css",
            ...["theme", "tsdoc", "markdown", "headings"].map((name) =>
              fileURLToPath(new URL(`./styles/${name}.css`, import.meta.url)),
            ),
            ...(config.customCss ?? []),
          ],
        })
      },
    },
  }
}
