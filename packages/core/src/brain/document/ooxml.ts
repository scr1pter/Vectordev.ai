export * as BrainOoxml from "./ooxml"

import { Inflate } from "fflate"
import { Parser } from "htmlparser2"
import type { BrainSchema } from "../schema"
import { budget, refuse, type BrainLimits } from "./limits"
import type { Draft, Read, ReadRefusal } from "./read"

// Word, PowerPoint and Excel files are zip archives of XML parts. The archive's own directory is parsed here, and each
// part this reader knows is inflated in small steps, counting what comes out: a part past 32 MB, a file past 128 MB,
// a part inflating more than 100 times its size, more than 5,000 entries, XML deeper than 256 or past 2 million nodes,
// and reading stops. Nothing the archive says about sizes is trusted. Macros, embedded objects, media and external
// relationships are never read or fetched. The XML parser decodes only XML's predefined entities and character
// references; a DTD is never expanded, so no entity can grow or reach outside the file.

type Entry = {
  readonly name: string
  readonly method: number
  readonly flags: number
  readonly compressed: number
  readonly offset: number
}

type Archive = { readonly bytes: Uint8Array; readonly entries: ReadonlyMap<string, Entry> }

type Counters = { readonly inflated: BrainLimits.Budget; readonly nodes: BrainLimits.Budget }

type Office = "docx" | "pptx" | "xlsx"

const MAIN: Record<Office, string> = {
  docx: "word/document.xml",
  pptx: "ppt/presentation.xml",
  xlsx: "xl/workbook.xml",
}

const BREACH = refuse("too-large", "This Office file expands to more than Vector reads safely, so it was not read.")

/** Which Office format a zip is, from the parts it holds: undefined for any other archive. */
export function kind(bytes: Uint8Array, limits: BrainLimits.Limits): Office | "encrypted" | "invalid" | undefined {
  const archive = open(bytes, limits)
  if (archive === "invalid") return "invalid"
  if ([...archive.entries.values()].some((entry) => (entry.flags & 1) === 1)) return "encrypted"
  if (!archive.entries.has("[Content_Types].xml")) return undefined
  return (Object.keys(MAIN) as Office[]).find((format) => archive.entries.has(MAIN[format]))
}

export function read(format: Office, bytes: Uint8Array, limits: BrainLimits.Limits): Read | ReadRefusal {
  const archive = open(bytes, limits)
  if (archive === "invalid") return refuse("invalid", "This Office file is damaged or too large to read safely.")
  const counters = { inflated: budget(limits.zip.total), nodes: budget(limits.xml.nodes) }
  const warnings = new Set<BrainSchema.DocumentWarning>()
  if ([...archive.entries.keys()].some((name) => /vbaProject\.bin$/i.test(name))) warnings.add("macros-ignored")
  const result =
    format === "docx"
      ? docx(archive, limits, counters)
      : format === "pptx"
        ? pptx(archive, limits, counters)
        : xlsx(archive, limits, counters)
  if (result === "breach") return BREACH
  if (result === "invalid") return refuse("invalid", "This Office file is damaged or too large to read safely.")
  const title = core(archive, limits, counters)
  if (title === "breach") return BREACH
  for (const warning of result.warnings) warnings.add(warning)
  return {
    type: "read",
    format,
    ...(title ? { title } : {}),
    ...(result.pages === undefined ? {} : { pages: result.pages }),
    drafts: result.drafts,
    links: result.links,
    warnings: [...warnings],
  }
}

type Result = {
  readonly drafts: readonly Draft[]
  readonly links: readonly string[]
  readonly pages?: number
  readonly warnings: readonly BrainSchema.DocumentWarning[]
}

// --- Word -----------------------------------------------------------------------------------------------------------

type Style = {
  readonly name: string
  readonly outline?: number
  readonly basedOn?: string
  readonly mono: boolean
  readonly numId?: string
  readonly ilvl?: number
}

const MONO = /courier|consolas|menlo|monaco|mono|lucida console|source code|fira code|inconsolata/i

// Elements whose text is not the document's current text: deletions, field instructions, earlier versions of
// properties, and the fallback copy of content shown in a choice.
const SKIP = new Set([
  "w:del",
  "w:delText",
  "w:instrText",
  "w:pPrChange",
  "w:rPrChange",
  "w:sectPrChange",
  "w:tblPrChange",
  "w:trPrChange",
  "w:tcPrChange",
  "mc:Fallback",
  "w:moveFrom",
])

function docx(archive: Archive, limits: BrainLimits.Limits, counters: Counters): Result | "breach" | "invalid" {
  const styles = new Map<string, Style>()
  const styled = xml(archive, "word/styles.xml", limits, counters, (events) => {
    const current = {
      id: "",
      name: "",
      outline: undefined as number | undefined,
      basedOn: undefined as string | undefined,
      mono: false,
      numId: undefined as string | undefined,
      ilvl: undefined as number | undefined,
    }
    events.open = (name, attributes) => {
      if (name === "w:style")
        Object.assign(current, {
          id: attributes["w:styleId"] ?? "",
          name: "",
          outline: undefined,
          basedOn: undefined,
          mono: false,
          numId: undefined,
          ilvl: undefined,
        })
      if (name === "w:name") current.name = attributes["w:val"] ?? ""
      if (name === "w:basedOn") current.basedOn = attributes["w:val"]
      if (name === "w:outlineLvl") current.outline = Number(attributes["w:val"])
      if (name === "w:rFonts" && MONO.test(attributes["w:ascii"] ?? attributes["w:hAnsi"] ?? "")) current.mono = true
      if (name === "w:numId") current.numId = attributes["w:val"]
      if (name === "w:ilvl") current.ilvl = Number(attributes["w:val"])
    }
    events.close = (name) => {
      if (name === "w:style" && current.id) styles.set(current.id, { ...current })
    }
  })
  if (styled === "breach") return styled
  const formats = numbering(archive, limits, counters)
  if (formats === "breach") return formats
  const relations = rels(archive, "word/_rels/document.xml.rels", limits, counters)
  if (relations === "breach") return relations
  const resolved = (id: string | undefined, seen = 0): Style | undefined => {
    const style = id ? styles.get(id) : undefined
    if (!style || seen > 10) return style
    const parent = resolved(style.basedOn, seen + 1)
    return parent
      ? {
          ...style,
          outline: style.outline ?? parent.outline,
          mono: style.mono || parent.mono,
          numId: style.numId ?? parent.numId,
          ilvl: style.ilvl ?? parent.ilvl,
        }
      : style
  }
  const body = words(archive, "word/document.xml", limits, counters, resolved, formats)
  if (body === "breach" || body === "invalid") return body
  const notes = archive.entries.has("word/footnotes.xml")
    ? words(archive, "word/footnotes.xml", limits, counters, resolved, formats)
    : undefined
  if (notes === "breach") return notes
  // Where a footnote prints is not recorded in the file, so footnotes carry no page.
  const footnotes = notes && notes !== "invalid" ? notes.drafts.map((draft) => ({ ...draft, page: undefined })) : []
  return {
    drafts: [
      ...body.drafts,
      ...(footnotes.length > 0 ? [{ type: "heading" as const, level: 1, text: "Footnotes" }, ...footnotes] : []),
    ],
    links: relations.links,
    pages: body.pages,
    warnings: relations.external ? ["external-links"] : [],
  }
}

type Paragraph = {
  style?: string
  outline?: number
  numId?: string
  ilvl?: number
  text: string
  code: string[]
  run: string
  dropped: boolean
  white: boolean
  chars: number
  mono: number
  page: number
}

function words(
  archive: Archive,
  part: string,
  limits: BrainLimits.Limits,
  counters: Counters,
  style: (id: string | undefined) => Style | undefined,
  formats: ReadonlyMap<string, ReadonlyMap<number, string>>,
) {
  const drafts: Draft[] = []
  const state = {
    page: 1,
    paragraphs: [] as Paragraph[],
    run: { vanish: false, white: false, mono: false },
    skip: 0,
    /** Hidden text in a paragraph with nothing else in it, which flags the block after it. */
    carry: false,
    tables: [] as { rows: string[][]; row: string[] | undefined; cell: string[] | undefined; hidden: boolean }[],
  }
  // Consecutive list items are one list, and consecutive code lines one block, gathered here until the run ends.
  const run = {
    list: undefined as
      | {
          ordered: boolean
          hidden: boolean
          page?: number
          items: { text: string; depth: number; code?: readonly string[] }[]
        }
      | undefined,
    code: undefined as { hidden: boolean; page?: number; lines: string[] } | undefined,
  }
  const close = () => {
    if (run.list)
      drafts.push({
        type: "list",
        ordered: run.list.ordered,
        items: run.list.items,
        page: run.list.page,
        ...(run.list.hidden ? { hidden: true } : {}),
      })
    if (run.code)
      drafts.push({
        type: "code",
        text: run.code.lines.join("\n"),
        page: run.code.page,
        ...(run.code.hidden ? { hidden: true } : {}),
      })
    run.list = undefined
    run.code = undefined
  }
  const emit = (draft: Draft) => {
    const hidden = draft.hidden === true
    if (draft.type === "list" && run.list?.ordered === draft.ordered && run.list.hidden === hidden)
      return run.list.items.push(...draft.items)
    if (draft.type === "code" && run.code?.hidden === hidden) return run.code.lines.push(draft.text)
    close()
    if (draft.type === "list") run.list = { ordered: draft.ordered, hidden, page: draft.page, items: [...draft.items] }
    else if (draft.type === "code") run.code = { hidden, page: draft.page, lines: [draft.text] }
    else drafts.push(draft)
  }
  const finish = (paragraph: Paragraph) => {
    const text = paragraph.text.replace(/[ \t]+/g, " ").trim()
    const hidden = paragraph.dropped || paragraph.white
    const table = state.tables.at(-1)
    if (table?.cell) {
      if (text) table.cell.push(text)
      if (hidden) table.hidden = true
      return
    }
    if (!text) {
      // A paragraph whose only text was hidden still flags the block that follows.
      if (hidden) state.carry = true
      return
    }
    const resolved = style(paragraph.style)
    const name = resolved?.name ?? ""
    const outline = paragraph.outline ?? resolved?.outline
    const heading = /^heading\s*([1-9])$/i.exec(name)?.[1]
    const numId = paragraph.numId ?? resolved?.numId
    const flagged = hidden || state.carry ? { hidden: true } : {}
    state.carry = false
    const base = { page: paragraph.page, ...flagged }
    if (/^title$/i.test(name) || heading || (outline !== undefined && outline < 9))
      return emit({
        ...base,
        type: "heading",
        level: heading ? Number(heading) : /^title$/i.test(name) ? 1 : outline! + 1,
        text,
      })
    if (numId && numId !== "0") {
      const level = paragraph.ilvl ?? resolved?.ilvl ?? 0
      const format = formats.get(numId)?.get(level) ?? "bullet"
      return emit({
        ...base,
        type: "list",
        ordered: format !== "bullet" && format !== "none",
        items: [{ text, depth: level, code: paragraph.code.map((code) => code.trim()).filter(Boolean) }],
      })
    }
    if (
      /code|source|preformatted|plain text|macro/i.test(name) ||
      resolved?.mono ||
      (paragraph.chars > 0 && paragraph.mono / paragraph.chars >= 0.9)
    )
      return emit({ ...base, type: "code", text: paragraph.text.replace(/\s+$/, "") })
    if (/quote|block text/i.test(name)) return emit({ ...base, type: "quote", text })
    emit({ ...base, type: "paragraph", text, code: paragraph.code.map((code) => code.trim()).filter(Boolean) })
  }
  const parsed = xml(archive, part, limits, counters, (events) => {
    events.open = (name, attributes) => {
      if (SKIP.has(name) || state.skip > 0) {
        state.skip++
        return
      }
      const paragraph = state.paragraphs.at(-1)
      if (name === "w:p")
        state.paragraphs.push({
          text: "",
          code: [],
          run: "",
          dropped: false,
          white: false,
          chars: 0,
          mono: 0,
          page: state.page,
        })
      if (name === "w:r") state.run = { vanish: false, white: false, mono: false }
      if (name === "w:pStyle" && paragraph) paragraph.style = attributes["w:val"]
      if (name === "w:outlineLvl" && paragraph) paragraph.outline = Number(attributes["w:val"])
      if (name === "w:numId" && paragraph) paragraph.numId = attributes["w:val"]
      if (name === "w:ilvl" && paragraph) paragraph.ilvl = Number(attributes["w:val"])
      if ((name === "w:vanish" || name === "w:specVanish") && !/^(?:0|false|off)$/i.test(attributes["w:val"] ?? ""))
        state.run.vanish = true
      // Under 2 pt (sizes are in half-points) is unreadable, the same rule as for PDF text.
      if (name === "w:sz" && Number(attributes["w:val"]) < 4) state.run.vanish = true
      if (name === "w:color" && /^(?:ffffff|white)$/i.test(attributes["w:val"] ?? "")) state.run.white = true
      if (name === "w:rFonts" && MONO.test(attributes["w:ascii"] ?? attributes["w:hAnsi"] ?? "")) state.run.mono = true
      if (name === "w:rStyle" && (style(attributes["w:val"])?.mono || /code|verbatim/i.test(attributes["w:val"] ?? "")))
        state.run.mono = true
      if (paragraph && (name === "w:tab" || name === "w:br" || name === "w:cr") && !state.run.vanish) {
        if (name === "w:br" && attributes["w:type"] === "page") state.page++
        paragraph.text += name === "w:tab" ? "\t" : "\n"
      }
      if (name === "w:noBreakHyphen" && paragraph) paragraph.text += "-"
      if (name === "w:lastRenderedPageBreak") {
        state.page++
        // A break before any of a paragraph's text means the paragraph starts on the new page.
        if (paragraph && !paragraph.text.trim()) paragraph.page = state.page
      }
      if (name === "w:tbl") state.tables.push({ rows: [], row: undefined, cell: undefined, hidden: false })
      const table = state.tables.at(-1)
      if (name === "w:tr" && table) table.row = []
      if (name === "w:tc" && table) table.cell = []
    }
    events.text = (text, open) => {
      const paragraph = state.paragraphs.at(-1)
      if (state.skip > 0 || !paragraph || open !== "w:t") return
      if (state.run.vanish) {
        if (text.trim()) paragraph.dropped = true
        return
      }
      if (state.run.white && text.trim()) paragraph.white = true
      paragraph.text += text
      paragraph.chars += text.trim().length
      if (state.run.mono) {
        paragraph.mono += text.trim().length
        paragraph.run += text
      }
    }
    events.close = (name) => {
      if (state.skip > 0) {
        state.skip--
        return
      }
      const paragraph = state.paragraphs.at(-1)
      if (name === "w:r" && paragraph && paragraph.run) {
        paragraph.code.push(paragraph.run)
        paragraph.run = ""
      }
      if (name === "w:p" && paragraph) finish(state.paragraphs.pop()!)
      const table = state.tables.at(-1)
      if (name === "w:tc" && table?.row && table.cell) {
        table.row.push(table.cell.join(" "))
        table.cell = undefined
      }
      if (name === "w:tr" && table?.row) {
        table.rows.push(table.row)
        table.row = undefined
      }
      if (name === "w:tbl" && table) {
        state.tables.pop()
        const outer = state.tables.at(-1)
        // A table inside a cell reads as that cell's text.
        if (outer?.cell) {
          outer.cell.push(table.rows.map((row) => row.join(" ")).join(" "))
          return
        }
        const header = table.rows[0] ?? []
        const draft: Draft = {
          type: "table",
          header,
          rows: table.rows.slice(1),
          confidence: 1,
          page: state.page,
          ...(table.hidden ? { hidden: true } : {}),
        }
        if (table.rows.length > 0) emit(draft)
      }
    }
  })
  if (parsed === "breach") return parsed
  if (parsed === "missing") return "invalid" as const
  close()
  return { drafts, pages: state.page }
}

function numbering(archive: Archive, limits: BrainLimits.Limits, counters: Counters) {
  const abstract = new Map<string, Map<number, string>>()
  const nums = new Map<string, string>()
  const state = { abstract: "", level: 0, num: "" }
  const parsed = xml(archive, "word/numbering.xml", limits, counters, (events) => {
    events.open = (name, attributes) => {
      if (name === "w:abstractNum") {
        state.abstract = attributes["w:abstractNumId"] ?? ""
        abstract.set(state.abstract, new Map())
      }
      if (name === "w:lvl") state.level = Number(attributes["w:ilvl"] ?? 0)
      if (name === "w:numFmt" && state.abstract)
        abstract.get(state.abstract)?.set(state.level, attributes["w:val"] ?? "bullet")
      if (name === "w:num") state.num = attributes["w:numId"] ?? ""
      if (name === "w:abstractNumId" && state.num) nums.set(state.num, attributes["w:val"] ?? "")
    }
    events.close = (name) => {
      if (name === "w:abstractNum") state.abstract = ""
      if (name === "w:num") state.num = ""
    }
  })
  if (parsed === "breach") return parsed
  return new Map([...nums].map(([num, id]) => [num, abstract.get(id) ?? new Map<number, string>()]))
}

// --- PowerPoint -----------------------------------------------------------------------------------------------------

function pptx(archive: Archive, limits: BrainLimits.Limits, counters: Counters): Result | "breach" | "invalid" {
  const ids: string[] = []
  const listed = xml(archive, "ppt/presentation.xml", limits, counters, (events) => {
    events.open = (name, attributes) => {
      if (name === "p:sldId" && attributes["r:id"]) ids.push(attributes["r:id"])
    }
  })
  if (listed === "breach") return listed
  const relations = rels(archive, "ppt/_rels/presentation.xml.rels", limits, counters)
  if (relations === "breach") return relations
  const slides = ids
    .map((id) => relations.targets.get(id))
    .filter((target): target is string => !!target && /^ppt\/slides\/[^/]+\.xml$/.test(target))
  const drafts: Draft[] = []
  const links: string[] = []
  const warnings = new Set<BrainSchema.DocumentWarning>(relations.external ? ["external-links"] : [])
  if (slides.length > limits.slides) warnings.add("truncated")
  for (const [index, path] of slides.slice(0, limits.slides).entries()) {
    const number = index + 1
    const slide = shapes(archive, path, limits, counters, "slide")
    if (slide === "breach") return slide
    const slideRels = rels(archive, path.replace(/([^/]+)$/, "_rels/$1.rels"), limits, counters)
    if (slideRels === "breach") return slideRels
    if (slideRels.external) warnings.add("external-links")
    links.push(...slideRels.links)
    const notesPath = [...slideRels.types].find(([, type]) => type.endsWith("/notesSlide"))?.[0]
    const notesTarget = notesPath ? slideRels.targets.get(notesPath) : undefined
    const notes =
      notesTarget && /^ppt\/notesSlides\/[^/]+\.xml$/.test(notesTarget)
        ? shapes(archive, notesTarget, limits, counters, "notes")
        : undefined
    if (notes === "breach") return notes
    const hidden = slide.hidden ? { hidden: true } : {}
    drafts.push({
      type: "heading",
      level: 1,
      text: slide.title || `Slide ${number}`,
      section: "slide",
      page: number,
      ...hidden,
    })
    drafts.push(...slide.drafts.map((draft) => ({ ...draft, page: number, ...hidden })))
    const spoken = notes
      ? notes.drafts
          .map((draft) =>
            draft.type === "list"
              ? draft.items.map((item) => item.text).join("\n")
              : draft.type === "table"
                ? ""
                : draft.text,
          )
          .filter(Boolean)
          .join("\n")
      : ""
    if (spoken) drafts.push({ type: "quote", text: spoken, page: number, ...hidden })
  }
  return {
    drafts,
    links: [...relations.links, ...links],
    pages: Math.min(slides.length, limits.slides),
    warnings: [...warnings],
  }
}

// The text frames of a slide or its notes: the title placeholder's text, then each other frame's paragraphs (bulleted
// ones as lists) and tables. Date, footer, slide-number and slide-image placeholders are left out.
function shapes(archive: Archive, path: string, limits: BrainLimits.Limits, counters: Counters, of: "slide" | "notes") {
  const drafts: Draft[] = []
  const state = {
    title: "",
    hidden: false,
    placeholder: undefined as string | undefined,
    paragraph: undefined as { text: string; level: number; bullet: boolean | undefined; ordered: boolean } | undefined,
    list: undefined as { ordered: boolean; items: { text: string; depth: number }[] } | undefined,
    table: undefined as { rows: string[][]; row: string[] | undefined; cell: string | undefined } | undefined,
  }
  const add = (paragraph: NonNullable<typeof state.paragraph>) => {
    const text = paragraph.text.replace(/[ \t]+/g, " ").trim()
    if (!text) return
    if (state.table?.cell !== undefined) {
      state.table.cell = `${state.table.cell} ${text}`.trim()
      return
    }
    if (state.placeholder === "title" || state.placeholder === "ctrTitle") {
      state.title = `${state.title} ${text}`.trim()
      return
    }
    if (["dt", "ftr", "sldNum", "sldImg", "hdr"].includes(state.placeholder ?? "")) return
    const bullet = paragraph.bullet ?? (of === "slide" && ["body", "obj", ""].includes(state.placeholder ?? "-"))
    if (bullet && state.list?.ordered === paragraph.ordered)
      return state.list.items.push({ text, depth: paragraph.level })
    if (state.list) drafts.push({ type: "list", ordered: state.list.ordered, items: state.list.items })
    state.list = bullet ? { ordered: paragraph.ordered, items: [{ text, depth: paragraph.level }] } : undefined
    if (!bullet) drafts.push({ type: "paragraph", text })
  }
  const parsed = xml(archive, path, limits, counters, (events) => {
    events.open = (name, attributes) => {
      if (name === "p:sld" && attributes.show === "0") state.hidden = true
      if (name === "p:sp") state.placeholder = undefined
      if (name === "p:ph") state.placeholder = attributes.type ?? ""
      if (name === "a:p") state.paragraph = { text: "", level: 0, bullet: undefined, ordered: false }
      if (name === "a:pPr" && state.paragraph) state.paragraph.level = Number(attributes.lvl ?? 0)
      if (name === "a:buNone" && state.paragraph) state.paragraph.bullet = false
      if (name === "a:buChar" && state.paragraph) state.paragraph.bullet = true
      if (name === "a:buAutoNum" && state.paragraph) Object.assign(state.paragraph, { bullet: true, ordered: true })
      if (name === "a:br" && state.paragraph) state.paragraph.text += "\n"
      if (name === "a:tbl") state.table = { rows: [], row: undefined, cell: undefined }
      if (name === "a:tr" && state.table) state.table.row = []
      if (name === "a:tc" && state.table) state.table.cell = ""
    }
    events.text = (text, open) => {
      if (open === "a:t" && state.paragraph) state.paragraph.text += text
    }
    events.close = (name) => {
      if (name === "a:p" && state.paragraph) {
        add(state.paragraph)
        state.paragraph = undefined
      }
      if (name === "p:sp") state.placeholder = undefined
      if (name === "a:tc" && state.table?.row) {
        state.table.row.push(state.table.cell ?? "")
        state.table.cell = undefined
      }
      if (name === "a:tr" && state.table?.row) {
        state.table.rows.push(state.table.row)
        state.table.row = undefined
      }
      if (name === "a:tbl" && state.table) {
        if (state.list) drafts.push({ type: "list", ordered: state.list.ordered, items: state.list.items })
        state.list = undefined
        if (state.table.rows.length > 0)
          drafts.push({ type: "table", header: state.table.rows[0]!, rows: state.table.rows.slice(1), confidence: 1 })
        state.table = undefined
      }
    }
  })
  if (parsed === "breach") return parsed
  if (state.list) drafts.push({ type: "list", ordered: state.list.ordered, items: state.list.items })
  return { title: state.title, hidden: state.hidden, drafts }
}

// --- Excel ----------------------------------------------------------------------------------------------------------

function xlsx(archive: Archive, limits: BrainLimits.Limits, counters: Counters): Result | "breach" | "invalid" {
  const sheets: { name: string; id: string; hidden: boolean }[] = []
  const listed = xml(archive, "xl/workbook.xml", limits, counters, (events) => {
    events.open = (name, attributes) => {
      if (name === "sheet")
        sheets.push({
          name: attributes.name ?? "Sheet",
          id: attributes["r:id"] ?? "",
          hidden: /hidden/i.test(attributes.state ?? ""),
        })
    }
  })
  if (listed === "breach") return listed
  const relations = rels(archive, "xl/_rels/workbook.xml.rels", limits, counters)
  if (relations === "breach") return relations
  const strings: string[] = []
  const shared = { text: "", phonetic: 0, open: false }
  const loaded = xml(archive, "xl/sharedStrings.xml", limits, counters, (events) => {
    events.open = (name) => {
      if (name === "si") Object.assign(shared, { text: "", open: true })
      if (name === "rPh") shared.phonetic++
    }
    events.text = (text, open) => {
      if (shared.open && open === "t" && shared.phonetic === 0) shared.text += text
    }
    events.close = (name) => {
      if (name === "rPh") shared.phonetic--
      if (name === "si") {
        strings.push(shared.text.slice(0, limits.cell))
        shared.open = false
      }
    }
  })
  if (loaded === "breach") return loaded
  const drafts: Draft[] = []
  const warnings = new Set<BrainSchema.DocumentWarning>(relations.external ? ["external-links"] : [])
  if (sheets.length > limits.sheets) warnings.add("truncated")
  for (const sheet of sheets.slice(0, limits.sheets)) {
    const path = relations.targets.get(sheet.id)
    if (!path || !/^xl\/worksheets\/[^/]+\.xml$/.test(path)) continue
    const rows: { number: number; cells: string[] }[] = []
    const state = {
      row: undefined as { number: number; cells: string[] } | undefined,
      column: 0,
      type: "",
      value: "",
      inline: "",
      hiddenRows: false,
      extra: 0,
    }
    const parsed = xml(archive, path, limits, counters, (events) => {
      events.open = (name, attributes) => {
        if (name === "row") {
          state.row = { number: Number(attributes.r ?? rows.length + 1), cells: [] }
          if (attributes.hidden === "1" || attributes.hidden === "true") state.hiddenRows = true
        }
        if (name === "c")
          Object.assign(state, {
            column: column(attributes.r ?? "", state.row?.cells.length ?? 0),
            type: attributes.t ?? "n",
            value: "",
            inline: "",
          })
      }
      events.text = (text, open) => {
        if (open === "v") state.value += text
        if (open === "t") state.inline += text
      }
      events.close = (name) => {
        if (name === "c" && state.row && state.column < limits.columns) {
          const value =
            state.type === "s"
              ? (strings[Number(state.value)] ?? "")
              : state.type === "inlineStr"
                ? state.inline
                : state.type === "b"
                  ? state.value === "1"
                    ? "TRUE"
                    : "FALSE"
                  : state.value
          state.row.cells[state.column] = value.slice(0, limits.cell)
        }
        if (name === "row" && state.row) {
          const cells = Array.from(state.row.cells, (cell) => cell ?? "")
          if (cells.some((cell) => cell.trim())) {
            if (rows.length < limits.rows + 1) rows.push({ number: state.row.number, cells })
            else state.extra++
          }
          state.row = undefined
        }
      }
    })
    if (parsed === "breach") return parsed
    if (state.extra > 0 || rows.length > limits.rows) warnings.add("truncated")
    const hidden = sheet.hidden || state.hiddenRows ? { hidden: true } : {}
    drafts.push({
      type: "heading",
      level: 1,
      text: sheet.name,
      section: "sheet",
      ...(sheet.hidden ? { hidden: true } : {}),
    })
    if (rows.length === 0) continue
    const first = rows[0]!.cells
    const header =
      rows.length > 1 &&
      first.every((cell) => !cell.trim() || !/^[-+]?[\d.,]+%?$/.test(cell.trim())) &&
      first.some((cell) => cell.trim())
        ? first
        : undefined
    const body = rows.slice(header ? 1 : 0, (header ? 1 : 0) + limits.rows)
    drafts.push({
      type: "table",
      header: header ?? [],
      rows: body.map((row) => row.cells),
      confidence: 1,
      refs: body.map((row) => `${sheet.name}!${row.number}`),
      ...hidden,
    })
  }
  return { drafts, links: relations.links, warnings: [...warnings] }
}

function column(reference: string, fallback: number) {
  const letters = reference.match(/^[A-Z]+/)?.[0]
  if (!letters) return fallback
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1
}

// --- Parts ----------------------------------------------------------------------------------------------------------

function core(archive: Archive, limits: BrainLimits.Limits, counters: Counters) {
  const state = { title: "" }
  const parsed = xml(archive, "docProps/core.xml", limits, counters, (events) => {
    events.text = (text, open) => {
      if (open === "dc:title") state.title += text
    }
  })
  if (parsed === "breach") return parsed
  return state.title.trim() || undefined
}

// A part's relationships: internal targets by id, resolved against the part's folder, and external ones, which are
// recorded as links when they are hyperlinks and otherwise only noted. None is ever fetched.
function rels(archive: Archive, path: string, limits: BrainLimits.Limits, counters: Counters) {
  const targets = new Map<string, string>()
  const types = new Map<string, string>()
  const links: string[] = []
  const state = { external: false }
  const folder = path.replace(/_rels\/[^/]+$/, "")
  const parsed = xml(archive, path, limits, counters, (events) => {
    events.open = (name, attributes) => {
      if (name !== "Relationship" || !attributes.Id || !attributes.Target) return
      types.set(attributes.Id, attributes.Type ?? "")
      if (attributes.TargetMode === "External") {
        if ((attributes.Type ?? "").endsWith("/hyperlink")) links.push(attributes.Target)
        else state.external = true
        return
      }
      targets.set(
        attributes.Id,
        normalize(attributes.Target.startsWith("/") ? attributes.Target.slice(1) : `${folder}${attributes.Target}`),
      )
    }
  })
  if (parsed === "breach") return parsed
  return { targets, types, links, external: state.external }
}

function normalize(path: string) {
  return path
    .split("/")
    .reduce<string[]>(
      (parts, part) => (part === ".." ? parts.slice(0, -1) : part === "." || part === "" ? parts : [...parts, part]),
      [],
    )
    .join("/")
}

type Events = {
  open?: (name: string, attributes: Record<string, string>) => void
  text?: (text: string, open: string | undefined) => void
  close?: (name: string) => void
}

/**
 * Streams one XML part through the event handlers set up by `setup`. "missing" when the archive has no such part.
 * Depth and node count are checked as the parser goes, and the part is fed in pieces so a breach stops it early.
 */
function xml(
  archive: Archive,
  path: string,
  limits: BrainLimits.Limits,
  counters: Counters,
  setup: (events: Events) => void,
): "ok" | "missing" | "breach" {
  const entry = archive.entries.get(path)
  if (!entry) return "missing"
  const bytes = inflate(archive.bytes, entry, limits, counters.inflated)
  if (bytes === "breach") return "breach"
  if (bytes === "invalid") return "missing"
  const events: Events = {}
  setup(events)
  const stack: string[] = []
  const state = { breach: false }
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        stack.push(name)
        if (stack.length > limits.xml.depth || !counters.nodes.take(1)) state.breach = true
        if (!state.breach) events.open?.(name, attributes)
      },
      ontext(text) {
        if (!state.breach) events.text?.(text, stack.at(-1))
      },
      onclosetag(name) {
        stack.pop()
        if (!state.breach) events.close?.(name)
      },
    },
    { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true },
  )
  const text = decode(bytes)
  for (let at = 0; at < text.length && !state.breach; at += 65_536) parser.write(text.slice(at, at + 65_536))
  if (!state.breach) parser.end()
  return state.breach ? "breach" : "ok"
}

function decode(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2))
  return new TextDecoder("utf-8").decode(bytes)
}

// --- Zip ------------------------------------------------------------------------------------------------------------

/** The archive's central directory, read entry by entry: never more than `entries` of them, every offset bounds-checked. */
function open(bytes: Uint8Array, limits: BrainLimits.Limits): Archive | "invalid" {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const floor = Math.max(0, bytes.length - 22 - 65_535)
  const end = Array.from(
    { length: Math.max(0, bytes.length - 22 - floor + 1) },
    (_, index) => bytes.length - 22 - index,
  ).find((at) => view.getUint32(at, true) === 0x06054b50)
  if (end === undefined) return "invalid"
  const size = view.getUint32(end + 12, true)
  const start = view.getUint32(end + 16, true)
  // Zip64 marks its sizes as all ones; no document this reader takes is that large.
  if (start === 0xffffffff || size === 0xffffffff || start + size > end) return "invalid"
  const entries = new Map<string, Entry>()
  const names = new TextDecoder("utf-8")
  for (let at = start, count = 0; at < start + size; count++) {
    if (count >= limits.zip.entries || at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
      return "invalid"
    const length = view.getUint16(at + 28, true)
    const extra = view.getUint16(at + 30, true)
    const comment = view.getUint16(at + 32, true)
    if (at + 46 + length > bytes.length) return "invalid"
    const name = names.decode(bytes.subarray(at + 46, at + 46 + length))
    entries.set(name, {
      name,
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      compressed: view.getUint32(at + 20, true),
      offset: view.getUint32(at + 42, true),
    })
    at += 46 + length + extra + comment
  }
  return { bytes, entries }
}

/**
 * One entry's bytes, inflated 4 KB of input at a time. After each step the part's and the file's inflated totals and
 * the part's ratio are checked, so a bomb stops within a few megabytes of the first limit it crosses.
 */
function inflate(
  bytes: Uint8Array,
  entry: Entry,
  limits: BrainLimits.Limits,
  total: BrainLimits.Budget,
): Uint8Array | "breach" | "invalid" {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== 0x04034b50) return "invalid"
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
  const data = bytes.subarray(start, Math.min(bytes.length, start + entry.compressed))
  if (entry.method === 0) {
    if (data.length > limits.zip.part || !total.take(data.length)) return "breach"
    return data
  }
  if (entry.method !== 8) return "invalid"
  const chunks: Uint8Array[] = []
  const state = { size: 0, breach: false, done: false }
  const inflater = new Inflate((chunk, final) => {
    state.size += chunk.length
    if (state.size > limits.zip.part || !total.take(chunk.length)) state.breach = true
    if (!state.breach) chunks.push(chunk)
    if (final) state.done = true
  })
  // fflate reports a corrupt stream by throwing.
  try {
    for (let at = 0; at < data.length && !state.breach && !state.done; at += 4_096) {
      inflater.push(data.subarray(at, at + 4_096), at + 4_096 >= data.length)
      if (state.size > limits.zip.grace && state.size > limits.zip.ratio * Math.min(data.length, at + 4_096))
        state.breach = true
    }
  } catch {
    return "invalid"
  }
  if (state.breach) return "breach"
  const out = new Uint8Array(state.size)
  chunks.reduce((offset, chunk) => {
    out.set(chunk, offset)
    return offset + chunk.length
  }, 0)
  return out
}
