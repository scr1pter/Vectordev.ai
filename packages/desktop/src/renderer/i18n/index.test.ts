import { expect, test } from "bun:test"

// The renderer as Electron loads it, with a German language saved by an older Vector that had a language picker.
const reads: unknown[][] = []
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    api: {
      storeGet: async (...args: unknown[]) => {
        reads.push(args)
        return "de"
      },
    },
  },
})
const renderer = await import("./index")
const { detectLocale, t } = renderer

test("a saved language never reaches the native dialog titles; they follow the computer", async () => {
  // Renderers before 1.99.109 applied the saved language in an initI18n step at startup. Nothing that runs at startup
  // may read it now, so the test runs that step if it ever comes back.
  await (renderer as { initI18n?: () => Promise<unknown> }).initI18n?.()
  expect(reads).toEqual([])
  // Bun reports no navigator language, which reads as an English computer.
  expect(t("desktop.dialog.chooseFolder")).toBe("Choose a folder")
  expect(t("desktop.dialog.chooseFile")).toBe("Choose a file")
})

test("the computer's first supported language picks the locale", () => {
  expect(detectLocale(["de-DE", "en-US"])).toBe("de")
  expect(detectLocale(["zh-Hant-TW"])).toBe("zht")
  expect(detectLocale(["pt-BR"])).toBe("br")
  expect(detectLocale(["xx-YY", "fr-CA"])).toBe("fr")
  expect(detectLocale([undefined])).toBe("en")
  expect(detectLocale([])).toBe("en")
})
