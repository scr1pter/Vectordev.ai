import { expect, test } from "bun:test"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { accountChip, codiumChanged, onCodiumChange } from "./vector-account"

const photo = "data:image/png;base64,iVBORw0KGgo="
const signedIn = { authenticated: true, pending: false, email: "ana@example.test", name: "Ana Diaz" }
// The Codium status as the desktop reads it from vectordev.ai.
const codium = (plan?: string) =>
  ModelPlanStatus.fromRemote({
    enabled: true,
    access: true,
    plan: plan
      ? { id: plan, name: "Answered by the site", renewsAt: 1_790_000_000_000, cancelAtPeriodEnd: false }
      : undefined,
    purchased: { bought: false },
    empty: false,
    low: false,
  })

test("the account chip shows the photo beside the name when the desktop has one", () => {
  expect(
    accountChip({ authenticated: true, pending: false, email: "ada@example.test", name: "Ada", avatar: photo }),
  ).toEqual({ label: "Ada", name: "Ada", plan: undefined, initial: "A", photo })
})

test("without a photo the chip falls back to the first letter, of the email when there is no name", () => {
  expect(accountChip({ authenticated: true, pending: false, email: "ada@example.test", name: "Ada" })).toMatchObject({
    label: "Ada",
    initial: "A",
    photo: undefined,
  })
  expect(accountChip({ authenticated: true, pending: false, email: "ada@example.test" })).toMatchObject({
    label: "ada@example.test",
    name: "ada@example.test",
    initial: "a",
    photo: undefined,
  })
  expect(accountChip({ authenticated: false, pending: false })).toMatchObject({
    label: "",
    initial: "",
    photo: undefined,
  })
})

test("the chip shows the first name, keeping the whole name for the button's accessible name", () => {
  expect(accountChip(signedIn)).toMatchObject({ label: "Ana", name: "Ana Diaz", initial: "A" })
  expect(accountChip({ ...signedIn, name: "  Ana   Maria Diaz " })).toMatchObject({
    label: "Ana",
    name: "Ana   Maria Diaz",
  })
})

test("beside the name the chip says Free without a Codium plan, else the plan's name", () => {
  expect(accountChip(signedIn, codium()).plan).toBe("Free")
  expect(
    ["vector-10", "vector-50", "vector-100", "vector-200"].map((plan) => accountChip(signedIn, codium(plan)).plan),
  ).toEqual(["Plus", "Pro", "Max", "Ultra"])
  // Nothing until the plan is read, and nothing when it could not be, rather than a Free that may be wrong.
  expect(accountChip(signedIn).plan).toBeUndefined()
  expect(
    accountChip(signedIn, { ...codium("vector-50"), error: "Vector could not load your Codium balance." }).plan,
  ).toBeUndefined()
  expect(accountChip(signedIn, { ...codium(), signedIn: false }).plan).toBeUndefined()
})

test("a billing window tells every screen showing the plan to read it again", () => {
  const reads: string[] = []
  const stop = onCodiumChange(() => reads.push("chip"))
  codiumChanged()
  stop()
  codiumChanged()
  expect(reads).toEqual(["chip"])
})

test("the chip never loads a URL or a non-raster image, whatever the status carries", () => {
  for (const avatar of [
    "https://lh3.googleusercontent.com/a/photo",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/html;base64,PGh0bWw+",
    `${photo}"><script>`,
    "",
  ])
    expect(accountChip({ authenticated: true, pending: false, name: "Ada", avatar }).photo).toBeUndefined()
})
