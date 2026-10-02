import { expect, test } from "bun:test"
import path from "node:path"
import {
  checkProviderIconFiles,
  checkProviderIcons,
  forkProviderIcons,
  importProviderIcons,
} from "./provider-catalog-icons"
import { catalogFork } from "../../engine/script/catalog-fork"
import { catalogForkFixture } from "../../engine/test/fixture/catalog-fork"
import { GENERIC_PROVIDER_ICON } from "../src/components/provider-icon-name"

test("catalog icons keep branded artwork consistent and require a registered neutral fallback", () => {
  const input = {
    providers: ["openai", "anthropic", "missing-provider"],
    names: ["openai", "anthropic", GENERIC_PROVIDER_ICON],
    sprite: '<svg><symbol id="openai"/><symbol id="anthropic"/><symbol id="generic-provider"/></svg>',
  }
  expect(checkProviderIcons(input)).toEqual({ providers: 3, fallback: ["missing-provider"] })
  expect(() => checkProviderIcons({ ...input, names: ["openai", GENERIC_PROVIDER_ICON] })).toThrow("anthropic")
  expect(() =>
    checkProviderIcons({ ...input, sprite: '<svg><symbol id="anthropic"/><symbol id="generic-provider"/></svg>' }),
  ).toThrow("openai")
  expect(() => checkProviderIcons({ ...input, names: ["openai", "anthropic"] })).toThrow("generic provider")
  expect(() => checkProviderIcons({ ...input, sprite: '<svg><symbol id="openai"/></svg>' })).toThrow("generic provider")
})

test("pinned provider artwork remains preferred and missing artwork uses the committed neutral icon", async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="color"/></defs><path fill="url(\'#color\')" d="M0 0"/></svg>'
  await using fixture = await catalogForkFixture({ "providers/openai/logo.svg": svg })
  const fork = await catalogFork(fixture.input)
  expect(await forkProviderIcons(fork, ["openai"])).toEqual([{ id: "openai", svg }])
  expect(await forkProviderIcons(fork, ["anthropic"])).toEqual([])
  const directory = path.join(fixture.input.directory, "output")
  const existing = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="6"/></svg>'
  await Bun.write(path.join(directory, "src/assets/icons/provider/google.svg"), existing)
  await importProviderIcons(fork, ["openai", "anthropic", "google"], directory)
  expect(await Bun.file(path.join(directory, "src/assets/icons/provider/openai.svg")).text()).toBe(svg)
  expect(await Bun.file(path.join(directory, "src/assets/icons/provider/google.svg")).text()).toBe(existing)
  expect(await Bun.file(path.join(directory, "src/assets/icons/provider/anthropic.svg")).exists()).toBe(false)
  expect(await Bun.file(path.join(directory, "src/assets/icons/provider/generic-provider.svg")).text()).toBe(
    await Bun.file(new URL("../src/assets/icons/provider/generic-provider.svg", import.meta.url)).text(),
  )
  expect(await checkProviderIconFiles(directory, ["openai", "anthropic", "google"])).toEqual({
    providers: 3,
    fallback: ["anthropic"],
  })
})

test("invalid supplied artwork aborts the entire import rather than replacing existing icons", async () => {
  await using fixture = await catalogForkFixture({
    "providers/openai/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
    "providers/anthropic/logo.svg": "not an SVG",
  })
  const directory = path.join(fixture.input.directory, "output")
  await expect(
    importProviderIcons(await catalogFork(fixture.input), ["openai", "anthropic"], directory),
  ).rejects.toThrow("Invalid provider logo SVG")
  expect(await Bun.file(path.join(directory, "src/assets/icons/provider/openai.svg")).exists()).toBe(false)
  expect(await Bun.file(path.join(directory, "src/assets/icons/provider/generic-provider.svg")).exists()).toBe(false)
})

for (const content of [
  "<script>alert(1)</script>",
  "<foreignObject><p>external</p></foreignObject>",
  '<use href="https://example.test/external.svg#icon"/>',
  '<path onload="alert(1)"/>',
  '<path fill="url(https://example.test/external.svg#icon)"/>',
  '<style>@import "https://example.test/style.css";</style>',
]) {
  test(`fork artwork refuses active or external content: ${content}`, async () => {
    await using fixture = await catalogForkFixture({ "providers/openai/logo.svg": `<svg>${content}</svg>` })
    await expect(forkProviderIcons(await catalogFork(fixture.input), ["openai"])).rejects.toThrow(
      "active or external content",
    )
  })
}
