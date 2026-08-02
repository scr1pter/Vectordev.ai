import { describe, expect, test } from "bun:test"
import { fileListErrorMessage, isTransientFileListError } from "./tree-store"

describe("file tree errors", () => {
  test("recognizes temporary connection failures", () => {
    expect(isTransientFileListError("Failed to fetch")).toBe(true)
    expect(isTransientFileListError("fetch failed")).toBe(true)
    expect(isTransientFileListError("Connection refused")).toBe(true)
    expect(isTransientFileListError("Permission denied")).toBe(false)
  })

  test("normalizes unknown errors without assuming an Error object", () => {
    expect(fileListErrorMessage(new Error("Folder unavailable"))).toBe("Folder unavailable")
    expect(fileListErrorMessage("Folder unavailable")).toBe("Folder unavailable")
    expect(fileListErrorMessage(undefined)).toBe("Vector could not read this folder.")
  })
})
