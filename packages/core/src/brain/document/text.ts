export * as BrainText from "./text"

import type { Draft, Read } from "./read"

// Plain text, reStructuredText and AsciiDoc, read for their structure only: paragraphs, headings (underlined, `=`
// or `#` prefixed, ALL CAPS on a line of their own, or numbered "3.2 Retries"), lists, code and quotes.

const UNDERLINE = /^([=\-~^"'`#*+_:.])\1{2,}\s*$/
const PREFIXED = /^(={1,6}|#{1,6})\s+(\S.*?)\s*=*$/
const NUMBERED = /^(\d+(?:\.\d+)*)\.?\s+(\p{Lu}.*)$/u
const ITEM = /^(\s*)(?:[-*•+‣◦▪]|(\d+|[a-z])[.)])\s+(\S.*)$/
const FENCE = /^(`{3,}|~{3,}|-{4,}|\.{4,})\s*([\w+-]*)\s*$/

export function read(text: string): Read {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const drafts: Draft[] = []
  const styles: string[] = []
  const state = {
    paragraph: [] as string[],
    list: undefined as { ordered: boolean; items: { text: string; depth: number }[] } | undefined,
  }
  const flush = () => {
    // "Use this::" introduces a literal block and reads as "Use this:".
    if (state.paragraph.length > 0) drafts.push({ type: "paragraph", text: join(state.paragraph).replace(/::$/, ":") })
    if (state.list) drafts.push({ type: "list", ordered: state.list.ordered, items: state.list.items })
    state.paragraph = []
    state.list = undefined
  }
  const blank = (index: number) => index < 0 || index >= lines.length || !lines[index]!.trim()
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const trimmed = line.trim()
    if (!trimmed) {
      const literal = state.paragraph.at(-1)?.trimEnd().endsWith("::") ?? false
      flush()
      // reStructuredText: a paragraph ending in "::" introduces the indented block after it as code.
      const end = literal ? indentedEnd(lines, index + 1) : index + 1
      if (end > index + 1) {
        drafts.push({ type: "code", text: dedent(lines.slice(index + 1, end)) })
        index = end - 1
      }
      continue
    }
    const fence = trimmed.match(FENCE)
    if (fence && state.paragraph.length === 0) {
      // A delimiter with no partner is a rule between sections, not the start of code.
      const close = lines.findIndex((other, at) => at > index && other.trim() === fence[1])
      flush()
      if (close > 0)
        drafts.push({
          type: "code",
          text: lines.slice(index + 1, close).join("\n"),
          ...(fence[2] ? { language: fence[2] } : {}),
        })
      index = close > 0 ? close : index
      continue
    }
    const next = lines[index + 1]?.trim() ?? ""
    // An over- and underlined title: the same punctuation line on both sides.
    if (
      UNDERLINE.test(trimmed) &&
      lines[index + 2]?.trim() === trimmed &&
      next &&
      !UNDERLINE.test(next) &&
      state.paragraph.length === 0
    ) {
      flush()
      drafts.push({ type: "heading", level: level(styles, `over${trimmed[0]}`), text: next })
      index += 2
      continue
    }
    if (
      next &&
      UNDERLINE.test(next) &&
      state.paragraph.length === 0 &&
      !ITEM.test(line) &&
      next.length >= Math.min(trimmed.length, 3)
    ) {
      flush()
      drafts.push({ type: "heading", level: level(styles, next[0]!), text: trimmed })
      index++
      continue
    }
    const prefixed = trimmed.match(PREFIXED)
    if (prefixed && state.paragraph.length === 0) {
      flush()
      drafts.push({ type: "heading", level: prefixed[1]!.length, text: prefixed[2]! })
      continue
    }
    const standalone = state.paragraph.length === 0 && blank(index - 1)
    const numbered = trimmed.match(NUMBERED)
    if (
      standalone &&
      numbered &&
      trimmed.length <= 120 &&
      !/[.:;,]$/.test(trimmed) &&
      (blank(index + 1) || !ITEM.test(lines[index + 1]!))
    ) {
      flush()
      drafts.push({ type: "heading", level: numbered[1]!.split(".").length, text: trimmed })
      continue
    }
    if (standalone && blank(index + 1) && caps(trimmed)) {
      flush()
      drafts.push({ type: "heading", level: 1, text: trimmed })
      continue
    }
    if (trimmed.startsWith(">")) {
      const end = lines.findIndex((other, at) => at > index && !other.trim().startsWith(">"))
      const stop = end < 0 ? lines.length : end
      flush()
      drafts.push({
        type: "quote",
        text: join(lines.slice(index, stop).map((other) => other.trim().replace(/^>\s?/, ""))),
      })
      index = stop - 1
      continue
    }
    const item = line.match(ITEM)
    if (item && state.paragraph.length === 0) {
      const ordered = item[2] !== undefined
      if (state.list && state.list.ordered !== ordered && item[1]!.length === 0) flush()
      state.list ??= { ordered, items: [] }
      state.list.items.push({ text: item[3]!, depth: Math.floor(item[1]!.replace(/\t/g, "  ").length / 2) })
      continue
    }
    if (state.list && /^\s+\S/.test(line)) {
      const last = state.list.items.at(-1)!
      state.list.items[state.list.items.length - 1] = { ...last, text: join([last.text, trimmed]) }
      continue
    }
    if (state.list) flush()
    // An indented block after a blank line is code, as in Markdown and reStructuredText.
    if (state.paragraph.length === 0 && blank(index - 1) && /^(?: {4}|\t)/.test(line)) {
      const end = indentedEnd(lines, index)
      drafts.push({ type: "code", text: dedent(lines.slice(index, end)) })
      index = end - 1
      continue
    }
    state.paragraph.push(trimmed)
  }
  flush()
  return { type: "read", format: "text", drafts }
}

// Each underline style gets the next level the first time it is seen, which is how reStructuredText assigns them.
function level(styles: string[], style: string) {
  if (!styles.includes(style)) styles.push(style)
  return Math.min(6, styles.indexOf(style) + 1)
}

function caps(line: string) {
  const letters = line.replace(/[^\p{L}]/gu, "")
  return (
    line.length <= 80 &&
    letters.length >= 3 &&
    letters === letters.toUpperCase() &&
    /\p{Lu}/u.test(letters) &&
    !/[.:;,]$/.test(line)
  )
}

function indentedEnd(lines: readonly string[], from: number) {
  const end = lines.findIndex((line, at) => at >= from && line.trim() !== "" && !/^(?: {2,}|\t)/.test(line))
  const stop = end < 0 ? lines.length : end
  // Trailing blank lines belong to what follows.
  return lines.slice(from, stop).findLastIndex((line) => line.trim() !== "") + from + 1
}

function dedent(lines: readonly string[]) {
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)![0].length))
  return lines.map((line) => line.slice(indent)).join("\n")
}

/** Hard-wrapped lines as one paragraph, joining a word a line break hyphenated. */
export function join(lines: readonly string[]) {
  return lines.reduce((out, line) => {
    if (!out) return line
    if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(line)) return `${out.slice(0, -1)}${line}`
    return `${out} ${line}`
  }, "")
}
