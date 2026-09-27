import notices from "../../../../THIRD_PARTY_NOTICES.md" with { type: "text" }

// The earlier product's name may appear only inside its required MIT notice (the
// upstream-free compliance test enforces this), so it is read from that notice.
export const legacyName = notices
  .split("<!-- vector-upstream-attribution -->")[1]
  ?.match(/^Copyright \(c\) \d{4} (.+)$/m)?.[1]
  ?.trim()
  .toLowerCase()

// The exact prefix the earlier product gave its environment variables. No other
// prefix is ever read: unrelated tools use the same suffixes for their own settings.
export const legacyPrefix = legacyName ? `${legacyName.toUpperCase().replace(/\W+/g, "_")}_` : undefined
