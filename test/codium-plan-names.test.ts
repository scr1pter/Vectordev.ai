import { expect, test } from "bun:test"
import path from "node:path"
import { modelPlans, publicModelPlans } from "../api/_lib/model-plan-config"
import { CodiumPlan } from "../packages/schema/src/codium-plan"

// Owner rule (23 Oct 2026): Codium's plans are Plus, Pro, Max and Ultra, and nothing anyone reads calls them by their
// price. Owner decision (27 Oct 2026): Codium sells monthly plans only, with no top-ups.
const root = path.resolve(import.meta.dir, "..")
const self = path
  .relative(root, import.meta.path)
  .split(path.sep)
  .join("/")
const retired = [
  /\bCodium (?:10|50|100|200)\b/,
  // A name built from the price, such as `Codium ${price}`.
  /Codium \$\{(?:[\w.]*price|amount)\}/,
  /\bCodium \S+ top-up\b/,
]

test("the plans keep their ids and prices and take their new names", () => {
  expect(CodiumPlan.PLANS.map((plan) => [plan.id, plan.price, plan.name])).toEqual([
    ["vector-10", 10, "Plus"],
    ["vector-50", 50, "Pro"],
    ["vector-100", 100, "Max"],
    ["vector-200", 200, "Ultra"],
  ])
  expect(CodiumPlan.PLANS.map((plan) => CodiumPlan.rank(plan.id))).toEqual([1, 2, 3, 4])
  expect(CodiumPlan.TOPUPS).toEqual([])
  expect(CodiumPlan.name("vector-100")).toBe("Max")
  // A top-up id is not a plan, so it has no name.
  expect(CodiumPlan.name("codium-topup-50")).toBeUndefined()
  expect(CodiumPlan.name("vector-20")).toBeUndefined()
  expect(CodiumPlan.FREE).toBe("Free")
})

test("the hosted API names plans from the shared names, under the ids it always sold, and offers no top-up", () => {
  expect(modelPlans().map((plan) => [plan.id, plan.name, plan.price])).toEqual(
    CodiumPlan.PLANS.map((plan) => [plan.id, plan.name, plan.price]),
  )
  const config: { plans: { name: string }[]; topups?: unknown[] } = publicModelPlans()
  expect(config.plans.map((plan) => plan.name)).toEqual(["Plus", "Pro", "Max", "Ultra"])
  expect(config.topups ?? []).toEqual([])
})

test("nothing in the repository calls a plan or a top-up by its old numbered name", async () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root }).stdout.toString().split("\0")
  const files = listed.filter(
    (file) => /\.(tsx?|jsx?|mjs|cjs|astro|mdx?|json|html|css|ya?ml|txt|sh)$/.test(file) && file !== self,
  )
  const found = (
    await Promise.all(
      files.map(async (file) =>
        (await Bun.file(path.join(root, file)).text()).split("\n").flatMap((line, index) =>
          // A line that describes this check (the build plans do) quotes the names it rejects.
          retired.some((pattern) => pattern.test(line)) && !line.includes(path.basename(self))
            ? [`${file}:${index + 1}: ${line.trim()}`]
            : [],
        ),
      ),
    )
  ).flat()
  // The scan has to reach the sources it guards, or an empty result would mean nothing.
  expect(files).toContain("packages/web/src/components/marketing/codium/CodiumPricing.tsx")
  expect(files.length).toBeGreaterThan(3000)
  expect(found).toEqual([])
})

test("the check catches the old names and leaves the new ones alone", () => {
  const caught = (text: string) => retired.some((pattern) => pattern.test(text))
  for (const text of [
    "Start with Codium 10",
    "Get Codium 200",
    "name: `Codium ${price}`",
    "`Vector Codium ${pack.price} top-up`",
    "Buy Codium 50 top-up",
  ])
    expect(caught(text)).toBe(true)
  for (const text of ["Get Plus", "Vector Codium Ultra", "$10 credit top-up", "Codium credits", "Codium 2026"])
    expect(caught(text)).toBe(false)
})
