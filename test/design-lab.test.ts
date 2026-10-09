import { afterEach, describe, expect, test } from "bun:test"
import {
  clearedDesignLabCookie,
  designLabCookie,
  requireDesignLabOwner,
  verifiedDesignLabCookie,
} from "../api/_lib/design-lab"
import { designLabFile } from "../api/design-lab/serve"

const original = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
  VECTOR_LICENSE_SECRET: process.env.VECTOR_LICENSE_SECRET,
  VECTOR_DESIGN_LAB_SECRET: process.env.VECTOR_DESIGN_LAB_SECRET,
  VECTOR_DESIGN_LAB_EMAILS: process.env.VECTOR_DESIGN_LAB_EMAILS,
  VECTOR_CLI_TOKEN_SECRET: process.env.VECTOR_CLI_TOKEN_SECRET,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  CRON_SECRET: process.env.CRON_SECRET,
}

afterEach(() => {
  Object.entries(original).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

const OWNER = "krishnabharadwaj0521@gmail.com"

function configure() {
  process.env.SUPABASE_URL = "https://vector.supabase.co"
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_vector"
  process.env.VECTOR_LICENSE_SECRET = "x".repeat(40)
  delete process.env.VECTOR_DESIGN_LAB_SECRET
  delete process.env.VECTOR_DESIGN_LAB_EMAILS
  delete process.env.VECTOR_CLI_TOKEN_SECRET
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  delete process.env.CRON_SECRET
}

// A token whose payload says how the session was made; Supabase (faked below) verifies it.
function token(method: string) {
  const payload = Buffer.from(JSON.stringify({ amr: [{ method, timestamp: 1 }] })).toString("base64url")
  return `header.${payload}.signature`
}

function supabase(user: Record<string, unknown>, status = 200) {
  return () => Promise.resolve(new Response(JSON.stringify(user), { status }))
}

function owner(overrides: Record<string, unknown> = {}) {
  return {
    id: "9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb",
    email: OWNER,
    email_confirmed_at: "2026-09-01T12:00:00.000Z",
    identities: [{ provider: "google", identity_data: { email: OWNER, email_verified: true } }],
    ...overrides,
  }
}

const bearer = (value: string) => ({ headers: { authorization: `Bearer ${value}` } })
const withCookie = (cookie: string) => ({ headers: { cookie: cookie.split(";")[0] } })

describe("Design Lab owner check", () => {
  test("lets the owner in after a Google sign-in", async () => {
    configure()
    expect(await requireDesignLabOwner(bearer(token("oauth")), supabase(owner()))).toEqual({ email: OWNER })
  })

  test("refuses any other account, even signed in with Google", async () => {
    configure()
    const other = owner({
      email: "someone@example.com",
      identities: [{ provider: "google", identity_data: { email: "someone@example.com", email_verified: true } }],
    })
    await expect(requireDesignLabOwner(bearer(token("oauth")), supabase(other))).rejects.toMatchObject({
      statusCode: 403,
      code: "DESIGN_LAB_FORBIDDEN",
    })
  })

  test("refuses a near-miss spelling of the owner address", async () => {
    configure()
    const typo = owner({ email: "krishnabhradwaj0521@gmail.com" })
    await expect(requireDesignLabOwner(bearer(token("oauth")), supabase(typo))).rejects.toMatchObject({
      code: "DESIGN_LAB_FORBIDDEN",
    })
  })

  test("refuses the owner's address when this session came from a password", async () => {
    configure()
    await expect(requireDesignLabOwner(bearer(token("password")), supabase(owner()))).rejects.toMatchObject({
      code: "GOOGLE_SIGN_IN_REQUIRED",
    })
  })

  test("refuses an OAuth session when the account also has a non-Google OAuth identity", async () => {
    configure()
    const linked = owner({
      identities: [
        { provider: "google", identity_data: { email: OWNER, email_verified: true } },
        { provider: "github", identity_data: { email: OWNER } },
      ],
    })
    await expect(requireDesignLabOwner(bearer(token("oauth")), supabase(linked))).rejects.toMatchObject({
      code: "GOOGLE_SIGN_IN_REQUIRED",
    })
  })

  test("refuses an unconfirmed owner address and a session Supabase rejects", async () => {
    configure()
    await expect(
      requireDesignLabOwner(bearer(token("oauth")), supabase(owner({ email_confirmed_at: null }))),
    ).rejects.toMatchObject({ code: "DESIGN_LAB_FORBIDDEN" })
    await expect(requireDesignLabOwner(bearer(token("oauth")), supabase({}, 401))).rejects.toMatchObject({
      statusCode: 401,
    })
    await expect(requireDesignLabOwner({ headers: {} }, supabase(owner()))).rejects.toMatchObject({
      code: "SIGN_IN_REQUIRED",
    })
  })
})

describe("Design Lab cookie", () => {
  test("round-trips for the owner and is scoped, HttpOnly and Secure", () => {
    configure()
    const cookie = designLabCookie(OWNER)
    expect(cookie).toContain("Path=/design-lab")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(verifiedDesignLabCookie(withCookie(cookie))).toBe(OWNER)
  })

  test("rejects a tampered, foreign-key, expired or cleared cookie", () => {
    configure()
    const cookie = designLabCookie(OWNER).split(";")[0]
    const [name, value] = cookie.split("=")
    const [version, payload, signature] = value.split(".")
    const forged = Buffer.from(JSON.stringify({ e: OWNER, x: 9_999_999_999 })).toString("base64url")
    expect(verifiedDesignLabCookie(withCookie(`${name}=${version}.${forged}.${signature}`))).toBeUndefined()
    expect(verifiedDesignLabCookie(withCookie(`${name}=${version}.${payload}.${signature.slice(1)}x`))).toBeUndefined()
    process.env.VECTOR_LICENSE_SECRET = "y".repeat(40)
    expect(verifiedDesignLabCookie(withCookie(cookie))).toBeUndefined()
    configure()
    expect(verifiedDesignLabCookie(withCookie(cookie), Date.now() + 9 * 60 * 60 * 1000)).toBeUndefined()
    expect(verifiedDesignLabCookie(withCookie(clearedDesignLabCookie()))).toBeUndefined()
    expect(verifiedDesignLabCookie({ headers: {} })).toBeUndefined()
  })
})

describe("Design Lab signing key", () => {
  test("falls back to another server secret, and refuses when none is set", () => {
    configure()
    delete process.env.VECTOR_LICENSE_SECRET
    process.env.SUPABASE_SERVICE_ROLE_KEY = "s".repeat(48)
    expect(verifiedDesignLabCookie(withCookie(designLabCookie(OWNER)))).toBe(OWNER)
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    expect(() => designLabCookie(OWNER)).toThrow("This page is not configured.")
  })
})

describe("Design Lab file paths", () => {
  test("maps clean requests to files and refuses anything outside the lab", () => {
    expect(designLabFile("")).toMatchObject({ relative: "index.html", extension: ".html" })
    expect(designLabFile("designs/mcp-servers.html")?.relative).toBe("designs/mcp-servers.html")
    expect(designLabFile("assets/fonts/inter.woff2")?.extension).toBe(".woff2")
    expect(designLabFile("../api/_lib/design-lab.ts")).toBeUndefined()
    expect(designLabFile("designs/../../vercel.json")).toBeUndefined()
    expect(designLabFile("vercel.json")).toBeUndefined()
    expect(designLabFile(".git/config")).toBeUndefined()
    expect(designLabFile("assets\\lab.css")).toBeUndefined()
    expect(designLabFile("index.html\0.png")).toBeUndefined()
  })
})

describe("Design Lab file server", () => {
  async function serve(path: string, cookie?: string) {
    const { default: handler } = await import("../api/design-lab/serve")
    const headers: Record<string, string> = {}
    const response = {
      statusCode: 0,
      body: undefined as unknown,
      setHeader(name: string, value: string) {
        headers[name.toLowerCase()] = value
      },
      end(body?: unknown) {
        this.body = body
      },
    }
    const request = {
      method: "GET",
      url: `/api/design-lab/serve?path=${encodeURIComponent(path)}`,
      query: { path },
      headers: cookie ? { cookie: cookie.split(";")[0] } : {},
    }
    const cwd = process.cwd()
    process.chdir(new URL("..", import.meta.url).pathname)
    try {
      await handler(request as never, response as never)
    } finally {
      process.chdir(cwd)
    }
    return { status: response.statusCode, headers, body: response.body }
  }

  test("sends a visitor without the cookie to sign in, and hides the files", async () => {
    configure()
    expect(await serve("index.html")).toMatchObject({ status: 302, headers: { location: "/design" } })
    expect((await serve("assets/lab.css")).status).toBe(404)
  })

  test("serves the lab to the owner's cookie, privately", async () => {
    configure()
    const page = await serve("index.html", designLabCookie(OWNER))
    expect(page.status).toBe(200)
    expect(page.headers["content-type"]).toContain("text/html")
    expect(page.headers["cache-control"]).toBe("private, no-store")
    expect(String(page.body)).toContain("Vector Design Lab")
    expect((await serve("assets/lab.css", designLabCookie(OWNER))).status).toBe(200)
    expect((await serve("assets/nope.css", designLabCookie(OWNER))).status).toBe(404)
  })

  test("refuses a cookie signed with another key", async () => {
    configure()
    const cookie = designLabCookie(OWNER)
    process.env.VECTOR_LICENSE_SECRET = "z".repeat(40)
    expect((await serve("index.html", cookie)).status).toBe(302)
  })
})
