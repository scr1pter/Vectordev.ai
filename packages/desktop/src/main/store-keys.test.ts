import { describe, expect, test } from "bun:test"

import { isRendererStoreName } from "./store-keys"

describe("isRendererStoreName", () => {
  test("accepts the renderer's own .dat stores", () => {
    for (const name of [
      "default.dat",
      "vector.global.dat",
      "vector.workspace.abc.123.dat",
      "vector.draft.-tmp-x.1a2b.dat",
      "vector.window.main.dat",
      "vector.model-economics.v1.dat",
    ]) {
      expect({ name, ok: isRendererStoreName(name) }).toEqual({ name, ok: true })
    }
  })

  test("rejects main-process stores, paths and non-strings", () => {
    for (const name of [
      "vector.settings",
      "github-auth",
      "gitlab-auth",
      "cloud-database-credentials",
      "../x.dat",
      "dir/x.dat",
      "dir\\x.dat",
      ".dat",
      "",
      undefined,
      42,
    ]) {
      expect({ name, ok: isRendererStoreName(name) }).toEqual({ name, ok: false })
    }
  })
})
