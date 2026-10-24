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
  {
    chunk: 3,
    page: 3,
    text: `Method. Smart meters were read every fif${char(0xad)}teen minutes, of${char(0xfb01)}cially.`,
  },
]
const found = (quote: string) => ResearchQuote.found({ source: "S3", parts, quote })

describe("ResearchQuote.found", () => {
  test("finds a quote copied from the source, with its chunk and page", () => {
    expect(found("Delivered heating energy fell by 61 percent")).toEqual({
      ok: true,
      chunk: 2,
      page: 2,
      quote: "Delivered heating energy fell by 61 percent",
    })
  })

  test("compares after normalising spacing, curly quotes, dashes, ligatures and soft hyphens", () => {
    expect(found("The study   followed 412 homes through two winters")).toMatchObject({ ok: true, chunk: 1 })
    expect(found('61 percent - the "measured" figure')).toMatchObject({ ok: true, chunk: 2 })
    expect(found("read every fifteen minutes, officially")).toMatchObject({ ok: true, chunk: 3 })
    expect(found(`fell${char(0x200b)} by 61 percent`)).toMatchObject({ ok: true })
  })

  test("gives the source's own words for the quote, not the agent's copy", () => {
    expect(found("The study   followed 412 homes through two winters")).toMatchObject({
      quote: "The study followed 412 homes through two winters",
    })
    expect(found('61 percent - the "measured" figure')).toMatchObject({
      quote: `61 percent ${char(0x2014)} the “measured” figure`,
    })
    expect(found("read every fifteen minutes, officially")).toMatchObject({
      quote: `read every fifteen minutes, of${char(0xfb01)}cially`,
    })
    expect(found("through two winters. Results. Delivered")).toMatchObject({
      quote: "through two winters. Results. Delivered",
    })
    // An accent written apart from its letter stays with the letter that ends the quote.
    const cafe = [{ chunk: 1, text: `We sat in the cafe${char(0x0301)}, then left.` }]
    expect(ResearchQuote.found({ source: "S1", parts: cafe, quote: `We sat in the caf${char(0xe9)}` })).toMatchObject({
      ok: true,
      quote: `We sat in the caf${char(0xe9)}`,
    })
  })

  test("keeps superscripts and fractions, so a different number is not word for word", () => {
    const trial = [
      {
        chunk: 1,
        text: `The trial enrolled 10${char(0x2074)} patients and the dose was 5${char(0xd7)}10${char(0x207b, 0x2076)} mol per kg.`,
      },
      {
        chunk: 2,
        text: `Area grew to 3 km${char(0xb2)} by 2020. Efficacy was ${char(0xbd)} of placebo. CO${char(0x2082)} fell.`,
      },
    ]
    const quoted = (quote: string) => ResearchQuote.found({ source: "S2", parts: trial, quote })
    for (const quote of [
      "enrolled 104 patients and the dose",
      `dose was 5${char(0xd7)}10-6 mol per kg`,
      "Area grew to 3 km2 by 2020",
      `Efficacy was 1${char(0x2044)}2 of placebo`,
      "Efficacy was 1/2 of placebo",
    ])
      expect({ quote, ok: quoted(quote).ok }).toEqual({ quote, ok: false })
    // The source's own form passes, and a superscript written after a caret reads as one.
    expect(quoted(`enrolled 10${char(0x2074)} patients`)).toMatchObject({ ok: true, chunk: 1 })
    expect(quoted("enrolled 10^4 patients")).toMatchObject({ ok: true, quote: `enrolled 10${char(0x2074)} patients` })
    expect(quoted(`dose was 5${char(0xd7)}10^-6 mol per kg`)).toMatchObject({
      ok: true,
      quote: `dose was 5${char(0xd7)}10${char(0x207b, 0x2076)} mol per kg`,
    })
    expect(quoted(`Efficacy was ${char(0xbd)} of placebo`)).toMatchObject({ ok: true, chunk: 2 })
  })

  test("folds subscripts, so a source's subscript 2 copied as a plain 2 is word for word", () => {
    const climate = [
      {
        chunk: 1,
        text: `Global CO${char(0x2082)} emissions fell by 10${char(0x2074)} tonnes in 2024, and H${char(0x2082)}O use by half.`,
      },
    ]
    const quoted = (quote: string) => ResearchQuote.found({ source: "S4", parts: climate, quote })
    // The note keeps the source's own words for the quote.
    expect(quoted("CO2 emissions fell")).toEqual({ ok: true, chunk: 1, quote: `CO${char(0x2082)} emissions fell` })
    expect(quoted(`Global CO${char(0x2082)} emissions`)).toMatchObject({ ok: true })
    expect(quoted("CO2 emissions fell by 10^4 tonnes")).toMatchObject({
      ok: true,
      quote: `CO${char(0x2082)} emissions fell by 10${char(0x2074)} tonnes`,
    })
    expect(quoted("in 2024, and H2O use by half.")).toMatchObject({ ok: true })
    // A superscript still is not its digits.
    expect(quoted("CO2 emissions fell by 104 tonnes")).toMatchObject({ ok: false, reason: "missing" })
  })

  test("keeps case, so a quote with its capitals changed is not word for word", () => {
    expect(found("the study followed 412 HOMES through two winters")).toEqual({
      ok: false,
      reason: "missing",
      message: "That quote is not in S3. Copy the words from S3 chunk 1.",
    })
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

describe("ResearchQuote.passage", () => {
  test("finds the words around a quote that crosses a line break or a chunk, in the source's own words", () => {
    // The saved quote is the source's words with single spaces; the source itself has a line break inside it.
    const saved = found("The study followed 412 homes through two winters.")
    expect(saved).toMatchObject({ ok: true, quote: "The study followed 412 homes through two winters." })
    const quote = saved.ok ? saved.quote : ""
    expect(
      parts
        .map((part) => part.text)
        .join(" ")
        .indexOf(quote),
    ).toBe(-1)
    expect(ResearchQuote.passage({ parts, quote, around: 10 })).toBe(
      "ld study. The study followed 412 homes through two winters. Results.",
    )
    // Across chunks, the passage runs on into the next chunk's words.
    expect(ResearchQuote.passage({ parts, quote: "through two winters. Results. Delivered", around: 7 })).toBe(
      "homes through two winters. Results. Delivered heatin",
    )
    // Folded characters are mapped back to the source's own: its ligature stays, and its invisible soft hyphen is
    // cleaned out as the saved quote's is.
    expect(ResearchQuote.passage({ parts, quote: "every fifteen minutes, officially", around: 5 })).toBe(
      `read every fifteen minutes, of${char(0xfb01)}cially.`,
    )
    expect(ResearchQuote.passage({ parts, quote: "Something nobody ever wrote here", around: 400 })).toBeUndefined()
  })
})

describe("ResearchQuote.supports", () => {
  test("grades support: the quote has to state the claim, its values and its negations", () => {
    const quote =
      "Homes that replaced an oil boiler with an air-source heat pump used 61 percent less delivered energy for heating."
    expect(ResearchQuote.supports("Heat pump homes used 61 percent less delivered energy for heating", quote)).toBe(
      true,
    )
    // A different value is not support.
    expect(ResearchQuote.supports("Heat pump homes used 70 percent less delivered energy for heating", quote)).toBe(
      false,
    )
    // A claim the quote does not make is a paraphrase.
    expect(ResearchQuote.supports("Heat pumps pay for themselves within three years", quote)).toBe(false)
    // A "not" the quote does not have.
    expect(ResearchQuote.supports("Heat pump homes did not use less delivered energy", quote)).toBe(false)
  })

  test("made no connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})
