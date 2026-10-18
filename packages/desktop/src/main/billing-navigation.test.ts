import { expect, test } from "bun:test"
import { billingNavigation, billingReturn, billingTitle } from "./billing-navigation"

const site = "https://vectordev.ai"

test("Stripe's return to the account page says how billing ended", () => {
  expect(billingReturn(`${site}/account?model_plan=success`, site)).toBe("completed")
  expect(billingReturn(`${site}/account?model_topup=success`, site)).toBe("completed")
  // A plan change or cancellation finished in the portal.
  expect(billingReturn(`${site}/account?model_plan=updated`, site)).toBe("completed")
  expect(billingReturn(`${site}/account?model_plan=ending`, site)).toBe("completed")
  expect(billingReturn(`${site}/account?model_plan=cancelled`, site)).toBe("cancelled")
  expect(billingReturn(`${site}/account?model_topup=cancelled`, site)).toBe("cancelled")
  // The portal's own link back.
  expect(billingReturn(`${site}/account`, site)).toBe("closed")
  expect(billingReturn(`${site}/account/`, site)).toBe("closed")
  expect(billingReturn(`${site}/account?model_plan=other`, site)).toBe("closed")
})

test("other pages of the site open in the browser, and other sites are not taken for it", () => {
  expect(billingReturn(`${site}/legal/privacy`, site)).toBe("external")
  expect(billingReturn(`${site}/codium?model_plan=success`, site)).toBe("external")
  for (const url of [
    "https://vectordev.ai.evil.example/account?model_plan=success",
    "http://vectordev.ai/account?model_plan=success",
    "https://checkout.stripe.com/c/pay/cs_fixture",
    "not a url",
  ])
    expect(billingReturn(url, site)).toBeUndefined()
})

test("the window stays on Stripe, sends other https pages to the browser and refuses anything else", () => {
  for (const url of [
    "https://checkout.stripe.com/c/pay/cs_fixture",
    "https://billing.stripe.com/p/session/fixture",
    "https://hooks.stripe.com/3d_secure_2/hosted",
    "https://invoice.stripe.com/i/acct_fixture",
    "https://m.stripe.network/inner.html",
  ])
    expect(billingNavigation(url)).toBe("allow")
  for (const url of [
    "https://stripe.com.evil.example/c/pay",
    "https://evilstripe.com/",
    "https://www.example.com/terms",
  ])
    expect(billingNavigation(url)).toBe("external")
  for (const url of [
    "http://checkout.stripe.com/c/pay",
    "https://user:secret@checkout.stripe.com/c/pay",
    "javascript:alert(1)",
    "file:///etc/hosts",
    "vector://auth/callback",
    "not a url",
  ])
    expect(billingNavigation(url)).toBe("block")
})

test("the title names the page's host, since the window has no address bar", () => {
  expect(billingTitle("https://checkout.stripe.com/c/pay/cs_fixture#secret")).toBe(
    "Vector Codium billing: checkout.stripe.com",
  )
  expect(billingTitle("not a url")).toBe("Vector Codium billing")
})
