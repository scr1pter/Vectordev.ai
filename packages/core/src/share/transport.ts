import { PublicSession } from "@vectordevai/schema/public-session"
import { Option, Schema } from "effect"

export function shareID(url: string) {
  const match = /^https:\/\/vectordev\.ai\/s\/([a-f0-9]{32})$/.exec(url)
  if (!match)
    throw new PublicSession.Error({ code: "INVALID", message: "Use a Vector share URL: https://vectordev.ai/s/<id>." })
  return match[1]!
}

export function accountOwner(token: string | undefined) {
  const raw = token?.match(/^vct_([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/)?.[1]
  const decoded =
    raw &&
    Option.getOrUndefined(
      Schema.decodeUnknownOption(
        Schema.fromJsonString(Schema.Struct({ sub: Schema.String.check(Schema.isMinLength(1)) })),
      )(Buffer.from(raw, "base64url").toString("utf8")),
    )
  if (!decoded)
    throw new PublicSession.Error({
      code: "SIGN_IN_REQUIRED",
      message: "Sign in to your Vector account before sharing a session.",
    })
  // This is only a local consent/storage identity. The hosted service verifies the signature and owner.
  return decoded.sub
}

export function encodedBody(value: unknown) {
  const body = JSON.stringify(value)
  if (new TextEncoder().encode(body).byteLength > PublicSession.MAX_BYTES)
    throw new PublicSession.Error({
      code: "TOO_LARGE",
      message: "This conversation is too large to share. Export a local JSON file instead.",
    })
  return body
}

export function makeShareTransport(input: { token: () => Promise<string | undefined>; fetch?: typeof fetch }) {
  const request = async (method: string, id?: string, body?: unknown) => {
    const token = method === "GET" ? undefined : await input.token()
    if (method !== "GET") accountOwner(token)
    const response = await (input.fetch ?? fetch)(`https://vectordev.ai/api/shares${id ? `/${id}` : ""}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? encodedBody(body) : undefined,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      const code =
        response.status === 400
          ? "INVALID"
          : response.status === 401 || response.status === 403
            ? "SIGN_IN_REQUIRED"
            : response.status === 404
              ? "NOT_FOUND"
              : response.status === 409
                ? "CONFLICT"
                : response.status === 413
                  ? "TOO_LARGE"
                  : "UNAVAILABLE"
      throw new PublicSession.Error({
        code,
        message:
          code === "INVALID"
            ? "Vector could not accept this share. Review the conversation and expiry before trying again."
            : code === "NOT_FOUND"
              ? "This public session has expired or was removed."
              : code === "SIGN_IN_REQUIRED"
                ? "Sign in to the Vector account that owns this share."
                : code === "CONFLICT"
                  ? "This share changed or was removed. Refresh before trying again."
                  : code === "TOO_LARGE"
                    ? "This conversation is too large to share. Export a local JSON file instead."
                    : "Vector could not update the public session. Try again; your local conversation is safe.",
      })
    }
    if (method === "DELETE") {
      await response.body?.cancel().catch(() => undefined)
      return
    }
    const reader = response.body?.getReader()
    if (!reader) throw new PublicSession.Error({ code: "INVALID", message: "Vector returned an empty share response." })
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.byteLength
        if (size > PublicSession.MAX_RESPONSE_BYTES)
          throw new PublicSession.Error({
            code: "TOO_LARGE",
            message: "The public session exceeds Vector's import size limit.",
          })
        chunks.push(result.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    const result = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(Buffer.concat(chunks).toString("utf8")),
    )
    if (result === undefined)
      throw new PublicSession.Error({ code: "INVALID", message: "Vector returned invalid session data." })
    return result
  }
  const validate = (value: PublicSession.Info, id: string) => {
    if (value.id !== id || value.url !== `https://vectordev.ai/s/${id}`)
      throw new PublicSession.Error({ code: "INVALID", message: "Vector returned a different share identity." })
    if (value.expiresAt <= Date.now())
      throw new PublicSession.Error({ code: "NOT_FOUND", message: "This public session has expired." })
    return value
  }
  return {
    create: async (value: PublicSession.Create) =>
      validate(
        Schema.decodeUnknownSync(PublicSession.Info, { onExcessProperty: "error" })(
          await request("POST", undefined, value),
        ),
        value.id,
      ),
    update: async (id: string, value: PublicSession.Update) =>
      validate(
        Schema.decodeUnknownSync(PublicSession.Info, { onExcessProperty: "error" })(await request("PUT", id, value)),
        id,
      ),
    remove: async (id: string, secret: string) => {
      await request("DELETE", id, { secret })
    },
    read: async (url: string) => {
      const id = shareID(url)
      const value = Schema.decodeUnknownSync(PublicSession.Snapshot, { onExcessProperty: "error" })(
        await request("GET", id),
      )
      validate(value, id)
      return value
    },
  }
}
