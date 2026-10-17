import { createHash } from "node:crypto"
import { expect, test } from "@playwright/test"
import { withInlineScriptHashes } from "../../content-security-policy.js"

for (const [name, newline] of [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
  ["CR", "\r"],
] as const) {
  test(`CSP hashes match the HTML parser for ${name} scripts and still block unlisted code`, async ({ page }) => {
    const script = ["// first line", 'document.documentElement.dataset.cspFixture = "ran";', "// last line"].join(
      newline,
    )
    const trusted = withInlineScriptHashes(
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'"><script id="trusted">${script}</script></head><body>Hash fixture</body></html>`,
    )
    const errors: string[] = []
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    await page.route("http://csp.fixture/", (route) =>
      route.fulfill({
        contentType: "text/html",
        // Added after the trusted script hashes were computed: this must remain blocked.
        body: trusted.replace("</body>", '<script>document.documentElement.dataset.unlisted = "ran"</script></body>'),
      }),
    )
    await page.goto("http://csp.fixture/")
    const parsed = await page.evaluate(() => ({
      script: document.getElementById("trusted")!.textContent!,
      policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!,
      trusted: document.documentElement.dataset.cspFixture,
      unlisted: document.documentElement.dataset.unlisted,
    }))
    expect(parsed.script).not.toContain("\r")
    expect(parsed.policy).toBe(
      `default-src 'none'; script-src 'self' 'sha256-${createHash("sha256").update(parsed.script).digest("base64")}'`,
    )
    expect(parsed.trusted).toBe("ran")
    expect(parsed.unlisted).toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("violates the following Content Security Policy directive")
  })
}
