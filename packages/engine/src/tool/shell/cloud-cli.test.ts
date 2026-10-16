import { describe, expect, test } from "bun:test"

import { CloudCli } from "./cloud-cli"

const ask = (command: string) => CloudCli.request(command.split(" "))

describe("cloud CLI commands in the shell", () => {
  test("a Vercel deploy asks under publishing, naming production only when it is one", () => {
    for (const command of ["vercel", "vercel deploy", "vc --yes", "vercel ./site", "vercel --scope team-a deploy"]) {
      expect({ command, request: ask(command) }).toMatchObject({
        command,
        request: { permission: "vector_cloud_publish", provider: "Vercel", environment: "preview", action: "deploy" },
      })
    }
    for (const command of ["vercel --prod", "vercel deploy --prod --yes", "vercel deploy --target production"]) {
      expect({ command, request: ask(command) }).toMatchObject({
        command,
        request: { permission: "vector_cloud_publish", environment: "production" },
      })
    }
  })

  test("moving production, variables and project settings ask under their own permissions", () => {
    const cases = [
      ["vercel promote dpl_123", "vector_cloud_publish"],
      ["vercel rollback", "vector_cloud_publish"],
      ["vercel redeploy https://shop.vercel.app", "vector_cloud_publish"],
      ["vercel rm shop --yes", "vector_cloud_publish"],
      ["vercel alias set dpl_123 shop.com", "vector_cloud_publish"],
      ["vercel env add STRIPE_KEY production", "vector_cloud_environment"],
      ["vercel env rm STRIPE_KEY", "vector_cloud_environment"],
      ["vercel env pull .env.local", "vector_cloud_environment"],
      ["vercel pull --environment=production", "vector_cloud_environment"],
      ["vercel link --yes", "vector_cloud_hosting"],
      ["vercel domains add shop.com", "vector_cloud_hosting"],
      ["vercel project rm shop", "vector_cloud_hosting"],
      ["vercel api /v9/projects", "vector_cloud_hosting"],
    ] as const
    for (const [command, permission] of cases) {
      expect({ command, permission: ask(command)?.permission }).toEqual({ command, permission })
    }
  })

  test("local Vercel work and plain reads run without a cloud prompt", () => {
    for (const command of [
      "vercel dev",
      "vercel build",
      "vercel --version",
      "vercel -h",
      "vercel whoami",
      "vercel ls",
      "vercel logs https://shop.vercel.app",
      "vercel inspect dpl_123",
      "vercel env ls",
      "vercel domains ls",
      "vercel project ls",
      "vercel alias ls",
    ]) {
      expect({ command, request: ask(command) }).toEqual({ command, request: undefined })
    }
  })

  test("sees the CLI behind package runners and wrappers", () => {
    for (const command of [
      "npx --yes vercel@59.26.0 deploy --prod",
      "npx -p vercel vercel --prod",
      "bunx vercel --prod",
      "bun x vercel --prod",
      "pnpm dlx vercel --prod",
      "pnpm vercel --prod",
      "yarn dlx vercel --prod",
      "npm exec --yes -- vercel --prod",
      "env CI=1 vercel --prod",
      "time ./node_modules/.bin/vercel --prod",
      "C:\\Users\\ada\\AppData\\Roaming\\npm\\vercel.cmd --prod",
    ]) {
      expect({ command, request: ask(command) }).toMatchObject({
        command,
        request: { permission: "vector_cloud_publish", environment: "production" },
      })
    }
    for (const command of ["npm run deploy", "cat vercel.json", "git commit -m vercel", "npx prettier --write ."]) {
      expect({ command, request: ask(command) }).toEqual({ command, request: undefined })
    }
  })

  test("Supabase changes to the linked project, and reads of its data or keys, ask under database", () => {
    for (const command of [
      "supabase db push",
      "supabase db reset --linked",
      "supabase db dump --data-only",
      "supabase migration repair 20240101 --status applied",
      "supabase migration up --linked",
      "supabase link --project-ref abc",
      "supabase projects create shop --org-id org",
      "supabase projects api-keys --project-ref abc",
      "supabase orgs create ada",
      "supabase secrets set STRIPE_KEY=sk",
      "supabase functions deploy hello",
      "supabase branches get dev",
      "supabase encryption get-root-key",
      "supabase config push",
      "npx supabase@latest db push",
    ]) {
      expect({ command, request: ask(command) }).toMatchObject({
        command,
        request: { permission: "vector_cloud_database", provider: "Supabase" },
      })
    }
  })

  test("local Supabase development and settings reads run without a cloud prompt", () => {
    for (const command of [
      "supabase start",
      "supabase status",
      "supabase --version",
      "supabase gen types typescript --linked",
      "supabase db reset",
      "supabase db diff -f add_profiles",
      "supabase db push --local",
      "supabase migration new add_profiles",
      "supabase migration list",
      "supabase migration up",
      "supabase functions serve",
      "supabase secrets list",
      "supabase projects list",
      "supabase postgres-config get",
    ]) {
      expect({ command, request: ask(command) }).toEqual({ command, request: undefined })
    }
  })

  test("reads quoted program names and arguments as the shell does", () => {
    expect(CloudCli.request(['"vercel"', "'--prod'"])).toMatchObject({ environment: "production" })
  })
})
