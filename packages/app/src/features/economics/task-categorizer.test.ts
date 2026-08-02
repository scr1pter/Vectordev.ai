import { describe, expect, test } from "bun:test"
import { categorizeTask } from "./task-categorizer"

describe("categorizeTask", () => {
  test("classifies documentation prompts", () => {
    expect(categorizeTask("Update the README with setup instructions")).toBe("documentation")
    expect(categorizeTask("Write docs for the new API client")).toBe("documentation")
    expect(categorizeTask("Add a changelog entry for this release")).toBe("documentation")
  })

  test("classifies bug-fix prompts", () => {
    expect(categorizeTask("The app has a crash on login")).toBe("bug-fix")
    expect(categorizeTask("There's a bug in the checkout flow")).toBe("bug-fix")
    expect(categorizeTask("Handle the exception thrown on empty input")).toBe("bug-fix")
  })

  test("classifies small-edit prompts", () => {
    expect(categorizeTask("Rename this button component")).toBe("small-edit")
    expect(categorizeTask("Just a tiny tweak to the spacing")).toBe("small-edit")
  })

  test("classifies frontend prompts", () => {
    expect(categorizeTask("Style the settings page")).toBe("frontend")
    expect(categorizeTask("Update the layout of the sidebar component")).toBe("frontend")
  })

  test("classifies backend prompts", () => {
    expect(categorizeTask("Add a new endpoint for user profiles")).toBe("backend")
    expect(categorizeTask("Write a database migration for the orders table")).toBe("backend")
  })

  test("classifies refactor prompts", () => {
    expect(categorizeTask("Clean up the session module")).toBe("refactor")
    expect(categorizeTask("Reorganize the utils folder")).toBe("refactor")
  })

  test("classifies architecture prompts", () => {
    expect(categorizeTask("Design the schema for the new store")).toBe("architecture")
    expect(categorizeTask("Plan the system design for multi-tenant support")).toBe("architecture")
  })

  test("classifies testing prompts", () => {
    expect(categorizeTask("Write unit tests for the checkout flow")).toBe("testing")
    expect(categorizeTask("Improve test coverage for the parser")).toBe("testing")
  })

  test("falls back to general when nothing matches", () => {
    expect(categorizeTask("Say hello to the user on first launch")).toBe("general")
    expect(categorizeTask("")).toBe("general")
    expect(categorizeTask("   ")).toBe("general")
  })

  test("precedence: documentation beats bug-fix", () => {
    expect(categorizeTask("Fix a bug in the documentation")).toBe("documentation")
  })

  test("precedence: bug-fix beats small-edit", () => {
    expect(categorizeTask("Fix this typo in the header")).toBe("bug-fix")
  })

  test("precedence: small-edit beats frontend", () => {
    expect(categorizeTask("Rename this button component")).toBe("small-edit")
  })

  test("precedence: frontend beats backend", () => {
    expect(categorizeTask("Style the API settings page")).toBe("frontend")
  })

  test("precedence: backend beats refactor", () => {
    expect(categorizeTask("Refactor the database endpoint")).toBe("backend")
  })

  test("precedence: refactor beats architecture", () => {
    expect(categorizeTask("Restructure the system design")).toBe("refactor")
  })

  test("precedence: architecture beats testing", () => {
    expect(categorizeTask("Design the test coverage schema")).toBe("architecture")
  })

  test("does not false-positive on short keyword substrings", () => {
    // "ui" and "db" are real keywords but must not match inside unrelated
    // words that merely contain those letters ("build" embeds "ui", "handbook"
    // embeds "db") — the classifier requires a whole-word match.
    expect(categorizeTask("Build the release artifact")).toBe("general")
    expect(categorizeTask("Send the handbook to the new hire")).toBe("general")
  })
})
