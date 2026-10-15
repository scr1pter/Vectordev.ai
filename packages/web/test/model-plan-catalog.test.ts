import { describe, expect, test } from "bun:test"
import { MODEL_PLAN_OPTIONS } from "../../../api/_lib/model-plan-config"
import { auditModelPlanCatalog } from "../scripts/model-plan-catalog"

const configured = {
  id: "example/coder",
  name: "Coder",
  contextLength: 128000,
  maxOutputTokens: 8192,
  inputPrice: 0.3,
  outputPrice: 1.2,
}
const model = {
  id: configured.id,
  context_length: 256000,
  supported_parameters: ["tools", "tool_choice"],
}
const endpoint = {
  model_id: configured.id,
  provider_name: "Example",
  tag: "example/fp8",
  context_length: 256000,
  max_completion_tokens: 32768,
  pricing: { prompt: "0.0000003", completion: "0.0000012", input_cache_read: "0.00000003", discount: 0 },
  supported_parameters: [...MODEL_PLAN_OPTIONS],
  status: 0,
}

describe("configured Codium model audit", () => {
  test("only reviewed precision endpoints qualify when a quantization allowlist is configured", () => {
    const result = auditModelPlanCatalog(
      [{ ...configured, quantizations: ["fp8", "bf16"] }],
      [model],
      [
        { ...endpoint, tag: "fp4", quantization: "fp4" },
        { ...endpoint, tag: "bf16", quantization: "bf16" },
        { ...endpoint, tag: "unknown" },
      ],
    )
    expect(result[0]!.ok).toBe(true)
    expect(result[0]!.providers.map((provider) => provider.id)).toEqual(["bf16"])
  })
  test("keeps the configured model and finds a capable endpoint rather than the cheapest incompatible one", () => {
    const result = auditModelPlanCatalog(
      [configured],
      [model],
      [
        {
          ...endpoint,
          tag: "cheap",
          context_length: 64000,
          pricing: { prompt: "0.00000001", completion: "0.00000002" },
        },
        endpoint,
        { ...endpoint, model_id: "other/cheap" },
      ],
    )
    expect(result).toHaveLength(1)
    expect(result[0].model).toBe(configured.id)
    expect(result[0].ok).toBe(true)
    expect(result[0].providers.map((provider) => provider.id)).toEqual(["example/fp8"])
    expect(result[0].providers[0].inputPrice).toBe(0.3)
  })

  test.each([
    { status: 1 },
    { supported_parameters: ["tools"] },
    { context_length: 64000 },
    { max_completion_tokens: 4096 },
    { max_completion_tokens: null },
    { tag: "" },
    { pricing: { ...endpoint.pricing, prompt: "0.00000031" } },
    { pricing: { ...endpoint.pricing, completion: "0.00000121" } },
    { pricing: { ...endpoint.pricing, request: "0.0001" } },
    { pricing: { ...endpoint.pricing, image: "0.001" } },
    { pricing: { ...endpoint.pricing, input_cache_write: "0.0000004" } },
    { pricing: { ...endpoint.pricing, prompt: "" } },
    { pricing: { ...endpoint.pricing, completion: "NaN" } },
    { pricing: { ...endpoint.pricing, prompt: null } },
  ])("rejects unavailable, incompatible, or over-budget endpoint %j", (override) => {
    const result = auditModelPlanCatalog([configured], [model], [{ ...endpoint, ...override }])[0]
    expect(result.ok).toBe(false)
    expect(result.providers).toEqual([])
    expect(result.failures[0]).toContain("No available ZDR endpoint")
    expect(result.failures.length).toBeGreaterThan(1)
  })

  test("checks reachable long-context price overrides against the configured ceiling", () => {
    const pricing = {
      ...endpoint.pricing,
      overrides: [{ min_prompt_tokens: 100000, prompt: "0.000001", completion: "0.000004" }],
    }
    expect(auditModelPlanCatalog([configured], [model], [{ ...endpoint, pricing }])[0].ok).toBe(false)
    expect(
      auditModelPlanCatalog([{ ...configured, contextLength: 64000 }], [model], [{ ...endpoint, pricing }])[0].ok,
    ).toBe(true)
    // The gateway keeps every prompt under its limit, so the threshold is out of reach in a larger window too.
    expect(
      auditModelPlanCatalog([{ ...configured, promptTokenLimit: 100000 }], [model], [{ ...endpoint, pricing }])[0].ok,
    ).toBe(true)
    expect(
      auditModelPlanCatalog([{ ...configured, promptTokenLimit: 100001 }], [model], [{ ...endpoint, pricing }])[0].ok,
    ).toBe(false)
    expect(
      auditModelPlanCatalog(
        [configured],
        [model],
        [
          {
            ...endpoint,
            pricing: { ...pricing, overrides: [{ min_prompt_tokens: 100000, prompt: "0.0000002" }] },
          },
        ],
      )[0].ok,
    ).toBe(true)
  })

  test("an endpoint must accept every option the gateway forwards to the model", () => {
    const tools = { ...endpoint, supported_parameters: ["tools", "tool_choice"] }
    const result = auditModelPlanCatalog(
      [{ ...configured, options: ["tools", "tool_choice", "stop"] }],
      [model],
      [tools, { ...endpoint, tag: "stops", supported_parameters: ["tools", "tool_choice", "stop"] }],
    )[0]
    expect(result.ok).toBe(true)
    expect(result.providers.map((provider) => provider.id)).toEqual(["stops"])
    // A model without its own list forwards the gateway's default options, so an endpoint without seed is left out.
    const defaults = auditModelPlanCatalog(
      [configured],
      [model],
      [
        {
          ...endpoint,
          tag: "seedless",
          supported_parameters: MODEL_PLAN_OPTIONS.filter((option) => option !== "seed"),
        },
        endpoint,
      ],
    )[0]
    expect(defaults.providers.map((provider) => provider.id)).toEqual(["example/fp8"])
    expect(auditModelPlanCatalog([configured], [model], [tools])[0]).toMatchObject({ ok: false, providers: [] })
  })

  test("accepts zero flat fees but rejects unknown positive fees and malformed pricing overrides", () => {
    expect(
      auditModelPlanCatalog(
        [configured],
        [model],
        [
          {
            ...endpoint,
            pricing: { ...endpoint.pricing, request: "0", image: 0 },
          },
        ],
      )[0].ok,
    ).toBe(true)
    expect(
      auditModelPlanCatalog(
        [configured],
        [model],
        [
          {
            ...endpoint,
            pricing: { ...endpoint.pricing, new_surcharge: "0.01" },
          },
        ],
      )[0].ok,
    ).toBe(false)
    // Web search is billed per search, which the gateway never requests; a malformed value still fails.
    expect(
      auditModelPlanCatalog(
        [configured],
        [model],
        [{ ...endpoint, pricing: { ...endpoint.pricing, web_search: "0.01" } }],
      )[0].ok,
    ).toBe(true)
    expect(
      auditModelPlanCatalog(
        [configured],
        [model],
        [{ ...endpoint, pricing: { ...endpoint.pricing, web_search: "x" } }],
      )[0].ok,
    ).toBe(false)
    expect(
      auditModelPlanCatalog(
        [configured],
        [model],
        [
          {
            ...endpoint,
            pricing: { ...endpoint.pricing, overrides: [{ prompt: "0.0000001" }] },
          },
        ],
      )[0].ok,
    ).toBe(false)
  })

  test("reports missing and expired model metadata even when an endpoint is present", () => {
    expect(auditModelPlanCatalog([configured], [], [endpoint])[0].failures).toEqual([
      "Model is missing or its catalog metadata is invalid.",
    ])
    expect(
      auditModelPlanCatalog(
        [configured],
        [{ ...model, expiration_date: "2026-10-08" }],
        [endpoint],
        Date.parse("2026-10-09"),
      )[0].ok,
    ).toBe(false)
    expect(auditModelPlanCatalog([configured], [{ ...model, context_length: 32000 }], [endpoint])[0].ok).toBe(false)
  })

  test("does not fill an unavailable configured slot with a different available model", () => {
    const result = auditModelPlanCatalog([configured, { ...configured, id: "example/second" }], [model], [endpoint])
    expect(result.map((item) => [item.model, item.ok])).toEqual([
      ["example/coder", true],
      ["example/second", false],
    ])
  })
})
