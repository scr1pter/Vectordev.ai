import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { PublicSession } from "../src/public-session"

const decode = Schema.decodeUnknownOption(PublicSession.Archive, { onExcessProperty: "error" })
const archive = {
  version: 1,
  engine: "v2",
  title: "Portable conversation",
  messages: [
    { id: "source-only", role: "assistant", createdAt: 1, parts: [{ type: "text", text: "Visible content" }] },
  ],
}

test("public archives accept visible display data and reject private or executable state", () => {
  expect(Option.isSome(decode(archive))).toBe(true)
  expect(Option.isNone(decode({ ...archive, permissions: { bash: "allow" } }))).toBe(true)
  expect(Option.isNone(decode({ ...archive, messages: [{ ...archive.messages[0], role: "system" }] }))).toBe(true)
  expect(
    Option.isNone(
      decode({ ...archive, messages: [{ ...archive.messages[0], metadata: { authorization: "private" } }] }),
    ),
  ).toBe(true)
  expect(
    Option.isNone(
      decode({
        ...archive,
        messages: [
          {
            ...archive.messages[0],
            parts: [{ type: "tool", name: "bash", callID: "old", status: "pending", input: "command", output: "" }],
          },
        ],
      }),
    ),
  ).toBe(true)
  expect(
    Option.isNone(
      decode({
        ...archive,
        messages: [
          {
            ...archive.messages[0],
            parts: [{ type: "attachment", name: "file", mediaType: "text/plain", url: "file:///private" }],
          },
        ],
      }),
    ),
  ).toBe(true)
})

test("publication requires the current explicit consent and omits optional local preferences", () => {
  const decode = Schema.decodeUnknownOption(PublicSession.Publish)
  const value = { consent: { version: 1, public: true, updates: false }, expiresAt: Date.now() + 1000 } as const
  expect(Option.getOrUndefined(decode(value))).toEqual(value)
  expect(Option.isNone(decode({ expiresAt: value.expiresAt }))).toBe(true)
  expect(Option.isNone(decode({ ...value, consent: { ...value.consent, public: false } }))).toBe(true)
  expect(Option.isNone(decode({ ...value, consent: { ...value.consent, version: 0 } }))).toBe(true)
  expect(Schema.encodeSync(PublicSession.Publish)(value)).not.toHaveProperty("remember")
})
