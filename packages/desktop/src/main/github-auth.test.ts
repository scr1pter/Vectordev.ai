import { expect, test } from "bun:test"
import { deviceLoginScope } from "./github-auth"

test("GitHub sign-in asks for the workflow permission only when automatic reviews need it", () => {
  expect(deviceLoginScope()).toBe("repo")
  expect(deviceLoginScope({ workflow: false })).toBe("repo")
  expect(deviceLoginScope({ workflow: true })).toBe("repo workflow")
})
