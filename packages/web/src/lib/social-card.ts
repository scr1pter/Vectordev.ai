export const SOCIAL_CARD_ENABLED = "VECTOR_OG_ENABLED"
export const MAX_TITLE_LENGTH = 120
export const STATIC_SOCIAL_IMAGE = "https://vectordev.ai/vector-logo.png"

/** ASCII keeps this renderer on its bundled font, without remote font or emoji requests. */
export function validSocialTitle(value: string) {
  return value.length >= 1 && value.length <= MAX_TITLE_LENGTH && /^[\x20-\x7e]+$/.test(value) && value.trim() === value
}

export function socialCardImage(title: string, enabled: boolean) {
  if (!enabled) return STATIC_SOCIAL_IMAGE
  const plain = title
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, "...")
    .trim()
  if (!validSocialTitle(plain)) return STATIC_SOCIAL_IMAGE
  return `https://vectordev.ai/api/og?title=${encodeURIComponent(plain)}`
}
