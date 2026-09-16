import { describe, expect, test } from "bun:test"
import {
  fingerprint,
  fnv1a64,
  normalizeCode,
  normalizeTitle,
  titleSimilarity,
} from "@opencode-ai/core/review/fingerprint"

// A BigInt FNV-1a 64 to check the 32-bit-halves implementation against.
function reference(text: string) {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  return hash.toString(16).padStart(16, "0")
}

describe("fnv1a64", () => {
  test("matches the published FNV-1a 64 test vectors", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325")
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c")
    expect(fnv1a64("foobar")).toBe("85944171f73967e8")
  })

  test("hashes UTF-8 bytes, the same as a BigInt implementation", () => {
    for (const text of ["café", "日本語", "line\nbreak\ttab", "x".repeat(5_000), "🙂 emoji"])
      expect(fnv1a64(text)).toBe(reference(text))
  })
})

describe("normalizeTitle", () => {
  test("lowercases, drops stopwords and punctuation, keeps unique tokens sorted", () => {
    expect(normalizeTitle("Refresh can restore a session after logout")).toEqual([
      "logout",
      "refresh",
      "restore",
      "session",
    ])
    expect(normalizeTitle("`rotate()` writes the TOKEN; token!")).toEqual(["rotate", "token", "writes"])
  })

  test("keeps the first 8 tokens", () => {
    expect(normalizeTitle("alpha bravo charlie delta echo foxtrot golf hotel india juliet")).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
    ])
  })

  test("keeps letters and digits outside ASCII", () => {
    expect(normalizeTitle("Überprüfung fehlt für UTF8")).toEqual(["fehlt", "für", "utf8", "überprüfung"])
  })
})

describe("normalizeCode", () => {
  test("trims each line, collapses whitespace and drops blank lines", () => {
    expect(normalizeCode("  if (x)   {\r\n\n    return   1\n  }\n")).toBe("if (x) {\nreturn 1\n}")
  })
})

describe("fingerprint", () => {
  const code = "    await this.store.write(next)"
  const id = fingerprint("src/auth/refresh.ts", "bug", normalizeTitle("Logout races refresh"), normalizeCode(code))

  test("is 12 hex characters", () => {
    expect(id).toMatch(/^[0-9a-f]{12}$/)
  })

  test("is stable when lines shift or are re-indented, since line numbers are not part of it", () => {
    const moved = normalizeCode("\t\tawait   this.store.write(next)\n")
    expect(fingerprint("src/auth/refresh.ts", "bug", normalizeTitle("Logout races refresh"), moved)).toBe(id)
  })

  test("is stable when the title's words are reordered", () => {
    expect(
      fingerprint("src/auth/refresh.ts", "bug", normalizeTitle("Refresh races logout!"), normalizeCode(code)),
    ).toBe(id)
  })

  test("changes when the code, the path or the category changes", () => {
    const title = normalizeTitle("Logout races refresh")
    expect(fingerprint("src/auth/refresh.ts", "bug", title, normalizeCode("await this.store.write(prev)"))).not.toBe(id)
    expect(fingerprint("src/auth/client.ts", "bug", title, normalizeCode(code))).not.toBe(id)
    expect(fingerprint("src/auth/refresh.ts", "reliability", title, normalizeCode(code))).not.toBe(id)
  })
})

describe("titleSimilarity", () => {
  test("is the token Jaccard of normalized titles", () => {
    // {logout, refresh, restore, session} and {logout, race, rotation, token} share one of seven tokens.
    expect(
      titleSimilarity("Refresh can restore a session after logout", "Race between token rotation and logout"),
    ).toBeCloseTo(1 / 7, 5)
    expect(titleSimilarity("Token stored before validation", "token STORED before validation")).toBe(1)
    expect(titleSimilarity("alpha", "bravo")).toBe(0)
    expect(titleSimilarity("", "anything")).toBe(0)
  })

  test("accepts normalized token lists, such as a marker's t= words", () => {
    expect(titleSimilarity(["logout", "refresh"], "Refresh after logout")).toBe(1)
    expect(titleSimilarity(["logout", "refresh"], ["logout", "session"])).toBeCloseTo(1 / 3, 5)
  })
})
