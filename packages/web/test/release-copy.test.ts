import { expect, test } from "bun:test"
import { publishedDesktopVersion, release199, upcomingRelease } from "../src/data/vector-releases"

// GitHub release v1.99.99 shipped on 2026-10-04 with every installer and the in-app update feeds,
// so no later edit may present it, or anything before it, as upcoming.
const shipped = "1.99.99"
const web = new URL("..", import.meta.url).pathname
const noAccountDownload = "https://github.com/scr1pter/Vectordev.ai/releases/latest"

// Phrasings that called 1.99.99 unpublished or said Vector cannot update itself.
const stale = [
  /\b(cannot|can't|do not|don't) update (themselves|itself)\b/i,
  /\b(upcoming|next release)\W+1\.99\.99\b/i,
  /\b1\.99\.99,? the next (desktop )?release\b/i,
  /\b1\.99\.99 installers are not published\b/i,
  /\bnot published yet\b[^.]*\b1\.99\.(8|99)\b/i,
  /\b(remain|are still)( at)? (desktop )?\**1\.99\.8\b/i,
  /\bcurrently (published|downloadable)\b[^.]*\b1\.99\.[78]\b/i,
  /\bno standalone CLI release is published\b/i,
]

const sources = await Promise.all(
  [
    ...(await Array.fromAsync(new Bun.Glob("src/{pages,components,data}/**/*.{astro,ts,tsx}").scan({ cwd: web }))),
    "../../README.md",
  ].map(async (file) => ({ file, text: await Bun.file(`${web}${file}`).text() })),
)

test("the site marks 1.99.99 as the published desktop release", () => {
  expect(Bun.semver.order(publishedDesktopVersion, shipped)).toBeGreaterThanOrEqual(0)
  expect(
    release199
      .filter((release) => release.availability && Bun.semver.order(release.version, publishedDesktopVersion) <= 0)
      .map((release) => release.version),
  ).toEqual([])
  // The unversioned Upcoming card leads /releases and the docs changelog; a version number there reads as upcoming.
  expect(upcomingRelease.summary).not.toMatch(/\b\d+\.\d+\.\d+\b/)
})

test("website and README copy no longer call 1.99.99 unpublished or say Vector cannot update itself", () => {
  expect(
    sources.flatMap((source) =>
      source.text
        .split("\n")
        .filter((line) => stale.some((pattern) => pattern.test(line)))
        .map((line) => `${source.file}: ${line.trim().slice(0, 120)}`),
    ),
  ).toEqual([])
})

test("release notes contain no unfinished placeholders", async () => {
  // The draft release job copies changelog.json word for word into the GitHub release notes, and the desktop's
  // What's new dialog reads it from vectordev.ai, which deploys from main before any desktop release ships.
  const notes = [
    ...sources.filter((source) => source.file.startsWith("src/data/")),
    { file: "public/changelog.json", text: await Bun.file(`${web}public/changelog.json`).text() },
  ]
  expect(
    notes.flatMap((source) =>
      (source.text.match(/\w*PLACEHOLDER\w*|\bTODO\b|\bTBD\b|\bFIXME\b|\bXXX\b/g) ?? []).map(
        (match) => `${source.file}: ${match}`,
      ),
    ),
  ).toEqual([])
})

test("copy does not hard-code which release is current", () => {
  // Releases ship on their own schedules, so "currently 1.99.99" goes stale without anyone touching the page.
  expect(
    sources
      .filter((source) =>
        /\bcurrently,? (the )?(CLI |desktop |npm )?v?\d+\.\d+\.\d+/i.test(source.text.replace(/\s+/g, " ")),
      )
      .map((source) => source.file),
  ).toEqual([])
})

test("Check for Updates is named only as the macOS menu item", () => {
  // Windows and Linux have no Check for Updates control (they use Check now in Settings → Updates & about),
  // so an unqualified "update with Check for Updates" sends them looking for a button that does not exist.
  // Shipped release notes under src/data keep the wording they were published with.
  expect(
    sources
      .filter((source) => !source.file.startsWith("src/data/"))
      .flatMap((source) =>
        source.text
          .replace(/\s+/g, " ")
          .split(/(?<=[.;])\s/)
          .filter((sentence) => sentence.includes("Check for Updates") && !sentence.includes("macOS"))
          .map((sentence) => `${source.file}: ${sentence.slice(0, 120)}`),
      ),
  ).toEqual([])
})

test("the download page points installed copies at Check for Updates and offers a no-account download", async () => {
  const download = await Bun.file(`${web}src/components/marketing/download/FreeDownload.tsx`).text()
  expect(download).toContain("Check for Updates")
  expect(download).toContain("Updates & about")
  expect(download).toContain(`href="${noAccountDownload}"`)
  expect(await Bun.file(`${web}src/pages/docs/install.astro`).text()).toContain(`href="${noAccountDownload}"`)
})

test("visitors without an account reach the GitHub installers from the footer and the sign-in page", async () => {
  // /download and the footer's platform links send anonymous visitors to /login, so the no-account route
  // has to be visible there rather than only on the signed-in download panel.
  expect(await Bun.file(`${web}src/components/marketing/SiteFooter.astro`).text()).toContain(
    `["All installers (GitHub)", "${noAccountDownload}"]`,
  )
  expect(await Bun.file(`${web}src/pages/login.astro`).text()).toContain(`href="${noAccountDownload}"`)
})

test("troubleshooting explains in-app updates and their fallbacks", async () => {
  const page = await Bun.file(`${web}src/pages/docs/troubleshooting.astro`).text()
  const item = (title: string) => page.match(new RegExp(`<strong>${title}</strong><p>([\\s\\S]*?)</p>`))?.[1] ?? ""

  const offers = item("Vector never offers an update")
  expect(offers).toContain("Settings → Updates &amp; about and choose Check now")
  expect(offers).toContain("Check for Updates in the Vector menu on macOS")
  // Releases before 1.99.2 have no Updates & about page; their update control is in the sidebar.
  expect(offers).toContain("before 1.99.2")
  expect(offers).toContain("Update Vector at the bottom of the left sidebar")
  expect(offers).toContain("in-app updates only work when you run the AppImage")
  expect(offers).toContain(`href="${noAccountDownload}"`)

  const mac = item("A macOS update does not install")
  // On macOS the menu's update dialog offers a plain Restart button, which hits the same unwritable-folder failure.
  expect(mac).toContain(
    "Restart to update (Restart in the Vector menu's update dialog, or Update Vector before 1.99.2) does nothing",
  )
  expect(mac).toMatch(
    /quit Vector[\s\S]*download the DMG[\s\S]*drag Vector to Applications[\s\S]*open it from Applications/,
  )
  expect(mac).toContain("your account page")
  expect(mac).toContain(`href="${noAccountDownload}"`)
})
