import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import theme from "../src/theme"
import type { HookParameters } from "@astrojs/starlight/types"

const configure = async (components: HookParameters<"config:setup">["config"]["components"] = {}) => {
  const updates: Parameters<HookParameters<"config:setup">["updateConfig"]>[0][] = []
  await theme().hooks["config:setup"]!({
    config: { title: "Vector", components, customCss: ["./src/styles/custom.css"] },
    updateConfig: (value: Parameters<HookParameters<"config:setup">["updateConfig"]>[0]) => {
      updates.push(value)
    },
  } as unknown as HookParameters<"config:setup">)
  expect(updates).toHaveLength(1)
  return updates[0]!
}

test("vendored theme preserves site overrides and CSS precedence with locally resolvable assets", async () => {
  const value = await configure({ Head: "./head.astro", Header: "./header.astro", Footer: "./footer.astro" })
  expect(value.pagination).toBe(false)
  expect(value.components).toMatchObject({ Head: "./head.astro", Header: "./header.astro", Footer: "./footer.astro" })
  expect(await Bun.file(value.components!.PageTitle!).exists()).toBe(true)
  expect(value.customCss!.slice(0, 5)).toEqual([
    "@fontsource/ibm-plex-mono/400.css",
    "@fontsource/ibm-plex-mono/400-italic.css",
    "@fontsource/ibm-plex-mono/500.css",
    "@fontsource/ibm-plex-mono/600.css",
    "@fontsource/ibm-plex-mono/700.css",
  ])
  expect(value.customCss!.at(-1)).toBe("./src/styles/custom.css")
  for (const stylesheet of value.customCss!.slice(5, -1)) {
    expect(await Bun.file(stylesheet).exists()).toBe(true)
    expect(stylesheet).toContain("/src/theme/styles/")
  }
  expect((await configure({ PageTitle: "./custom-title.astro" })).components!.PageTitle).toBe("./custom-title.astro")
})

test("website has no external theme dependency and retains the integrity-verified MIT notice", async () => {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json()
  expect(pkg.dependencies["toolbeam-docs-theme"]).toBeUndefined()
  const license = await Bun.file(new URL("../src/theme/LICENSE", import.meta.url)).text()
  expect(createHash("sha256").update(license).digest("hex")).toBe(
    "d498457387e941105622efe452e3884615c160d69867b7aa08ab24e72e52f5af",
  )
  expect(await Bun.file(new URL("../../../THIRD_PARTY_NOTICES.md", import.meta.url)).text()).toContain(license.trim())
  const configuration = await Bun.file(new URL("../astro.config.mjs", import.meta.url)).text()
  expect(configuration).toContain('"./src/theme/index.ts"')
  expect(configuration).not.toContain('from "toolbeam-docs-theme"')
})
