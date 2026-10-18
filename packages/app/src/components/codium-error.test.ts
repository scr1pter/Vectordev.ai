import { describe, expect, test } from "bun:test"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { codiumActions, codiumErrorText } from "./codium-error"

const status = { authenticated: false, pending: false }
const fixture = (account = true, billing = false) => {
  const calls: string[] = []
  return {
    calls,
    platform: {
      openLink: (url: string) => void calls.push(`open ${url}`),
      vectorAccount: account
        ? {
            status: async () => status,
            start: async () => {
              calls.push("sign in")
              return status
            },
            cancel: async () => status,
            logout: async () => status,
            onChange: () => () => {},
            ...(billing ? { billing: async () => ({ outcome: "closed" as const }) } : {}),
          }
        : undefined,
    },
  }
}

describe("codiumActions", () => {
  test("out of credits offers Buy credits, which stays in Vector where the desktop can bill", () => {
    const app = fixture(true, true)
    const [buy, ...rest] = codiumActions("credits", app.platform, () => app.calls.push("purchase"))
    expect(rest).toEqual([])
    expect(buy?.label).toBe("Buy credits")
    buy?.onClick()
    expect(app.calls).toEqual(["purchase"])
  })

  test("without the desktop's billing, Buy credits opens the purchase page", () => {
    for (const app of [fixture(true, false), fixture(false)]) {
      const [buy] = codiumActions("credits", app.platform, () => app.calls.push("purchase"))
      buy?.onClick()
      expect(app.calls).toEqual([`open ${ModelPlanStatus.PURCHASE_URL}`])
    }
  })

  test("a lost sign-in offers Sign in to Vector where the app can sign in", () => {
    const app = fixture()
    const [signIn] = codiumActions("sign-in", app.platform)
    expect(signIn?.label).toBe("Sign in to Vector")
    signIn?.onClick()
    expect(app.calls).toEqual(["sign in"])
    expect(codiumActions("sign-in", fixture(false).platform)).toEqual([])
  })

  test("Codium being unavailable needs no button: the person chooses another model", () => {
    expect(codiumActions("unavailable", fixture().platform)).toEqual([])
  })
})

describe("codiumErrorText", () => {
  const text = `Your Codium credits are used up. Buy credits at ${ModelPlanStatus.PURCHASE_URL}`
  test("drops the website link where the app sells credits itself", () => {
    expect(codiumErrorText(text, fixture(true, true).platform)).toBe("Your Codium credits are used up.")
  })

  test("keeps it where the app cannot bill", () => {
    expect(codiumErrorText(text, fixture(true, false).platform)).toBe(text)
    expect(codiumErrorText(text, fixture(false).platform)).toBe(text)
  })
})
