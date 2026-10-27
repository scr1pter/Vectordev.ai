import { afterEach, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

// As in usage-page.test.ts: this package's tsconfig compiles JSX for Solid, and Astro builds the React islands
// itself, so the sign-in island is compiled here with React's automatic runtime, as Astro does.
const react = new Bun.Transpiler({
  loader: "tsx",
  autoImportJSX: true,
  tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" } },
})
Bun.plugin({
  name: "react islands",
  setup(build) {
    build.onLoad({ filter: /components\/marketing\/account\/[^/]+\.tsx$/ }, async (args) => ({
      contents: react.transformSync(await Bun.file(args.path).text()),
      loader: "js",
    }))
  },
})
const { AuthPage } = await import("../src/components/marketing/account/AuthPage")
const web = `${import.meta.dir}/../`

const visit = (search: string) => {
  Object.defineProperty(globalThis, "location", { value: { search }, configurable: true, writable: true })
  return renderToStaticMarkup(createElement(AuthPage))
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "location")
})

test("the sign-in form reads heading, Google, or, email, Continue, sign-up link, then the legal line", () => {
  const html = visit("")
  const order = [
    '<h1 id="auth-title">Log in</h1>',
    'class="signin-button signin-primary"',
    "Continue with Google",
    'class="signin-divider"',
    "<span>Email</span>",
    'type="email"',
    ">Continue</button>",
    "Don’t have an account?",
    ">Sign up</button>",
    'href="/legal/terms"',
    'href="/legal/privacy"',
  ]
  const positions = order.map((part) => html.indexOf(part))
  expect(order.filter((_, index) => positions[index] < 0)).toEqual([])
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
  // Email comes first; Continue reveals the password in the same form.
  expect(html).not.toContain('type="password"')
  expect(html).not.toContain("auth-sub")
  // There is no refund policy page, so the legal line names only the two that exist.
  expect(html).not.toContain("Refund")
})

test("a sign-in before deleting the account still says why it is asked for", () => {
  const html = visit("?reauth=1&returnTo=%2Faccount%3Fconfirmed%3D1")
  expect(html).toContain('<h1 id="auth-title">Sign in again to confirm it is you</h1>')
  expect(html).toContain("Vector asks for a fresh sign-in before it deletes your account.")
})

test("/login is two panels: Vector's art and logo beside the form, with the loading fallback in the form's place", async () => {
  const page = await Bun.file(`${web}src/pages/login.astro`).text()
  expect(page).toContain('<a class="signin-logo" href="/" aria-label="Vector home">')
  expect(page).toContain('<div class="signin-art" aria-hidden="true"></div>')
  expect(page).toContain('<main class="signin-panel">')
  expect(page).toContain('<AuthPage client:only="react">')
  expect(page).toContain('role="status">Loading sign-in…</div>')
  // The art panel replaced the full-page rain on this page.
  expect(page).not.toContain("MatrixRain")
  const css = await Bun.file(`${web}src/components/marketing/account/account.css`).text()
  expect(css).toMatch(/\.signin-form \{[^}]*width: min\(384px, 100%\);/)
  expect(css).toMatch(/@media \(max-width: 767px\) \{[\s\S]*?\.signin-art \{\s*display: none;/)
})
