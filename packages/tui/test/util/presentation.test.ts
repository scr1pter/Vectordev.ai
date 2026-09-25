import { expect, test } from "bun:test"
import { sessionEpilogue } from "../../src/util/presentation"
import { logo } from "../../src/logo"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("vector -s ses_123")
  expect(Bun.stripANSI(epilogue).split("\n").slice(0, logo.left.length)).toEqual(
    logo.left.map((row, index) => `  ${row} ${logo.right[index]}`.replaceAll("_", " ").replace(/[~^]/g, "▀")),
  )
})
