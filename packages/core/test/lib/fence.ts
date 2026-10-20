export * as FenceMatch from "./fence"

import { expect } from "bun:test"

// Web text blocks as WebFence writes them, whatever nonce each call drew. Engine tests import this by relative path,
// as they do core's other test fixtures.

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Matches one block: `attributes` are the opening tag's after its nonce, such as `url="…" tool="webfetch"`, the text
 * is the block's inside, and the closing tag must carry the opening tag's nonce. `after` is what follows the block.
 */
export function block(attributes: string, text: string, after = "") {
  return expect.stringMatching(
    new RegExp(
      `^<untrusted_web_page nonce="([0-9a-f]{16})"${attributes ? ` ${escaped(attributes)}` : ""}>\\n${escaped(text)}\\n</untrusted_web_page nonce="\\1">${escaped(after)}$`,
    ),
  )
}

/** Text with every block's nonce taken out, for a test that reads a block's insides or counts its tags. */
export function plain(text: string) {
  return text.replace(/ nonce="[0-9a-f]{16}"/g, "")
}
