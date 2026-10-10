import { describe, expect, test } from "bun:test"
import { sizeLimitBytes, sizeLimitText } from "./supabase-limits"

describe("bucket size limit field", () => {
  test("an untouched field keeps the exact limit, even one that is not whole MB", () => {
    expect(sizeLimitText(1_000_000)).toBe("0.95")
    expect(sizeLimitBytes("0.95", 1_000_000)).toEqual({ ok: true, value: undefined })
    expect(sizeLimitBytes("", undefined)).toEqual({ ok: true, value: undefined })
  })

  test("only an empty field clears the limit, and a typo is refused instead", () => {
    expect(sizeLimitBytes("", 5 * 1024 * 1024)).toEqual({ ok: true, value: null })
    for (const typo of ["5MB", "0", "-1", "abc"]) {
      expect(sizeLimitBytes(typo, 5 * 1024 * 1024)).toMatchObject({
        ok: false,
        error: expect.stringContaining("is not a size limit"),
      })
    }
  })

  test("a new value is sent in bytes", () => {
    expect(sizeLimitBytes(" 2 ", 5 * 1024 * 1024)).toEqual({ ok: true, value: 2 * 1024 * 1024 })
    expect(sizeLimitBytes("0.5")).toEqual({ ok: true, value: 512 * 1024 })
  })
})
