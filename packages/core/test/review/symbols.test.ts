import { describe, expect, test } from "bun:test"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { changedSymbols } from "@vectordevai/core/review/symbols"

function file(path: string, added: string[], removed: string[] = []) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => "-" + line),
    ...added.map((line) => "+" + line),
  ].join("\n")
}

const files = parseUnifiedDiff(
  [
    file(
      "src/auth.ts",
      [
        "export async function rotateToken(session: Session) {",
        "export class TokenStore {",
        "  async persist(value: string): Promise<void> {",
        "export const refreshInterval = 30_000",
        "const buildHeaders = (token: string) => ({",
        "export interface RefreshResult {",
        "export type Rotation = 'a' | 'b'",
        "  if (value) {",
        "  constructor(private store: Store) {",
      ],
      ["export function legacyRotate() {"],
    ),
    file("app/models.py", [
      "def charge_customer(amount):",
      "class Invoice:",
      "    def total(self):",
      "MAX_RETRIES = 3",
    ]),
    file("pkg/server.go", [
      "func NewServer(addr string) *Server {",
      "func (s *Server) Shutdown(ctx context.Context) error {",
      "type RouteHandler interface {",
      "func main() {",
      "type Handler interface {",
    ]),
    file("src/lib.rs", [
      "pub fn parse_config(input: &str) -> ParserConfig {",
      "pub struct ParserConfig {",
      "    fn validate(&self) -> bool {",
      "pub const MAX_DEPTH: usize = 8;",
    ]),
    file("src/PaymentService.java", [
      "public class PaymentService {",
      "    public Receipt chargeCard(Card card) throws PaymentException {",
      "    private void audit(String event) {",
    ]),
    file("README.md", ["function notCode() {"]),
  ].join("\n"),
)

describe("changedSymbols", () => {
  const all = changedSymbols(files, 50)
  const kind = (name: string) => all.find((item) => item.name === name)?.kind

  test("finds declarations in TS/JS, Python, Go, Rust and Java added lines", () => {
    expect(all.map((item) => item.name).toSorted()).toEqual(
      [
        "rotateToken",
        "TokenStore",
        "persist",
        "refreshInterval",
        "buildHeaders",
        "RefreshResult",
        "Rotation",
        "charge_customer",
        "Invoice",
        "total",
        "MAX_RETRIES",
        "NewServer",
        "Shutdown",
        "RouteHandler",
        "parse_config",
        "ParserConfig",
        "validate",
        "MAX_DEPTH",
        "PaymentService",
        "chargeCard",
        "audit",
      ].toSorted(),
    )
  })

  test("labels kinds and lines", () => {
    expect([kind("rotateToken"), kind("buildHeaders"), kind("refreshInterval"), kind("persist")]).toEqual([
      "function",
      "function",
      "variable",
      "method",
    ])
    expect([kind("total"), kind("Shutdown"), kind("validate"), kind("chargeCard"), kind("ParserConfig")]).toEqual([
      "method",
      "method",
      "method",
      "method",
      "type",
    ])
    expect(all.find((item) => item.name === "TokenStore")).toEqual({
      name: "TokenStore",
      path: "src/auth.ts",
      line: 2,
      kind: "class",
    })
  })

  test("ignores removed lines, keywords, common names and files that are not code", () => {
    const names = all.map((item) => item.name)
    for (const name of ["legacyRotate", "if", "constructor", "main", "Handler", "notCode"])
      expect(names).not.toContain(name)
  })

  test("returns 10 by default, exported declarations first", () => {
    expect(changedSymbols(files).map((item) => item.name)).toEqual([
      "rotateToken",
      "TokenStore",
      "RefreshResult",
      "Rotation",
      "charge_customer",
      "Invoice",
      "NewServer",
      "RouteHandler",
      "parse_config",
      "ParserConfig",
    ])
  })

  test("lists a name once", () => {
    const twice = parseUnifiedDiff(file("a.ts", ["export function shared() {", "  function shared() {"]))
    expect(changedSymbols(twice)).toEqual([{ name: "shared", path: "a.ts", line: 1, kind: "function" }])
  })
})
