import { describe, expect, test } from "bun:test"
import { Readable } from "node:stream"
import { readJson, type ApiRequest } from "../api/_lib/http"

describe("API JSON body limits", () => {
  test("rejects oversized parsed bodies even without a content-length header", async () => {
    await expect(readJson({ body: { content: "x".repeat(65_000) } } as ApiRequest)).rejects.toMatchObject({
      statusCode: 413,
    })
  })

  test("counts UTF-8 bytes rather than characters in parsed bodies", async () => {
    await expect(readJson({ body: { content: "☃".repeat(10) } } as ApiRequest, 30)).rejects.toMatchObject({
      statusCode: 413,
    })
  })

  test("applies the same limit to chunked requests", async () => {
    const request = Readable.from([Buffer.from('{"content":"'), Buffer.from("x".repeat(100)), Buffer.from('"}')])
    await expect(readJson(request as ApiRequest, 50)).rejects.toMatchObject({ statusCode: 413 })
  })

  test("accepts parsed and streamed JSON within the limit", async () => {
    const body = { content: "valid" }
    expect(await readJson({ body } as ApiRequest)).toEqual(body)
    expect(await readJson(Readable.from([Buffer.from(JSON.stringify(body))]) as ApiRequest)).toEqual(body)
  })
})
