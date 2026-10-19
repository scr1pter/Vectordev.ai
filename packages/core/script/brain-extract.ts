#!/usr/bin/env bun
// What Vector would learn from a document, read on this computer with nothing stored:
//   bun packages/core/script/brain-extract.ts <file> [--json]
import path from "node:path"
import { BrainExtract } from "../src/brain/extract"
import { BrainLimits } from "../src/brain/document/limits"
import { BrainDocument } from "../src/brain/document/read"
import { BrainStructure } from "../src/brain/structure"

const file = process.argv.slice(2).find((arg) => !arg.startsWith("--"))
if (!file) {
  console.error("Usage: bun packages/core/script/brain-extract.ts <file> [--json]")
  process.exit(2)
}
const name = path.basename(file)
const extracted = await BrainDocument.read(
  { name, bytes: new Uint8Array(await Bun.file(file).arrayBuffer()) },
  BrainLimits.LIMITS.worker,
)
if (extracted.type === "refused") {
  console.error(`${name}: ${extracted.message}`)
  process.exit(1)
}
const place = {
  repository: "dry-run",
  lineage: name.toLowerCase(),
  document: "dry-run",
  limits: BrainLimits.LIMITS.worker,
}
const structured = BrainStructure.structure(extracted, place)
const extraction = BrainExtract.extract(extracted, structured, place)
const warnings = [...new Set([...extracted.warnings, ...structured.warnings, ...extraction.warnings])]
const kinds = Object.entries(Object.groupBy(extraction.records, (record) => record.kind)).map(
  ([kind, records]) => `${records?.length ?? 0} ${kind}`,
)

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        document: {
          name,
          title: extracted.title,
          format: extracted.format,
          pages: extracted.pages,
          unread: extracted.unread,
          warnings,
          hold: structured.hold,
          links: extracted.links,
        },
        sections: structured.sections.map((section) => ({
          ordinal: section.ordinal,
          path: section.path || section.heading,
          kind: section.kind,
          pages: section.pageStart === undefined ? undefined : [section.pageStart, section.pageEnd],
          tokens: section.tokens,
        })),
        passages: structured.passages.map((passage) => ({
          id: passage.id,
          header: passage.header,
          tokens: passage.tokens,
          hold: passage.hold,
          body: passage.body,
        })),
        records: extraction.records.map((record) => ({
          id: record.id,
          kind: record.kind,
          rule: record.rule,
          card: record.card,
          page: record.page,
          confidence: record.confidence,
          hold: record.hold,
          subject: record.subject,
          fields: record.fields,
          quote: record.quote,
        })),
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

console.log(
  `${extracted.title} (${extracted.format}${extracted.pages ? `, ${extracted.pages} ${extracted.pages === 1 ? "page" : "pages"}` : ""})`,
)
console.log(
  `${structured.sections.length} sections, ${structured.passages.length} passages, ${extraction.records.length} records${kinds.length ? ` (${kinds.join(", ")})` : ""}`,
)
if (extracted.unread.length > 0) console.log(`Pages without text (scanned): ${extracted.unread.join(", ")}`)
if (structured.held > 0)
  console.log(
    `${structured.held} passages held for review${structured.hold ? `; the whole document is held (${structured.hold})` : ""}`,
  )
if (warnings.length > 0) console.log(`Warnings: ${warnings.join(", ")}`)
for (const record of extraction.records)
  console.log(
    `[${record.id}] ${record.kind}${record.page ? ` p.${record.page}` : ""}${record.hold ? " (held)" : ""}: ${record.card}`,
  )
