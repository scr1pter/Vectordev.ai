import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptAttachmentsCore } from "@/components/prompt-input/attachments"
import { createPromptState } from "@/context/prompt"

describe("prompt attachment session ownership", () => {
  test("adds an asynchronously read image to the session where the read started", async () => {
    await createRoot(async (dispose) => {
      const sessions = { A: createPromptState(), B: createPromptState() }
      let active: "A" | "B" = "A"
      const attachments = createPromptAttachmentsCore({
        capture: () => sessions[active].capture(),
        editor: () => document.createElement("div"),
      })
      const pending = attachments.addAttachment(new File([new Uint8Array(1024 * 1024)], "a.png", { type: "image/png" }))

      active = "B"
      await pending

      expect(images(sessions.A)).toHaveLength(1)
      expect(images(sessions.B)).toHaveLength(0)
      dispose()
    })
  })

  test("finishes the captured attachment after the active editor is removed", async () => {
    await createRoot(async (dispose) => {
      const prompt = createPromptState()
      let editor: HTMLDivElement | undefined = document.createElement("div")
      const attachments = createPromptAttachmentsCore({
        capture: prompt.capture,
        editor: () => editor,
      })
      const pending = attachments.addAttachment(new File([new Uint8Array(1024 * 1024)], "a.png", { type: "image/png" }))

      editor = undefined
      await pending

      expect(images(prompt)).toHaveLength(1)
      dispose()
    })
  })

  test("keeps every file in a batch on the session where the batch started", async () => {
    await createRoot(async (dispose) => {
      const sessions = { A: createPromptState(), B: createPromptState() }
      let active: "A" | "B" = "A"
      const attachments = createPromptAttachmentsCore({
        capture: () => sessions[active].capture(),
        editor: () => document.createElement("div"),
      })
      const pending = attachments.addAttachments([
        new File([new Uint8Array(1024 * 1024)], "first.png", { type: "image/png" }),
        new File([new Uint8Array(1024 * 1024)], "second.png", { type: "image/png" }),
      ])

      active = "B"
      await pending

      expect(images(sessions.A)).toHaveLength(2)
      expect(images(sessions.B)).toHaveLength(0)
      dispose()
    })
  })

  test("keeps a delayed native clipboard image on the session where paste started", async () => {
    await createRoot(async (dispose) => {
      const sessions = { A: createPromptState(), B: createPromptState() }
      const read = Promise.withResolvers<File | null>()
      let active: "A" | "B" = "A"
      const attachments = createPromptAttachmentsCore({
        capture: () => sessions[active].capture(),
        editor: () => document.createElement("div"),
      })
      const pending = attachments.addClipboardAttachment(read.promise)

      active = "B"
      read.resolve(new File([new Uint8Array(1024 * 1024)], "clipboard.png", { type: "image/png" }))
      await pending

      expect(images(sessions.A)).toHaveLength(1)
      expect(images(sessions.B)).toHaveLength(0)
      dispose()
    })
  })
})

describe("prompt paste", () => {
  // A PNG signature plus one byte, so different seeds are different images and equal seeds are the same one.
  const png = (seed: number, name = "image.png", type = "image/png") =>
    new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed)], name, { type })

  const paste = (files: File[], text = "") =>
    ({
      clipboardData: {
        items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
        types: [...(files.length ? ["Files"] : []), ...(text ? ["text/plain"] : [])],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    }) as unknown as ClipboardEvent

  const setup = () => {
    const prompt = createPromptState()
    const typed: string[] = []
    const attachments = createPromptAttachmentsCore({
      capture: prompt.capture,
      editor: () => document.createElement("div"),
      addPart: (part) => {
        if (part.type === "text") typed.push(part.content)
        return true
      },
    })
    return { prompt, typed, attachments }
  }

  test("attaches a picture once when one paste carries it in two formats", async () => {
    await createRoot(async (dispose) => {
      const { prompt, attachments } = setup()

      await attachments.handlePaste(paste([png(1), png(1, "image.tiff", "image/tiff")]))

      expect(images(prompt)).toHaveLength(1)
      dispose()
    })
  })

  test("keeps different pictures from one paste and the same picture pasted again", async () => {
    await createRoot(async (dispose) => {
      const { prompt, attachments } = setup()

      await attachments.handlePaste(paste([png(1), png(2)]))
      await attachments.handlePaste(paste([png(1)]))

      expect(images(prompt)).toHaveLength(3)
      dispose()
    })
  })

  test("inserts the text copied with a picture unless it only names the file", async () => {
    await createRoot(async (dispose) => {
      const { prompt, typed, attachments } = setup()

      await attachments.handlePaste(paste([png(1)], "Q3 revenue\nlook at the red bar"))
      await attachments.handlePaste(paste([png(2, "shot.png")], "shot.png"))

      expect(typed).toEqual(["Q3 revenue\nlook at the red bar"])
      expect(images(prompt)).toHaveLength(2)
      dispose()
    })
  })
})

function images(prompt: ReturnType<typeof createPromptState>) {
  return prompt.current().filter((part) => part.type === "image")
}
