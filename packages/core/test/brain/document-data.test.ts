import { describe, expect, test } from "bun:test"
import { BrainLimits } from "@vectordevai/core/brain/document/limits"
import { BrainDocument } from "@vectordevai/core/brain/document/read"
import { RULE_CASES } from "./fixture/documents"

const read = (text: string, name: string, limits = BrainLimits.LIMITS.worker) =>
  BrainDocument.read({ name, bytes: new TextEncoder().encode(text) }, limits)

const blocks = async (text: string, name: string) => {
  const result = await read(text, name)
  if (result.type === "refused") throw new Error(result.message)
  return {
    result,
    shapes: result.blocks.map((block) =>
      block.type === "table"
        ? `table:${block.header.join(",")}/${block.rows.map((row) => row.join(",")).join(";")}`
        : block.type === "list"
          ? "list"
          : `${block.type}${block.type === "heading" ? block.level : ""}:${block.text}`,
    ),
  }
}

describe("BrainDocument JSON and YAML", () => {
  test("an OpenAPI file reads as one heading per operation with its parameter and response tables", async () => {
    const yaml = RULE_CASES.find((cases) => cases.rule === "openapi-path")!.positive[0]!
    const { result, shapes } = await blocks(yaml, "api.yaml")
    expect(result.format).toBe("openapi")
    expect(result.title).toBe("Accounts API")
    expect(shapes).toEqual([
      "heading1:Accounts API",
      "paragraph:Version 2.1.",
      "heading2:GET /v1/users/{id}",
      "paragraph:Get a user.",
      "paragraph:Operation ID: getUser.",
      "table:Name,In,Type,Required,Description/id,path,string,yes,",
      "table:Status,Description/200,The user;404,No such user",
      "heading2:Schema User",
      "table:Property,Type,Required,Description/id,string,yes,The user id;email,string,no,",
    ])
  })

  test("Swagger 2 is an API too, and its host is recorded as a link", async () => {
    const swagger = RULE_CASES.find((cases) => cases.rule === "openapi-path")!.positive[2]!
    const { result, shapes } = await blocks(swagger, "legacy.yaml")
    expect(result.format).toBe("openapi")
    expect(shapes).toContain("heading2:GET /invoices")
    expect(result.links).toEqual(["https://api.example.com/v0"])
  })

  test("a JSON Schema reads as a heading and property table per definition", async () => {
    const { shapes } = await blocks(
      JSON.stringify({
        $schema: "x",
        title: "Invoice",
        properties: { id: { type: "string" } },
        definitions: { Line: { properties: { cents: { type: "integer" } } } },
      }),
      "invoice.schema.json",
    )
    expect(shapes).toEqual([
      "heading1:Invoice",
      "heading2:Schema Invoice",
      "table:Property,Type,Required,Description/id,string,no,",
      "heading2:Schema Line",
      "table:Property,Type,Required,Description/cents,integer,no,",
    ])
  })

  test("any other value reads as key paths, one table per top-level key", async () => {
    const { shapes } = await blocks("server:\n  port: 8080\n  hosts: [a, b]\nmode: fast\n", "config.yaml")
    expect(shapes).toEqual([
      "heading1:server",
      "table:Key,Value/server.port,8080;server.hosts[0],a;server.hosts[1],b",
      "heading1:mode",
      "table:Key,Value/mode,fast",
    ])
  })

  test("past 5,000 keys the rest is left out and flagged truncated", async () => {
    const { result } = await blocks(
      JSON.stringify(Object.fromEntries(Array.from({ length: 5_100 }, (_, index) => [`key${index}`, index]))),
      "big.json",
    )
    expect(result.warnings).toContain("truncated")
    expect(result.blocks.filter((block) => block.type === "table")).toHaveLength(5_000)
  })

  test("YAML builds no custom types, and a file of several documents reads as a list", async () => {
    const tagged = await read("run: !!js/function 'function () { globalThis.__vectorYamlRan = true }'\n", "x.yaml")
    expect((globalThis as { __vectorYamlRan?: boolean }).__vectorYamlRan).toBeUndefined()
    if (tagged.type !== "refused") expect(tagged.text).not.toContain("[Function")
    const { shapes } = await blocks("a: 1\n---\nb: 2\n", "multi.yaml")
    expect(shapes).toEqual(["heading1:[0]", "table:Key,Value/[0].a,1", "heading1:[1]", "table:Key,Value/[1].b,2"])
  })

  test("invalid JSON and YAML are refused, not thrown", async () => {
    expect(await read("{ not json", "bad.json")).toMatchObject({ type: "refused", reason: "invalid" })
    expect(await read("a: [unclosed\n", "bad.yaml")).toMatchObject({ type: "refused", reason: "invalid" })
  })
})
