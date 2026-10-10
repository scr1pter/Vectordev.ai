import { describe, expect, test } from "bun:test"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { codiumActions } from "./codium-error"

const status = { authenticated: false, pending: false }
const fixture = (account = true) => {
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
          }
        : undefined,
    },
  }
}

describe("codiumActions", () => {
  test("out of credits offers Buy credits, which opens the purchase page", () => {
    const app = fixture()
    const [buy, ...rest] = codiumActions("credits", app.platform)
    expect(rest).toEqual([])
    expect(buy?.label).toBe("Buy credits")
    buy?.onClick()
    expect(app.calls).toEqual([`open ${ModelPlanStatus.PURCHASE_URL}`])
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
