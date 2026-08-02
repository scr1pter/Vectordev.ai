import { expect, test } from "bun:test"

import { normalizeDeployUrl } from "./publish-url"

test("normalizes deployment links copied from structured CLI output", () => {
  expect(normalizeDeployUrl('{"url":"https://vector-demo.vercel.app","ready":true}')).toBe(
    "https://vector-demo.vercel.app/",
  )
  expect(normalizeDeployUrl('Deploy URL: "https://vector-demo.netlify.app",')).toBe(
    "https://vector-demo.netlify.app/",
  )
})

test("rejects missing and unsafe deployment links", () => {
  expect(normalizeDeployUrl()).toBeUndefined()
  expect(normalizeDeployUrl("javascript:alert(1)")).toBeUndefined()
})
