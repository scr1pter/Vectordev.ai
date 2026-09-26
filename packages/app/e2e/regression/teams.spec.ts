import { expect, test } from "@playwright/test"

const team = {
  accountID: "fixture-account",
  accountEmail: "fixture@example.invalid",
  accountUrl: "https://vectordev.ai",
  orgID: "fixture-team",
  orgName: "Fixture team",
  active: false,
}

test("team settings switch only after explicit Apply and failures remain reviewable", async ({ page }) => {
  const requests: unknown[] = []
  await page.route("**/fixture/teams", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { enabled: true, orgs: [team] } })
    requests.push(route.request().postDataJSON())
    return route.fulfill({ status: requests.length === 1 ? 503 : 200, json: { ok: requests.length > 1 } })
  })
  await page.goto("/e2e/fixtures/teams.html")
  await expect(page.getByRole("option", { name: "Fixture team", exact: true })).toBeAttached()
  await page.getByLabel("Workspace team").selectOption(team.orgID)
  expect(requests).toEqual([])
  await page.getByRole("button", { name: "Apply team settings" }).click()
  await expect(page.getByRole("alert")).toContainText("could not confirm the switch")
  await expect(page.getByLabel("Workspace team")).toHaveValue("")
  await page.getByLabel("Workspace team").selectOption(team.orgID)
  await page.getByRole("button", { name: "Apply team settings" }).click()
  await expect(page.getByRole("status")).toContainText("Using Fixture team")
  await page.getByLabel("Workspace team").selectOption("")
  await page.getByRole("button", { name: "Apply team settings" }).click()
  await expect(page.getByRole("status")).toHaveText("Using Personal workspace.")
  expect(requests).toEqual([{ orgID: team.orgID }, { orgID: team.orgID }, { orgID: null }])
})

test("Personal workspace recovery remains available after the team list fails", async ({ page }) => {
  const requests: unknown[] = []
  await page.route("**/fixture/teams", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ status: 503, json: { error: "unavailable" } })
    requests.push(route.request().postDataJSON())
    return route.fulfill({ json: { ok: true } })
  })
  await page.goto("/e2e/fixtures/teams.html")
  await expect(page.getByRole("alert")).toContainText("could not refresh your teams")
  await page.getByRole("button", { name: "Apply team settings" }).click()
  await expect(page.getByRole("status")).toHaveText("Using Personal workspace.")
  expect(requests).toEqual([{ orgID: null }])
})
