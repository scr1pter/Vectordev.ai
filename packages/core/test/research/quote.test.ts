import { describe, expect, test } from "bun:test"
import { ResearchQuote } from "../../src/research/quote"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()
const char = (...codes: number[]) => String.fromCodePoint(...codes)

const parts: ResearchQuote.Part[] = [
  { chunk: 1, page: 1, text: "Heat pump field study.\nThe study followed 412 homes\nthrough two winters." },
  {
    chunk: 2,
    page: 2,
    text: `Results. Delivered heating energy fell by 61 percent ${char(0x2014)} the “measured” figure at the meter.`,
  },
  { chunk: 3, page: 3, text: `Method. Smart meters were read every fif${char(0xad)}teen minutes, of${char(0xfb01)}cially.` },
]
const found = (quote: string) => ResearchQuote.found({ source: "S3", parts, quote })

describe("ResearchQuote.found", () => {
  test("finds a quote copied from the source, with its chunk and page", () => {
    expect(found("Delivered heating energy fell by 61 percent")).toEqual({ ok: true, chunk: 2, page: 2 })
  })

  test("compares after normalising spacing, case, curly quotes, dashes, ligatures and soft hyphens", () => {
    expect(found("the study   followed 412 HOMES through two winters")).toMatchObject({ ok: true, chunk: 1 })
    expect(found('61 percent - the "measured" figure')).toMatchObject({ ok: true, chunk: 2 })
    expect(found("read every fifteen minutes, officially")).toMatchObject({ ok: true, chunk: 3 })
    expect(found(`fell${char(0x200b)} by 61 percent`)).toMatchObject({ ok: true })
  })

  test("finds a quote that runs from one chunk into the next", () => {
    expect(found("through two winters. Results. Delivered")).toMatchObject({ ok: true, chunk: 1 })
  })

  test("refuses a quote that is not in the source, and points at the chunk with its words", () => {
    expect(found("Delivered heating energy fell by 70 percent")).toEqual({
      ok: false,
      reason: "missing",
      message: "That quote is not in S3. Copy the words from S3 chunk 2.",
    })
    expect(found("Something nobody ever wrote here")).toEqual({
      ok: false,
      reason: "missing",
      message: "That quote is not in S3. Copy the words from S3.",
    })
  })

  test("refuses quotes under 12 characters, counted after normalising", () => {
    expect(found("412 homes")).toEqual({ ok: false, reason: "short", message: ResearchQuote.SHORT })
    expect(found("   61    percent   ")).toMatchObject({ ok: false, reason: "short" })
  })
})

describe("ResearchQuote.supports", () => {
  test("grades support: the quote has to state the claim, its values and its negations", () => {
    const quote = "Homes that replaced an oil boiler with an air-source heat pump used 61 percent less delivered energy for heating."
    expect(ResearchQuote.supports("Heat pump homes used 61 percent less delivered energy for heating", quote)).toBe(true)
    // A different value is not support.
    expect(ResearchQuote.supports("Heat pump homes used 70 percent less delivered energy for heating", quote)).toBe(false)
    // A claim the quote does not make is a paraphrase.
    expect(ResearchQuote.supports("Heat pumps pay for themselves within three years", quote)).toBe(false)
    // A "not" the quote does not have.
    expect(ResearchQuote.supports("Heat pump homes did not use less delivered energy", quote)).toBe(false)
  })

  test("made no connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})
