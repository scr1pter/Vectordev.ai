import { expect, test } from "bun:test"

// What the docs and the README say about running people's own coding agents matches what the desktop app does: they
// run only when the user starts them, for that user alone, on their own words, at most four at once, and nothing they
// do feeds Vector's learning.
const read = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url)).text()
const plain = (text: string) =>
  text
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")

test("the Host locally page states every runtime rule in plain words", async () => {
  const text = plain(await read("src/pages/docs/external-agents.astro"))
  for (const rule of [
    "the conversation shows its output with Try a fix, which sends that output to the agent as your message; Vector doesn't run the agent again on its own",
    "What Vector sends one of these agents is what you typed, then plain facts about the repository",
    "No role or working style of Vector's, nothing Vector remembers, and no teammates' messages",
    "Swarms, automations, Vectorscope reviews and Vector's background work never run one",
    "At most four of them run at once, in the chat and the terminal together",
    "An invite guest can't see, start, message or resume them, or open the terminal one runs in",
    "Host locally is off while Vector is connected to a server elsewhere",
    "reach you as it wrote them",
    "work without a Vector plan or credits",
    "uses none of them to train, evaluate or benchmark anything",
  ])
    expect(text).toContain(rule)
  // The old claim that teammates' messages reach them is gone.
  expect(text).not.toContain("can be told what teammates did")
})

test("the README, multiplayer and parallel agents pages agree with it", async () => {
  const readme = plain(await read("../../README.md"))
  expect(readme).not.toContain("can still use your terminal and agents")
  expect(readme).toContain("Your terminals, and the coding agents you start from Host locally, stay yours")
  expect(readme).toContain("Coding agents you installed yourself run up to four at once.")
  expect(readme).toContain("a failed check waits for you to choose Try a fix")
  expect(readme).not.toContain("is available again from desktop 1.99.106")
  expect(plain(await read("src/pages/docs/multiplayer.astro"))).toContain(
    "a guest can't see, start, message or resume them, or open the terminal one runs in",
  )
  const parallel = plain(await read("src/pages/docs/parallel-agents.astro"))
  expect(parallel).toContain("Vector sets no cap on how many of its own agents run at once")
  expect(parallel).toContain("coding agents you installed yourself run up to four at once")
  expect(plain(await read("src/pages/docs/tokenomics.astro"))).toContain(
    "Runs of the coding agents you start from Host locally are left out",
  )
})

test("none of it uses the words the owner ruled out", async () => {
  for (const path of [
    "src/pages/docs/external-agents.astro",
    "src/pages/docs/multiplayer.astro",
    "src/pages/docs/parallel-agents.astro",
  ]) {
    const text = plain(await read(path)).replace("LF Projects, LLC", "LF")
    expect({ path, ruled: text.match(/\bprojects?\b|\bexactly\b|never exceeds|absolute privacy/gi) }).toEqual({
      path,
      ruled: null,
    })
  }
})
