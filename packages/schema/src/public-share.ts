import { Option, Schema } from "effect"

export class PublicShareRemovalError extends Schema.TaggedErrorClass<PublicShareRemovalError>()(
  "PublicShareRemovalError",
  { links: Schema.Array(Schema.String), message: Schema.String },
  { httpApiStatus: 409 },
) {}

export function publicShareWarning(links: readonly string[]) {
  return new PublicShareRemovalError({
    links,
    message: `This session or one of its child sessions was shared publicly with an earlier release. Vector can no longer remove that public copy. Save these links before deleting the local session: ${links.join(", ")}`,
  })
}

export const SessionDeleteResult = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    deleted: Schema.Literal(true),
    warnings: Schema.Array(Schema.String),
    links: Schema.Array(Schema.String),
  }),
])

const decodePublicShareError = Schema.decodeUnknownOption(PublicShareRemovalError)
export function publicShareError(input: unknown) {
  return Option.getOrUndefined(decodePublicShareError(input))
}
