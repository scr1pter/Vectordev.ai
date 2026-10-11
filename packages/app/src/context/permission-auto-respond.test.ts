import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@vectordevai/sdk/v2/client"
import { base64Encode } from "@vectordevai/core/util/encode"
import { autoRespondsPermission, isDirectoryAutoAccepting } from "./permission-auto-respond"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (sessionID: string, name?: string) =>
  ({
    sessionID,
    permission: name,
  }) as Pick<PermissionRequest, "sessionID" | "permission">

describe("autoRespondsPermission", () => {
  test("uses a parent session's directory-scoped auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("uses a parent session's legacy auto-accept key", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]

    expect(autoRespondsPermission({ root: true }, sessions, permission("child"), "/tmp/project")).toBe(true)
  })

  test("defaults to requiring approval when no lineage override exists", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" }), session({ id: "other" })]
    const autoAccept = {
      other: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), "/tmp/project")).toBe(false)
  })

  test("inherits a parent session's false override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(false)
  })

  test("prefers a child override over parent override", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/root`]: false,
      [`${base64Encode(directory)}/child`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("child"), directory)).toBe(true)
  })

  test("falls back to directory-level auto-accept", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(true)
  })

  test("leaves every Vector Cloud change to the user, and answers only the read-only dry run", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: true,
    }
    const asked = (name: string, always?: string[]) => ({ sessionID: "root", permission: name, always })

    expect(autoRespondsPermission(autoAccept, sessions, asked("edit"), directory)).toBe(true)
    expect(autoRespondsPermission(autoAccept, sessions, asked("bash", []), directory)).toBe(true)
    // A migration dry run only reads.
    expect(
      autoRespondsPermission(
        autoAccept,
        sessions,
        asked("vector_cloud_inspect", ["supabase/shop-db/production"]),
        directory,
      ),
    ).toBe(true)
    // Publishing and production moves, databases (billed), hosting settings and
    // domains, and host variables, whether or not the request could be
    // remembered, under directory, session and legacy auto-accept alike.
    for (const name of [
      "vector_cloud_publish",
      "vector_cloud_database",
      "vector_cloud_environment",
      "vector_cloud_hosting",
    ]) {
      expect(autoRespondsPermission(autoAccept, sessions, asked(name), directory)).toBe(false)
      expect(
        autoRespondsPermission(autoAccept, sessions, asked(name, [`vercel/shop/production/${name}`]), directory),
      ).toBe(false)
      expect(
        autoRespondsPermission(
          { root: true },
          sessions,
          asked(name, ["supabase/shop-db/production/create_bucket"]),
          directory,
        ),
      ).toBe(false)
    }
    // Any other cloud request that asks every time is left to the user too.
    expect(autoRespondsPermission(autoAccept, sessions, asked("vector_cloud_inspect", []), directory)).toBe(false)
  })

  test("session-level override takes precedence over directory-level", () => {
    const directory = "/tmp/project"
    const sessions = [session({ id: "root" })]
    const autoAccept = {
      [`${base64Encode(directory)}/*`]: true,
      [`${base64Encode(directory)}/root`]: false,
    }

    expect(autoRespondsPermission(autoAccept, sessions, permission("root"), directory)).toBe(false)
  })

  test("never auto-approves doom-loop continuation", () => {
    const directory = "/tmp/project"
    expect(
      autoRespondsPermission(
        { [`${base64Encode(directory)}/*`]: true, root: true },
        [session({ id: "root" })],
        permission("root", "doom_loop"),
        directory,
      ),
    ).toBe(false)
  })

  test.each(["browser_sensitive", "computer_observe", "computer_interact", "computer_sensitive"])(
    "never auto-approves %s",
    (name) => {
      const directory = "/tmp/project"
      expect(
        autoRespondsPermission(
          { [`${base64Encode(directory)}/*`]: true, root: true },
          [session({ id: "root" })],
          permission("root", name),
          directory,
        ),
      ).toBe(false)
    },
  )
})

describe("isDirectoryAutoAccepting", () => {
  test("returns true when directory key is set", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: true }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(true)
  })

  test("returns false when directory key is not set", () => {
    expect(isDirectoryAutoAccepting({}, "/tmp/project")).toBe(false)
  })

  test("returns false when directory key is explicitly false", () => {
    const directory = "/tmp/project"
    const autoAccept = { [`${base64Encode(directory)}/*`]: false }
    expect(isDirectoryAutoAccepting(autoAccept, directory)).toBe(false)
  })
})
