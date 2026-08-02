import { describe, expect, test } from "bun:test"
import { mergeAudioChunks, resampleAudio } from "./local-transcription"

describe("local transcription audio preparation", () => {
  test("merges recorded chunks without losing samples", () => {
    expect(Array.from(mergeAudioChunks([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3])
  })

  test("downsamples audio to the requested rate", () => {
    const input = new Float32Array([1, 1, 3, 3, 5, 5, 7, 7])
    expect(Array.from(resampleAudio(input, 8, 4))).toEqual([1, 3, 5, 7])
  })

  test("copies audio that already has the target rate", () => {
    const input = new Float32Array([0.25, -0.25])
    const output = resampleAudio(input, 16_000)
    expect(Array.from(output)).toEqual([0.25, -0.25])
    expect(output).not.toBe(input)
  })
})
