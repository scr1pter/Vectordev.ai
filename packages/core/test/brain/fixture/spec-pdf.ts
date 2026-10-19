// A long generated spec for the keyword-stage bench and the knowledge eval: a numbered heading every fifth page, then
// body text with requirements, limits and an endpoint, about 520 tokens a page (150,000 for 300 pages).

import { pdf } from "./pdf"

const TOPICS = [
  "sessions",
  "uploads",
  "billing",
  "exports",
  "webhooks",
  "queues",
  "search",
  "reports",
  "imports",
  "audit",
]

export function specPdf(pages: number) {
  return pdf({ title: "Bench spec", pages: Array.from({ length: pages }, (_, index) => page(index)) })
}

/** Questions a reader of the spec asks, two for each topic. */
export const specQueries = () =>
  TOPICS.flatMap((topic) => [
    `how long may the ${topic} service take to finish a request?`,
    `how many times do clients retry the ${topic} endpoint after a 429?`,
  ])

function page(index: number) {
  const topic = TOPICS[index % TOPICS.length]!
  const lines = [
    ...(index % 5 === 0
      ? [
          {
            text: `${Math.floor(index / 5) + 1} ${topic[0]!.toUpperCase()}${topic.slice(1)} rules`,
            size: 16,
            font: "bold" as const,
          },
        ]
      : []),
    // 22 lines of about 95 characters.
    ...Array.from({ length: 22 }, (_, line) => {
      const n = index * 22 + line
      const text =
        line % 11 === 0
          ? `The ${topic} service MUST finish request ${n} within ${(n % 90) + 10} seconds or report a timeout.`
          : line % 11 === 5
            ? `Clients call GET /v1/${topic}/${n} with a bearer token and retry at most ${(n % 4) + 2} times after a 429.`
            : `The ${topic} module keeps record ${n} in the ${topic}_state table and replays it in order after a restart.`
      return { text, size: 10, font: "regular" as const }
    }),
  ]
  return {
    runs: lines.map((line, at) => ({ text: line.text, x: 54, y: 760 - at * 30, size: line.size, font: line.font })),
  }
}
