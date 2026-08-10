import { describe, expect, test } from "bun:test"

import { prepareImageForModel } from "./image-processing"

describe("prepareImageForModel", () => {
  test("preserves provider-ready JPEG data without recompressing it", async () => {
    const file = new File([Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)], "photo.jpg", { type: "image/jpeg" })
    const result = await prepareImageForModel(file, "image/jpeg")

    expect(result).toEqual({ blob: file, mime: "image/jpeg" })
  })

  test("does not alter non-image attachments", async () => {
    const file = new File(["notes"], "notes.txt", { type: "text/plain" })
    const result = await prepareImageForModel(file, "text/plain")

    expect(result).toEqual({ blob: file, mime: "text/plain" })
  })
})
