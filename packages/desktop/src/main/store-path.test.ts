import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { resolveStorePath } from "./store-path"

describe("desktop store paths", () => {
  test("keeps opaque store names directly beneath userData", () => {
    expect(resolveStorePath("/tmp/vector-user-data", "vector.workspace.project.123.dat")).toBe(
      join("/tmp/vector-user-data", "vector.workspace.project.123.dat"),
    )
  })

  test("rejects traversal and absolute store names", () => {
    for (const name of ["../outside", "nested/store", "/tmp/outside", "C:\\outside", "..", "."]) {
      expect(() => resolveStorePath("/tmp/vector-user-data", name)).toThrow("Invalid store name")
    }
  })
})
