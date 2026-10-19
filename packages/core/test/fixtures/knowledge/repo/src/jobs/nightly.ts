import * as search from "../search/index"

export function nightly() {
  return search.reindexAll(async () => [])
}
