// The single review Vector posts per run. The event is always COMMENT, and commit_id is always the reviewed head,
// so GitHub checks the anchors against the diff of the exact commit that was reviewed.

import { buildInlineBody, buildReviewBody, type RepoRef } from "./format"
import { parseReviewMarker } from "./state"
import type { PlacedFinding, Side, Trust } from "./types"

export interface CreateReviewPayload {
  commit_id: string
  event: "COMMENT"
  body: string
  comments: Array<{ path: string; body: string; line: number; side: Side; start_line?: number; start_side?: Side }>
}

type ReviewComment = CreateReviewPayload["comments"][number]

// `leads` carries the "Returned after being fixed" and "Raised to Blocking" lines by finding id (inlineLeads in
// format.ts); `repo` is the only link target the sanitizer keeps.
export function buildCreateReviewPayload(input: {
  head: string
  inline: PlacedFinding[]
  body: string
  suggestions: boolean
  trust: Trust
  leads?: Record<string, string>
  repo?: RepoRef
}): CreateReviewPayload {
  return {
    commit_id: input.head,
    event: "COMMENT",
    body: input.body,
    comments: input.inline.map((finding) => {
      // A fix is committable only when every rule allows it; otherwise it is shown as a diff block.
      const committable =
        finding.suggestion !== undefined &&
        input.suggestions &&
        finding.suggestionAllowed &&
        (input.trust === "trusted" || finding.verified === true)
      const comment: ReviewComment = {
        path: finding.anchor.path,
        body: buildInlineBody(finding, {
          head: input.head,
          trust: input.trust,
          suggestion: finding.suggestion === undefined ? "none" : committable ? "commit" : "diff",
          lead: input.leads?.[finding.id],
          repo: input.repo,
        }),
        line: finding.anchor.line,
        side: finding.anchor.side,
      }
      if (finding.anchor.startLine !== undefined && finding.anchor.startLine < finding.anchor.line) {
        comment.start_line = finding.anchor.startLine
        comment.start_side = finding.anchor.side
      }
      return comment
    }),
  }
}

// After a 422, the comments are split in halves and each half is posted as its own review, so one bad anchor
// never drops the others. The second half's body is the short "(continued)" line with the same marker.
export function splitHalves(payload: CreateReviewPayload): [CreateReviewPayload, CreateReviewPayload] {
  const middle = Math.ceil(payload.comments.length / 2)
  const marker = parseReviewMarker(payload.body)
  const body = marker
    ? buildReviewBody({ head: payload.commit_id, run: marker.run, inline: [], continued: true })
    : `Vector review of \`${payload.commit_id.slice(0, 7)}\` (continued).`
  return [
    { ...payload, comments: payload.comments.slice(0, middle) },
    { ...payload, body, comments: payload.comments.slice(middle) },
  ]
}
