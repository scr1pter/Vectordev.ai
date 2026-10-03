import path from "node:path"
import { iconsSpritesheet } from "vite-plugin-icons-spritesheet"
import { SUPPORTED_PROVIDER_IDS } from "../../schema/src/provider-policy"
import { catalogFork } from "../../engine/script/catalog-fork"
import { GENERIC_PROVIDER_ICON } from "../src/components/provider-icon-name"

export function checkProviderIcons(input: { providers: readonly string[]; names: readonly string[]; sprite: string }) {
  const symbols = new Set(
    Array.from(input.sprite.matchAll(/<symbol\b[^>]*\bid=["']([^"']+)["']/g), (match) => match[1]),
  )
  if (!input.names.includes(GENERIC_PROVIDER_ICON) || !symbols.has(GENERIC_PROVIDER_ICON))
    throw new Error("The committed generic provider icon must have both a registered name and sprite symbol")
  const incomplete = input.providers.filter((id) => input.names.includes(id) !== symbols.has(id))
  if (incomplete.length)
    throw new Error(
      `Catalog provider icons have inconsistent names and sprite symbols: ${incomplete.join(", ")}. Regenerate the provider sprite before release; see docs/vector/owner-actions/model-catalog.md`,
    )
  return { providers: input.providers.length, fallback: input.providers.filter((id) => !symbols.has(id)) }
}

export async function checkProviderIconFiles(directory: string, providers: readonly string[]) {
  const types = await Bun.file(path.join(directory, "src/components/provider-icons/types.ts")).text()
  const inventory = types.match(/export const iconNames\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? ""
  return checkProviderIcons({
    providers,
    names: Array.from(inventory.matchAll(/["']([^"']+)["']/g), (match) => match[1]),
    sprite: await Bun.file(path.join(directory, "src/components/provider-icons/sprite.svg")).text(),
  })
}

export async function forkProviderIcons(fork: Awaited<ReturnType<typeof catalogFork>>, providers: readonly string[]) {
  const icons = await Promise.all(
    providers.map(async (id) => {
      const svg = await fork.readOptional(`providers/${id}/logo.svg`)
      if (svg === undefined) return
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
  return icons.filter((icon) => icon !== undefined)
}

export async function importProviderIcons(
  fork: Awaited<ReturnType<typeof catalogFork>>,
  providers: readonly string[],
  directory: string,
) {
  // Validate the complete set before replacing any committed asset.
  const icons = await forkProviderIcons(fork, providers)
  const generic = await Bun.file(new URL("../src/assets/icons/provider/generic-provider.svg", import.meta.url)).text()
  await Promise.all(
    [...icons, { id: GENERIC_PROVIDER_ICON, svg: generic }].map((icon) =>
      Bun.write(path.join(directory, "src/assets/icons/provider", `${icon.id}.svg`), icon.svg),
    ),
  )
  await generateProviderIcons(directory)
}

export async function generateProviderIcons(directory: string) {
  const hook = iconsSpritesheet({
    withTypes: true,
    formatter: "prettier",
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
  if (process.argv.includes("--generate") && !process.argv.includes("--import")) await generateProviderIcons(directory)
  console.log(JSON.stringify(await checkProviderIconFiles(directory, SUPPORTED_PROVIDER_IDS)))
}
