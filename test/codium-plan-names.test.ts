import { expect, test } from "bun:test"
import path from "node:path"
import { modelPlans, modelTopups, publicModelPlans } from "../api/_lib/model-plan-config"
import { CodiumPlan } from "../packages/schema/src/codium-plan"

// Owner rule (23 Oct 2026): Codium's plans are Plus, Pro, Max and Ultra, and nothing anyone reads calls them by their
// price. Top-ups are not plans, so they are named by their amount.
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
  expect(CodiumPlan.TOPUPS.map((pack) => [pack.id, pack.price, pack.name])).toEqual([
    ["codium-topup-10", 10, "$10 credit top-up"],
    ["codium-topup-50", 50, "$50 credit top-up"],
    ["codium-topup-100", 100, "$100 credit top-up"],
    ["codium-topup-200", 200, "$200 credit top-up"],
  ])
  expect(CodiumPlan.name("vector-100")).toBe("Max")
  expect(CodiumPlan.name("codium-topup-50")).toBe("$50 credit top-up")
  expect(CodiumPlan.name("vector-20")).toBeUndefined()
  expect(CodiumPlan.FREE).toBe("Free")
})

test("the hosted API names plans and top-ups from the shared names, under the ids it always sold", () => {
  expect(modelPlans().map((plan) => [plan.id, plan.name, plan.price])).toEqual(
    CodiumPlan.PLANS.map((plan) => [plan.id, plan.name, plan.price]),
  )
  expect(modelTopups().map((pack) => [pack.id, pack.name, pack.price])).toEqual(
    CodiumPlan.TOPUPS.map((pack) => [pack.id, pack.name, pack.price]),
  )
  const config = publicModelPlans()
  expect(config.plans.map((plan) => plan.name)).toEqual(["Plus", "Pro", "Max", "Ultra"])
  // No top-up shares a plan's name.
  expect(config.topups.filter((pack) => config.plans.some((plan) => plan.name === pack.name))).toEqual([])
})

test("nothing in the repository calls a plan or a top-up by its old numbered name", async () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root }).stdout.toString().split("\0")
  const files = listed.filter(
    (file) => /\.(tsx?|jsx?|mjs|cjs|astro|mdx?|json|html|css|ya?ml|txt|sh)$/.test(file) && file !== self,
  )
  const found = (
    await Promise.all(
      files.map(async (file) =>
        (await Bun.file(path.join(root, file)).text())
          .split("\n")
          .flatMap((line, index) =>
            retired.some((pattern) => pattern.test(line)) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
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
