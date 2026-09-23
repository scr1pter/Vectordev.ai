export * as ModelCatalog from "./model-catalog"

import { define, inventory } from "./event"

const Refreshed = define({
  type: "model-catalog.refreshed",
  schema: {},
})
export const Event = { Refreshed, Definitions: inventory(Refreshed) }
