import { expect, test } from "bun:test"
import { REVIEWED_FREE_ENDPOINTS } from "../../core/src/free-model-catalog"
import { FREE_MODELS_DATA_POLICY } from "../../core/src/free-model-choice"
import { NO_TRAINING_RETENTION } from "../../schema/src/free-model"

const root = new URL("../../../", import.meta.url).pathname
// Blanket claims that no free model, endpoint or provider is zero data retention.
const blanket = [/\bnone of (?:these|the|them)\b[^.;]*\bzero data retention\b/i, /\bnot zero data retention\b/i]

test("free-model copy never says none of the providers keeps no data while the record shows one that does", async () => {
  // Phala's endpoint for Xing4.0 is on OpenRouter's zero data retention list, so "none of these providers is a zero
  // data retention service" is false. The copy may say Vector does not request it, not that no provider offers it.
  const retentionFree = [...REVIEWED_FREE_ENDPOINTS].flatMap(([model, providers]) =>
    Object.entries(providers)
      .filter(([, entry]) => /^No prompt retention\b/i.test(entry.retention))
      .map(([provider]) => `${model} (${provider})`),
  )
  expect(retentionFree).toContain("xingchen-agi/xing4.0-29b-a4b:free (phala)")
  const sources = [
    ...(await Array.fromAsync(
      new Bun.Glob("packages/web/src/{pages,components,data}/**/*.{astro,ts,tsx}").scan({ cwd: root }),
    )),
    "docs/vector/FREE-MODELS.md",
    "docs/vector/owner-actions/free-models-legal.md",
  ]
  const copy = [
    ...(await Promise.all(sources.map(async (file) => ({ file, text: await Bun.file(root + file).text() })))),
    { file: "FREE_MODELS_DATA_POLICY", text: FREE_MODELS_DATA_POLICY },
    { file: "NO_TRAINING_RETENTION", text: NO_TRAINING_RETENTION },
  ]
  expect(
    copy.flatMap((source) =>
      // Joined lines, since the site wraps sentences across lines.
      source.text
        .replace(/\s+/g, " ")
        .split(/(?<=[.;])\s/)
        .filter((sentence) => blanket.some((pattern) => pattern.test(sentence)))
        .map((sentence) => `${source.file}: ${sentence.trim().slice(0, 140)}`),
    ),
  ).toEqual([])
})
