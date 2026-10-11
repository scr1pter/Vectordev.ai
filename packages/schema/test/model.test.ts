import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "../src/model"
import { Provider } from "../src/provider"

test("an empty model is what the schema would make from the same fields, and decodes as one", () => {
  const providerID = Provider.ID.make("openai")
  const modelID = Model.ID.make("gpt-5.5")
  const empty = Model.Info.empty(providerID, modelID)

  expect(empty).toEqual(
    Model.Info.make({
      id: modelID,
      providerID,
      name: modelID,
      api: { id: modelID, type: "native", settings: {} },
      capabilities: { tools: false, input: [], output: [] },
      request: { headers: {}, body: {} },
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 0, output: 0 },
    }),
  )
  expect(Schema.decodeUnknownSync(Model.Info)(empty)).toEqual(empty)
  // Each call gives a value of its own, since the catalog fills it in place.
  expect(Model.Info.empty(providerID, modelID).request.headers).not.toBe(empty.request.headers)
})
