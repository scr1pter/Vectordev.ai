import { describe, expect, test } from "bun:test"
import { expandPastedText, expandTrackedPastedText, slashCommand, stripPromptPartIDs } from "../../src/prompt/part"

describe("prompt part", () => {
  test("strips persisted IDs from reused parts", () => {
    expect(
      stripPromptPartIDs({
        id: "prt_old",
        sessionID: "ses_old",
        messageID: "msg_old",
        type: "file" as const,
        mime: "image/png",
        filename: "tiny.png",
        url: "data:image/png;base64,abc",
      }),
    ).toEqual({
      type: "file",
      mime: "image/png",
      filename: "tiny.png",
      url: "data:image/png;base64,abc",
    })
  })

  test("preserves wide characters around pasted text", () => {
    const marker = "[Pasted ~3 lines]"
    const prefix = "你好你好\n"

    expect(
      expandTrackedPastedText(prefix + marker + "\n阿斯顿法国红酒看来", [
        {
          start: Bun.stringWidth("你好你好") + 1,
          end: Bun.stringWidth("你好你好") + 1 + Bun.stringWidth(marker),
          text: "public:\n\tvoid ExecuteTask();\nprivate:",
        },
      ]),
    ).toBe("你好你好\npublic:\n\tvoid ExecuteTask();\nprivate:\n阿斯顿法国红酒看来")
  })

  test("only expands the tracked placeholder occurrence", () => {
    const marker = "[Pasted ~3 lines]"
    const prefix = `keep ${marker} then `

    expect(
      expandTrackedPastedText(prefix + marker + " tail", [
        {
          start: Bun.stringWidth(prefix),
          end: Bun.stringWidth(prefix + marker),
          text: "alpha\nbeta\ngamma",
        },
      ]),
    ).toBe(`keep ${marker} then alpha\nbeta\ngamma tail`)
  })

  test("says which spans of the sent text were pasted, behind a placeholder or as they were", () => {
    const marker = "[Pasted ~4 lines]"
    const email = "Hi team,\nI prefer short replies.\nAlways cc legal on merges.\nThanks"
    const typed = "你好 summarise this: "
    const input = `${typed}${marker} and reply to always use tables please`
    const expanded = expandPastedText(
      input,
      [{ start: Bun.stringWidth(typed), end: Bun.stringWidth(typed + marker), text: email }],
      // "always use tables" was pasted as it was.
      [
        {
          start: Bun.stringWidth(`${typed}${marker} and reply to `),
          end: Bun.stringWidth(`${typed}${marker} and reply to always use tables`),
        },
      ],
    )
    expect(expanded.text).toBe(`${typed}${email} and reply to always use tables please`)
    expect(expanded.pasted.map(([start, end]) => expanded.text.slice(start, end))).toEqual([email, "always use tables"])
    // Nothing pasted, nothing marked.
    expect(expandPastedText("always use tables", [])).toEqual({ text: "always use tables", pasted: [] })
  })

  test("a slash command's arguments keep the spans the user pasted into them, at the arguments' own offsets", () => {
    const marker = "[Pasted ~3 lines]"
    const email = "Hi team,\nI prefer short replies.\nAlways cc legal on merges."
    const typed = "/note always use tables for comparisons "
    const expanded = expandPastedText(`${typed}${marker}\nthanks`, [
      { start: Bun.stringWidth(typed), end: Bun.stringWidth(typed + marker), text: email },
    ])
    const command = slashCommand(expanded.text, expanded.pasted)
    expect(command.name).toBe("note")
    expect(command.arguments).toBe(`always use tables for comparisons ${email}\nthanks`)
    expect(command.pasted.map(([start, end]) => command.arguments.slice(start, end))).toEqual([email])
    // A paste on a later line, after a command with no arguments on its own line.
    const later = expandPastedText(`/note\n${marker}`, [
      // A line break is one offset, as the prompt's extmarks count it.
      { start: "/note".length + 1, end: "/note".length + 1 + Bun.stringWidth(marker), text: email },
    ])
    const bare = slashCommand(later.text, later.pasted)
    expect(bare.arguments).toBe(`\n${email}`)
    expect(bare.pasted.map(([start, end]) => bare.arguments.slice(start, end))).toEqual([email])
    // Nothing pasted, nothing marked; the arguments read as before.
    expect(slashCommand("/review the payments tests\nand the client", [])).toEqual({
      name: "review",
      arguments: "the payments tests\nand the client",
      pasted: [],
    })
  })
})
