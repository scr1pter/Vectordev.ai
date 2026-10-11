import { expect, test } from "bun:test"
import { sanitizeTerminalText, sessionEpilogue } from "../../src/util/presentation"
import { logo } from "../../src/logo"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("vector -s ses_123")
  expect(Bun.stripANSI(epilogue).split("\n").slice(0, logo.left.length)).toEqual(
    logo.left.map((row, index) => `  ${row} ${logo.right[index]}`.replaceAll("_", " ").replace(/[~^]/g, "▀")),
  )
})

test("removes ANSI, OSC, controls and bidi overrides from terminal epilogues", () => {
  const hostile = "safe\x1b]0;owned\x07\x1b[31mred\x1b[0m\nnext\u202egpj.exe"
  const clean = sanitizeTerminalText(hostile)
  const epilogue = sessionEpilogue({ title: hostile, sessionID: "ses_1\x1b]52;c;secret\x07\r--flag" })

  expect(clean).toBe("saferednextgpj.exe")
  expect(Bun.stripANSI(epilogue)).not.toContain("\x1b]")
  expect(Bun.stripANSI(epilogue)).not.toContain("\u202e")
  expect(Bun.stripANSI(epilogue)).not.toContain("\nnext")
  expect(Bun.stripANSI(epilogue)).toContain("ses_1--flag")
})
