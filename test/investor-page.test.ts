import { expect, test } from "bun:test"
import path from "node:path"
import { DEFAULT_REVIEW_CONFIG } from "../packages/core/src/review/types"
import { DEFAULT_SPEND_POLICY } from "../packages/desktop/src/main/spend-limits"

const root = path.join(import.meta.dir, "..")
const read = (file: string) => Bun.file(path.join(root, file)).text()
const page = await read("packages/web/src/pages/investors.astro")

test("the investor page gives the default spend caps that ship, and only for scheduled agents", () => {
  // Parallel agents are checked against the interactive policy, which ships with no caps. If either default changes,
  // the roadmap and limitations lines that describe them must change with it.
  expect(DEFAULT_SPEND_POLICY.interactive).toEqual({})
  expect(page).toContain(
    `scheduled agents already stop at $${DEFAULT_SPEND_POLICY.unattended.perRun?.usd} a run and $${DEFAULT_SPEND_POLICY.unattended.perDay?.usd} a day by default`,
  )
  expect(page).not.toMatch(/parallel agents[^.]*stop at \$/i)
})

test("the investor page describes Vectorscope's default verify pass", () => {
  expect(DEFAULT_REVIEW_CONFIG.verify).toBe("blocking")
  expect(page).not.toContain("verify pass that drops findings it cannot confirm")
  expect(page).toContain("verify pass that re-checks blocking findings")
})

test("every page that gives Vector Velocity's planned size gives the same one", async () => {
  const files = [
    "README.md",
    "packages/web/src/components/Lander.astro",
    "packages/web/src/components/marketing/shots/ShotBrowserPanel.astro",
    "packages/web/src/pages/investors.astro",
  ]
  // A size reads "300B+", "a 300B model" or "300 billion parameters"; a model name such as Qwen3-Coder-480B is not one.
  const sizes = await Promise.all(
    files.map(async (file) =>
      Array.from(
        new Set(
          Array.from(
            (await read(file)).matchAll(/(?<![-\w.])(\d+)(?:B\+|B model| billion parameter)/g),
            (match) => match[1],
          ),
        ),
      ),
    ),
  )
  expect(Object.fromEntries(files.map((file, index) => [file, sizes[index]]))).toEqual(
    Object.fromEntries(files.map((file) => [file, [sizes[0][0]]])),
  )
})
