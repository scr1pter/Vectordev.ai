import { expect, test } from "bun:test"
import path from "node:path"
import { checkProviderIcons, forkProviderIcons, importProviderIcons } from "./provider-catalog-icons"
import { catalogFork } from "../../engine/script/catalog-fork"
import { catalogForkFixture } from "../../engine/test/fixture/catalog-fork"

test("each catalog provider must have both a named icon and a generated sprite symbol", () => {
  const input = {
    providers: ["openai", "anthropic"],
    names: ["openai", "anthropic"],
    sprite: '<svg><symbol id="openai"/><symbol id="anthropic"/></svg>',
  }
  expect(checkProviderIcons(input)).toEqual({ providers: 2 })
  expect(() => checkProviderIcons({ ...input, names: ["openai"] })).toThrow("anthropic")
  expect(() => checkProviderIcons({ ...input, sprite: '<svg><symbol id="anthropic"/></svg>' })).toThrow("openai")
})

test("provider logos are read from the same pinned Git revision and missing artwork fails closed", async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="color"/></defs><path fill="url(\'#color\')" d="M0 0"/></svg>'
  await using fixture = await catalogForkFixture({ "providers/openai/logo.svg": svg })
  const fork = await catalogFork(fixture.input)
  expect(await forkProviderIcons(fork, ["openai"])).toEqual([{ id: "openai", svg }])
  await expect(forkProviderIcons(fork, ["anthropic"])).rejects.toThrow("regular committed")
  const directory = path.join(fixture.input.directory, "output")
  await expect(importProviderIcons(fork, ["openai", "anthropic"], directory)).rejects.toThrow("regular committed")
  expect(await Bun.file(path.join(directory, "src/assets/icons/provider/openai.svg")).exists()).toBe(false)
  await importProviderIcons(fork, ["openai"], directory)
  expect(await Bun.file(path.join(directory, "src/assets/icons/provider/openai.svg")).text()).toBe(svg)
  const types = await Bun.file(path.join(directory, "src/components/provider-icons/types.ts")).text()
  expect(
    checkProviderIcons({
      providers: ["openai"],
      names: Array.from(types.matchAll(/^\s*["']([^"']+)["'],?$/gm), (match) => match[1]),
      sprite: await Bun.file(path.join(directory, "src/components/provider-icons/sprite.svg")).text(),
    }),
  ).toEqual({ providers: 1 })
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
