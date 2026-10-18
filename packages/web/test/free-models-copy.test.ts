import { expect, test } from "bun:test"
import { REVIEWED_FREE_ENDPOINTS } from "../../core/src/free-model-catalog"
import {
  FREE_MODELS_DATA_POLICY,
  FREE_MODELS_OWN_KEYS,
  FREE_MODELS_SHARED_COPY,
  FREE_MODELS_SIGN_IN,
  FREE_MODELS_UNAVAILABLE,
} from "../../core/src/free-model-choice"
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

test("site copy never says every free-model request asks not to train, which stops being true from 1.99.109", async () => {
  // The verifier's medium of 18 October 2026: the home page and the investor page said every included free-model
  // request asks providers not to train. From desktop 1.99.109, a model labelled "May train on your prompts" is sent,
  // after the user accepts once, with data collection allowed. The copy must hold before and after that release.
  const blanket = [
    /\b(?:every|all|each)\b[^.;]*\b(?:free[- ]models?|included)\b[^.;]*\b(?:not to train|not (?:be )?used for training|deny data collection)/i,
    /\bevery (?:included )?free[- ]model request\b/i,
  ]
  const sources = [
    ...(await Array.fromAsync(
      new Bun.Glob("packages/web/src/{pages,components,data}/**/*.{astro,ts,tsx}").scan({ cwd: root }),
    )),
    "README.md",
  ]
  const found = await Promise.all(
    sources.map(async (file) =>
      (await Bun.file(root + file).text())
        .replace(/\s+/g, " ")
        .split(/(?<=[.;])\s/)
        .filter((sentence) => blanket.some((pattern) => pattern.test(sentence)))
        .map((sentence) => `${file}: ${sentence.trim().slice(0, 160)}`),
    ),
  )
  expect(found.flat()).toEqual([])
  // What replaced them says which models ask not to train, and that the others wait for the acceptance.
  for (const file of ["packages/web/src/components/Lander.astro", "packages/web/src/pages/investors.astro"]) {
    const text = (await Bun.file(root + file).text()).replace(/\s+/g, " ")
    expect(text).toContain("free models whose providers don't train ask")
    expect(text).toMatch(
      /May train on your prompts.? (?:and )?(?:are )?sent only after (?:you accept|the user accepts) that once/,
    )
  }
})

test("the free-model flow never tells anyone to connect an OpenRouter account of their own", async () => {
  // The owner's decision of 17 October 2026: "i want it so that the vector app is connected to my openrouter account
  // no matter who uses the free models". Free models run on Vector's shared allowance for every signed-in account;
  // connecting OpenRouter stays an ordinary provider in Settings → Providers, where its own connect flow describes it.
  const flow = [
    "packages/app/src/components/prompt-input/free-model-start.tsx",
    "packages/app/src/components/free-models-card.tsx",
    "packages/app/src/components/free-models-limit.tsx",
    "packages/app/src/pages/layout-new.tsx",
    "packages/app/src/features/onboarding/spotlight-steps.ts",
    "packages/app/src/i18n/en.ts",
    "packages/app/src/utils/server-errors.ts",
    "packages/session-ui/src/components/session-turn.tsx",
    "packages/tui/src/component/dialog-free-models-limit.tsx",
    "packages/tui/src/routes/home.tsx",
    "packages/tui/src/routes/session/index.tsx",
    "packages/tui/src/util/error.ts",
    "packages/core/src/free-models.ts",
    "packages/core/src/free-model-request.ts",
    "packages/core/src/session/free-model-resume.ts",
    "packages/engine/src/session/prompt.ts",
    "api/_lib/free-models-catalog.ts",
    "api/_lib/free-models-chat.ts",
    "packages/web/src/pages/docs/models.astro",
    "packages/web/src/pages/docs/terminal-agent.astro",
    "packages/web/src/data/docs-nav.ts",
    "packages/web/src/components/Lander.astro",
  ]
  const promotion = [
    /\bconnect (?:your own )?(?:free )?openrouter\b/i,
    // "Vector's own OpenRouter account" is the shared allowance; the user's is the one never to promote.
    /\b(?:your|their) own (?:free )?openrouter account\b/i,
    /\bstart free with (?:your own )?openrouter\b/i,
    /\bcontinue free with\b/i,
    /--provider openrouter --method/i,
  ]
  const found = await Promise.all(
    flow.map(async (file) =>
      (await Bun.file(root + file).text())
        .replace(/\s+/g, " ")
        .split(/(?<=[.;"`])\s/)
        .filter((sentence) => promotion.some((pattern) => pattern.test(sentence)))
        .map((sentence) => `${file}: ${sentence.trim().slice(0, 160)}`),
    ),
  )
  expect(found.flat()).toEqual([])
  // The core copy the flow shows, read from the module rather than its source, which also keeps the connect flow's.
  for (const text of [FREE_MODELS_SIGN_IN, FREE_MODELS_SHARED_COPY, FREE_MODELS_OWN_KEYS, FREE_MODELS_UNAVAILABLE])
    expect(promotion.some((pattern) => pattern.test(text))).toBe(false)
})
