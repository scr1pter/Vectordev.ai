import { describe, expect, test } from "bun:test"
import { readAccountApiResponse, readAccountConfiguration, safeReturnPath } from "./account-client"

describe("account configuration", () => {
  test("turns an HTML fallback into the friendly unavailable error", async () => {
    const error = await rejected(
      readAccountConfiguration(
        new Response("<!doctype html><title>Not found</title>", {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ),
    )
    if (!(error instanceof Error)) throw error
    expect(error.message).toBe("Vector accounts are temporarily unavailable.")
  })

  test("accepts the public Supabase configuration payload", async () => {
    expect(
      await readAccountConfiguration(
        Response.json({
          available: true,
          url: "https://vector.supabase.co",
          publishableKey: "sb_publishable_vector",
        }),
      ),
    ).toEqual({ url: "https://vector.supabase.co", publishableKey: "sb_publishable_vector" })
  })
})

describe("account API responses", () => {
  test("does not surface JSON parse errors when a local server returns HTML", async () => {
    const error = await rejected(
      readAccountApiResponse(
        new Response("<!doctype html><title>Not found</title>", {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
        "Vector could not load your account.",
      ),
    )
    if (!(error instanceof Error)) throw error
    expect(error.message).toBe("Vector could not load your account.")
  })

  test("preserves a structured API error message", async () => {
    const error = await rejected(
      readAccountApiResponse(
        Response.json({ error: { message: "Confirm your email address before continuing." } }, { status: 403 }),
        "Vector could not load your account.",
      ),
    )
    if (!(error instanceof Error)) throw error
    expect(error.message).toBe("Confirm your email address before continuing.")
  })
})

describe("account return paths", () => {
  test("preserves a local account destination", () => {
    expect(safeReturnPath("/account?checkout=cancelled#billing")).toBe("/account?checkout=cancelled#billing")
  })

  test("rejects absolute and protocol-relative destinations", () => {
    expect(safeReturnPath("https://attacker.example/path")).toBe("/account")
    expect(safeReturnPath("//attacker.example/path")).toBe("/account")
  })

  test("rejects backslashes that URL parsers normalize into another origin", () => {
    expect(safeReturnPath("/\\\\attacker.example/path")).toBe("/account")
    expect(safeReturnPath("/\\attacker.example/path")).toBe("/account")
  })
})

async function rejected(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject.")
}
