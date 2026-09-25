import path from "node:path"
import { iconsSpritesheet } from "vite-plugin-icons-spritesheet"
import { SUPPORTED_PROVIDER_IDS } from "../../schema/src/provider-policy"
import { catalogFork } from "../../engine/script/catalog-fork"

export function checkProviderIcons(input: { providers: readonly string[]; names: readonly string[]; sprite: string }) {
  const symbols = new Set(
    Array.from(input.sprite.matchAll(/<symbol\b[^>]*\bid=["']([^"']+)["']/g), (match) => match[1]),
  )
  const missing = input.providers.filter((id) => !input.names.includes(id) || !symbols.has(id))
  if (missing.length)
    throw new Error(
      `Catalog providers lack committed icons: ${missing.join(", ")}. Import the reviewed Vector fork logos before release; see docs/vector/owner-actions/model-catalog.md`,
    )
  return { providers: input.providers.length }
}

export async function forkProviderIcons(fork: Awaited<ReturnType<typeof catalogFork>>, providers: readonly string[]) {
  return Promise.all(
    providers.map(async (id) => {
      const svg = await fork.read(`providers/${id}/logo.svg`)
      if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b[\s\S]*<\/svg>\s*$/i.test(svg))
        throw new Error(`Invalid provider logo SVG: ${id}`)
      const urls = Array.from(svg.matchAll(/url\(\s*([^)]*)\)/gi), (match) =>
        match[1].trim().replace(/^['"]|['"]$/g, ""),
      )
      if (
        /<!DOCTYPE|<!ENTITY|<(?:script|foreignObject|iframe|image)\b|\son\w+\s*=|href\s*=\s*["'](?!#)|@import/i.test(
          svg,
        ) ||
        urls.some((url) => !/^#[\w-]+$/.test(url))
      )
        throw new Error(`Provider logo contains active or external content: ${id}`)
      return { id, svg }
    }),
  )
}

export async function importProviderIcons(
  fork: Awaited<ReturnType<typeof catalogFork>>,
  providers: readonly string[],
  directory: string,
) {
  // Validate the complete set before replacing any committed asset.
  const icons = await forkProviderIcons(fork, providers)
  await Promise.all(
    icons.map((icon) => Bun.write(path.join(directory, "src/assets/icons/provider", `${icon.id}.svg`), icon.svg)),
  )
  const hook = iconsSpritesheet({
    withTypes: true,
    inputDir: path.join(directory, "src/assets/icons/provider"),
    outputDir: path.join(directory, "src/components/provider-icons"),
    iconNameTransformer: (name) => name,
  })[0].buildStart
  if (typeof hook !== "function") throw new Error("The pinned icon generator has no callable build hook")
  await Reflect.apply(hook, undefined, [])
}

if (import.meta.main) {
  const directory = path.resolve(import.meta.dirname, "..")
  if (process.argv.includes("--import")) {
    const fork = await catalogFork()
    await importProviderIcons(fork, SUPPORTED_PROVIDER_IDS, directory)
    console.log(`Imported provider logos from ${fork.repository}@${fork.revision}`)
  }
  const types = await Bun.file(path.join(directory, "src/components/provider-icons/types.ts")).text()
  const names = Array.from(types.matchAll(/^\s*["']([^"']+)["'],?$/gm), (match) => match[1])
  console.log(
    JSON.stringify(
      checkProviderIcons({
        providers: SUPPORTED_PROVIDER_IDS,
        names,
        sprite: await Bun.file(path.join(directory, "src/components/provider-icons/sprite.svg")).text(),
      }),
    ),
  )
}
