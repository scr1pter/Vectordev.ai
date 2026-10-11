import { describe, expect, test } from "bun:test"
import {
  BADGE_MARKER,
  hasFileExtension,
  injectBadge,
  isValidFilePath,
  isValidSlug,
  makeSlug,
  mimeFor,
  slugFromSitesKey,
  slugify,
  tenantPromotionPath,
  tenantPromotionPrefix,
  tenantSitesPrefix,
  uniqueSlugsFromKeys,
} from "./shared"

describe("slugify", () => {
  test("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("My Cool App")).toBe("my-cool-app")
  })

  test("collapses runs of separators and symbols", () => {
    expect(slugify("hello --  world!!")).toBe("hello-world")
  })

  test("strips unicode diacritics and drops other unicode", () => {
    expect(slugify("Café Menü")).toBe("cafe-menu")
    expect(slugify("日本語 app")).toBe("app")
  })

  test("trims leading/trailing hyphens", () => {
    expect(slugify("--wow--")).toBe("wow")
  })

  test("falls back to 'site' for empty or all-symbol input", () => {
    expect(slugify("")).toBe("site")
    expect(slugify("!!!☕!!!")).toBe("site")
  })

  test("caps length to stay DNS-label safe", () => {
    const slug = slugify("a".repeat(100))
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug).toBe("a".repeat(40))
  })
})

describe("makeSlug", () => {
  test("appends a 6-char suffix", () => {
    const slug = makeSlug("my app", () => 0.5)
    expect(slug).toMatch(/^my-app-[a-z2-9]{6}$/)
  })

  test("output is a valid DNS label (subdomain-ready)", () => {
    expect(isValidSlug(makeSlug("My Very Long Application Name That Goes On And On"))).toBe(true)
    expect(isValidSlug(makeSlug(""))).toBe(true)
  })
})

describe("slugFromSitesKey", () => {
  const prefix = tenantSitesPrefix("tenant-a", "project-a")

  test("extracts the slug from a folded folder", () => {
    expect(slugFromSitesKey(`${prefix}my-app-x7k2qd/`, prefix)).toBe("my-app-x7k2qd")
  })

  test("extracts the slug from a full blob pathname", () => {
    expect(slugFromSitesKey(`${prefix}my-app-x7k2qd/assets/app.js`, prefix)).toBe("my-app-x7k2qd")
  })

  test("returns undefined for keys outside the sites/ prefix", () => {
    expect(slugFromSitesKey("other/my-app-x7k2qd/", prefix)).toBeUndefined()
    expect(slugFromSitesKey("my-app-x7k2qd/", prefix)).toBeUndefined()
  })

  test("returns undefined when the slug is not a valid DNS label", () => {
    expect(slugFromSitesKey(`${prefix}/index.html`, prefix)).toBeUndefined()
    expect(slugFromSitesKey(`${prefix}-bad-/index.html`, prefix)).toBeUndefined()
    expect(slugFromSitesKey(`${prefix}UPPER/index.html`, prefix)).toBeUndefined()
  })
})

describe("promotion paths", () => {
  test("uses a stable project prefix and immutable promotion record", () => {
    expect(tenantPromotionPrefix("tenant-a", "my-product")).toBe(
      "tenants/tenant-a/projects/my-product/promotions/",
    )
    expect(tenantPromotionPath("tenant-a", "my-product", "my-product-abc123", 42)).toBe(
      "tenants/tenant-a/projects/my-product/promotions/42-my-product-abc123.json",
    )
  })

  test("rejects an invalid deployment slug", () => {
    expect(() => tenantPromotionPath("tenant-a", "my-product", "../bad", 42)).toThrow()
  })
})

describe("uniqueSlugsFromKeys", () => {
  const prefix = tenantSitesPrefix("tenant-a", "project-a")

  test("dedupes and sorts slugs across many blob keys", () => {
    const keys = [
      `${prefix}beta-222222/index.html`,
      `${prefix}alpha-111111/index.html`,
      `${prefix}alpha-111111/assets/app.js`,
      `${prefix}beta-222222/`,
    ]
    expect(uniqueSlugsFromKeys(keys, prefix)).toEqual(["alpha-111111", "beta-222222"])
  })

  test("skips keys that don't resolve to a valid slug", () => {
    const keys = [`${prefix}good-abcdef/index.html`, "other/x/y", `${prefix}/nope`]
    expect(uniqueSlugsFromKeys(keys, prefix)).toEqual(["good-abcdef"])
  })

  test("returns an empty array for no keys", () => {
    expect(uniqueSlugsFromKeys([], prefix)).toEqual([])
  })
})

describe("isValidFilePath", () => {
  test("accepts root and nested relative paths", () => {
    expect(isValidFilePath("index.html")).toBe(true)
    expect(isValidFilePath("assets/js/app.js")).toBe(true)
    expect(isValidFilePath("fonts/inter.woff2")).toBe(true)
  })

  test("rejects traversal", () => {
    expect(isValidFilePath("../secret.txt")).toBe(false)
    expect(isValidFilePath("a/../b.txt")).toBe(false)
    expect(isValidFilePath("..")).toBe(false)
  })

  test("rejects absolute paths", () => {
    expect(isValidFilePath("/etc/passwd")).toBe(false)
    expect(isValidFilePath("/index.html")).toBe(false)
  })

  test("rejects backslashes", () => {
    expect(isValidFilePath("assets\\app.js")).toBe(false)
    expect(isValidFilePath("..\\..\\x")).toBe(false)
  })

  test("rejects empty paths, empty segments, and dot segments", () => {
    expect(isValidFilePath("")).toBe(false)
    expect(isValidFilePath("a//b.txt")).toBe(false)
    expect(isValidFilePath("./index.html")).toBe(false)
  })
})

describe("mimeFor", () => {
  test("maps known extensions", () => {
    expect(mimeFor("index.html")).toBe("text/html; charset=utf-8")
    expect(mimeFor("styles/main.css")).toBe("text/css; charset=utf-8")
    expect(mimeFor("app.js")).toBe("text/javascript; charset=utf-8")
    expect(mimeFor("app.mjs")).toBe("text/javascript; charset=utf-8")
    expect(mimeFor("logo.svg")).toBe("image/svg+xml")
    expect(mimeFor("photo.jpeg")).toBe("image/jpeg")
    expect(mimeFor("fonts/inter.woff2")).toBe("font/woff2")
    expect(mimeFor("app.js.map")).toBe("application/json; charset=utf-8")
  })

  test("is case-insensitive on extension", () => {
    expect(mimeFor("LOGO.PNG")).toBe("image/png")
  })

  test("defaults to octet-stream for unknown or missing extensions", () => {
    expect(mimeFor("binary.wasm")).toBe("application/octet-stream")
    expect(mimeFor("Makefile")).toBe("application/octet-stream")
    expect(mimeFor("weird.")).toBe("application/octet-stream")
  })
})

describe("hasFileExtension", () => {
  test("detects extensions on the last segment only", () => {
    expect(hasFileExtension("app.js")).toBe(true)
    expect(hasFileExtension("assets/app.js")).toBe(true)
    expect(hasFileExtension("about")).toBe(false)
    expect(hasFileExtension("v1.2/about")).toBe(false)
    expect(hasFileExtension(".htaccess")).toBe(false)
  })
})

describe("injectBadge", () => {
  const page = "<html><body><h1>hi</h1></body></html>"

  test("injects the badge before </body>", () => {
    const out = injectBadge(page)
    expect(out).toContain(BADGE_MARKER)
    expect(out).toContain("Deployed with Vector")
    expect(out.indexOf(BADGE_MARKER)).toBeLessThan(out.indexOf("</body>"))
  })

  test("injects exactly once", () => {
    const out = injectBadge(page)
    expect(out.split(BADGE_MARKER).length - 1).toBe(1)
  })

  test("is idempotent when the marker is already present", () => {
    const once = injectBadge(page)
    expect(injectBadge(once)).toBe(once)
  })

  test("respects a hand-rolled marker without </body> proximity", () => {
    const custom = `<html><body><div class="vector-badge">mine</div></body></html>`
    expect(injectBadge(custom)).toBe(custom)
  })

  test("returns HTML without </body> unchanged", () => {
    const fragment = "<h1>no body tag</h1>"
    expect(injectBadge(fragment)).toBe(fragment)
  })
})
