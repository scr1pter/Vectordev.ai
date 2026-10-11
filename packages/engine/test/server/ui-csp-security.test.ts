import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { cspForHtml } from "../../src/server/shared/ui"

const hash = (script: string) => createHash("sha256").update(script).digest("base64")

describe("embedded UI content security policy", () => {
  test("hashes every unique inline script but not external scripts", () => {
    const theme = 'document.documentElement.dataset.theme = "dark"'
    const launch = 'window.dispatchEvent(new Event("vector:launch"))'
    const externalBody = "this content belongs to an external script"
    const policy = cspForHtml(`<html><head>
      <script id="vector-theme-preload-script">${theme}</script>
      <script src="/assets/app.js">${externalBody}</script>
      <script id="vector-launch-script" type="module">${launch}</script>
      <script data-copy="duplicate">${launch}</script>
    </head></html>`)

    expect(policy).toContain(`'sha256-${hash(theme)}'`)
    expect(policy).toContain(`'sha256-${hash(launch)}'`)
    expect(policy).not.toContain(`'sha256-${hash(externalBody)}'`)
    expect(policy.match(new RegExp(hash(launch).replace(/[+]/g, "\\+"), "g"))).toHaveLength(1)
  })

  test("retains UI capabilities while blocking unsafe embedding and navigation", () => {
    const policy = cspForHtml("")

    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(policy).toContain("style-src 'self' 'unsafe-inline'")
    expect(policy).toContain("connect-src * data:")
    expect(policy).toContain("worker-src 'self' blob:")
    expect(policy).toContain("frame-src 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("form-action 'self'")
    expect(policy).toContain("base-uri 'none'")
    expect(policy).toContain("object-src 'none'")
  })
})
