import { describe, expect, test } from "bun:test"
import { hubURL, modelFiles, REQUIRED } from "./local-transcription-files"

describe("installing the dictation model from a folder", () => {
  test("finds the model's files in its own folder or in one above it", () => {
    const folder = [...REQUIRED, "generation_config.json", "README.md", "onnx/encoder_model_quantized.onnx"]
    const own = modelFiles(folder)
    expect(own.missing).toEqual([])
    expect(own.files.get("onnx/encoder_model.onnx")).toBe("onnx/encoder_model.onnx")
    expect(own.files.get("generation_config.json")).toBe("generation_config.json")
    // What the pipeline does not load is left out.
    expect([...own.files.keys()]).not.toContain("README.md")
    expect([...own.files.keys()]).not.toContain("onnx/encoder_model_quantized.onnx")
    const above = modelFiles(folder.map((file) => `models/whisper-tiny.en/${file}`))
    expect(above.missing).toEqual([])
    expect(above.files.get("config.json")).toBe("models/whisper-tiny.en/config.json")
    // Windows paths read the same.
    expect(modelFiles(folder.map((file) => `whisper\\${file.replaceAll("/", "\\")}`)).missing).toEqual([])
  })

  test("names the files a folder lacks, and does not take one file for another", () => {
    const found = modelFiles(["tokenizer_config.json", "onnx/encoder_model.onnx", "generation_config.json"])
    expect(found.missing).toEqual([
      "config.json",
      "tokenizer.json",
      "preprocessor_config.json",
      "onnx/decoder_model_merged.onnx",
    ])
  })

  test("keys each file by the address transformers.js downloads it from", () => {
    expect(hubURL("onnx/decoder_model_merged.onnx")).toBe(
      "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/onnx/decoder_model_merged.onnx",
    )
  })
})
