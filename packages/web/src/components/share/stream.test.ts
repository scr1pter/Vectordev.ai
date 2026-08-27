import { describe, expect, test } from "bun:test"
import { parseShareStreamEvent, shareMessageBelongsToSession } from "./stream"

const sessionID = "ses_expected"
const messageID = "msg_expected"
const partID = "prt_expected"

describe("parseShareStreamEvent", () => {
  test("accepts records owned by the shared session", () => {
    expect(
      parseShareStreamEvent(
        { key: `session/info/${sessionID}`, content: { id: sessionID, title: "Shared session" } },
        sessionID,
      )?.type,
    ).toBe("info")
    expect(
      parseShareStreamEvent(
        { key: `session/message/${sessionID}/${messageID}`, content: { id: messageID, sessionID, parts: [] } },
        sessionID,
      )?.type,
    ).toBe("message")
    expect(
      parseShareStreamEvent(
        {
          key: `session/part/${sessionID}/${messageID}/${partID}`,
          content: { id: partID, sessionID, messageID, type: "text", text: "Hello" },
        },
        sessionID,
      )?.type,
    ).toBe("part")
  })

  test("accepts a legacy message whose session identity is in metadata", () => {
    expect(
      parseShareStreamEvent(
        {
          key: `session/message/${sessionID}/${messageID}`,
          content: { id: messageID, metadata: { sessionID }, parts: [] },
        },
        sessionID,
      )?.type,
    ).toBe("message")
  })

  test.each([
    { key: `session/info/ses_other`, content: { id: sessionID } },
    { key: `session/info/${sessionID}`, content: { id: "ses_other" } },
    { key: `session/message/ses_other/${messageID}`, content: { id: messageID, sessionID } },
    { key: `session/message/${sessionID}/${messageID}`, content: { id: messageID, sessionID: "ses_other" } },
    { key: `session/message/${sessionID}/${messageID}`, content: { id: "msg_other", sessionID } },
    {
      key: `session/message/${sessionID}/${messageID}`,
      content: { id: messageID, sessionID, metadata: { sessionID: "ses_other" } },
    },
    {
      key: `session/part/ses_other/${messageID}/${partID}`,
      content: { id: partID, sessionID, messageID },
    },
    {
      key: `session/part/${sessionID}/${messageID}/${partID}`,
      content: { id: partID, sessionID: "ses_other", messageID },
    },
    {
      key: `session/part/${sessionID}/${messageID}/${partID}`,
      content: { id: partID, sessionID, messageID: "msg_other" },
    },
    {
      key: `session/part/${sessionID}/${messageID}/${partID}`,
      content: { id: "prt_other", sessionID, messageID },
    },
  ])("rejects mismatched key and payload ownership", (event) => {
    expect(parseShareStreamEvent(event, sessionID)).toBeUndefined()
  })

  test("rejects embedded parts owned by another message or session", () => {
    expect(
      parseShareStreamEvent(
        {
          key: `session/message/${sessionID}/${messageID}`,
          content: {
            id: messageID,
            sessionID,
            parts: [{ id: partID, sessionID, messageID: "msg_other" }],
          },
        },
        sessionID,
      ),
    ).toBeUndefined()
  })
})

describe("shareMessageBelongsToSession", () => {
  test("requires a part's accepted parent message to match the shared session", () => {
    expect(shareMessageBelongsToSession(undefined, sessionID, messageID)).toBe(false)
    expect(shareMessageBelongsToSession({ id: messageID, sessionID: "ses_other", parts: [] }, sessionID, messageID)).toBe(
      false,
    )
    expect(shareMessageBelongsToSession({ id: "msg_other", sessionID, parts: [] }, sessionID, messageID)).toBe(false)
    expect(shareMessageBelongsToSession({ id: messageID, sessionID, parts: [] }, sessionID, messageID)).toBe(true)
  })
})
