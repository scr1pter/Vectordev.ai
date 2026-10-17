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
      "vercel build",
      "vercel build --prod",
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
      "vercel deploy --prod --help",
      "vercel --prod -h",
      "command -v vercel",
      "command -V supabase",
    ]) {
      expect({ command, request: ask(command) }).toEqual({ command, request: undefined })
    }
  })

  test("a dev server or a build that downloads the project's variables asks under environment", () => {
    expect(ask("vercel dev")).toMatchObject({
      permission: "vector_cloud_environment",
      environment: "development",
      action: "dev",
    })
    expect(ask("vercel build --prod --yes")).toMatchObject({
      permission: "vector_cloud_environment",
      environment: "production",
      action: "build",
    })
    expect(ask("vercel build -y")).toMatchObject({ permission: "vector_cloud_environment", environment: "preview" })
  })

  test("sees the CLI behind wrappers that take options or a duration first", () => {
    for (const command of [
      "timeout 300 vercel deploy --prod",
      "gtimeout -s KILL 5m vercel --prod",
      "nice -n 10 vercel --prod",
      "nice -5 vercel --prod",
      "ionice -c 3 vercel --prod",
      "xargs vercel --prod",
      "xargs -n 1 -P 2 vercel --prod",
      "caffeinate -i vercel --prod",
      "caffeinate -t 600 vercel --prod",
      "doas vercel --prod",
      "doas -u ada vercel --prod",
      "sudo -u ada vercel --prod",
      "stdbuf -oL vercel --prod",
      "stdbuf -o L vercel --prod",
      "chronic vercel --prod",
      "unbuffer vercel --prod",
      "setsid vercel --prod",
      "find . -maxdepth 0 -exec vercel --prod ;",
    ]) {
      expect({ command, request: ask(command) }).toMatchObject({
        command,
        request: { permission: "vector_cloud_publish", environment: "production" },
      })
    }
  })

  test("sees the CLI behind package runner options that come before the verb", () => {
    for (const command of [
      "pnpm --filter web exec vercel --prod",
      "pnpm -F web exec vercel --prod",
      "pnpm -C apps/web dlx vercel --prod",
      "pnpm --dir apps/web exec vercel --prod",
      "pnpm -w exec vercel --prod",
      "pnpm -r --filter=web exec vercel --prod",
      "yarn --cwd web vercel deploy --prod",
      "yarn run vercel deploy --prod",
      "npm --prefix web exec vercel -- --prod",
      "npm -w web exec vercel -- --prod",
      "bun --cwd web x vercel --prod",
    ]) {
      expect({ command, request: ask(command) }).toMatchObject({
        command,
        request: { permission: "vector_cloud_publish", environment: "production" },
      })
    }
    for (const command of ["yarn run deploy", "pnpm --filter web run build", "npm --prefix web run deploy"]) {
      expect({ command, request: ask(command) }).toEqual({ command, request: undefined })
    }
  })

  test("hands a command line run from a string back to the shell to check", () => {
    const cases: Array<[string[], string]> = [
      [["eval", "vercel", "--prod"], "vercel --prod"],
      [["eval", '"vercel --prod"'], "vercel --prod"],
      [["watch", "-n", "5", "vercel", "--prod"], "vercel --prod"],
      [["sh", "-c", "'vercel --prod'"], "vercel --prod"],
      [["bash", "-lc", '"cd web && vercel --prod"'], "cd web && vercel --prod"],
      [["bash", "-euo", "pipefail", "-c", "'supabase db push'"], "supabase db push"],
      [["zsh", "-c", "'vercel --prod'", "zsh"], "vercel --prod"],
      [["env", "-S", "'vercel --prod'"], "vercel --prod"],
      [["npx", "-c", "'vercel --prod'"], "vercel --prod"],
      [["npm", "exec", "-c", "'vercel --prod'"], "vercel --prod"],
      [["pnpm", "-c", "exec", "'vercel --prod'"], "vercel --prod"],
      [["timeout", "60", "sh", "-c", "'vercel --prod'"], "vercel --prod"],
      [["xargs", "sh", "-c", "'vercel --prod'"], "vercel --prod"],
    ]
    for (const [tokens, script] of cases) {
      expect({ tokens, script: CloudCli.script(tokens), request: CloudCli.request(tokens) }).toEqual({
        tokens,
        script,
        request: undefined,
      })
    }
    // A script file is not read, and a plain command has no inner command line.
    for (const tokens of [
      ["bash", "deploy.sh"],
      ["sh", "-e", "deploy.sh"],
      ["vercel", "--prod"],
      ["ls", "-la"],
    ]) {
      expect({ tokens, script: CloudCli.script(tokens) }).toEqual({ tokens, script: undefined })
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
      "supabase test db --linked",
      "supabase test db --db-url postgres://db.example/postgres",
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
      "supabase test db",
      "supabase test new profiles",
      "supabase db push --help",
    ]) {
      expect({ command, request: ask(command) }).toEqual({ command, request: undefined })
    }
  })

  test("reads quoted program names and arguments as the shell does", () => {
    expect(CloudCli.request(['"vercel"', "'--prod'"])).toMatchObject({ environment: "production" })
    // Tokens arrive as the raw shell text, so quotes and escapes inside a word are the shell's to remove.
    const cases: Array<[string[], string]> = [
      [["ve''rcel", "--prod"], "production"],
      [['v"ercel"', "--prod"], "production"],
      [["v\\ercel", "--prod"], "production"],
      [["vercel", "--pr''od"], "production"],
      [["supa''base", "db", "push"], "linked project"],
      [["C:\\tools\\vercel.cmd", "--prod"], "production"],
    ]
    for (const [tokens, environment] of cases) {
      expect({ tokens, environment: CloudCli.request(tokens)?.environment }).toEqual({ tokens, environment })
    }
  })

  test("sees the CLI run by node, deno, corepack, script, arch and tracers", () => {
    const cases: Array<[string, string]> = [
      ["node node_modules/vercel/dist/index.js deploy --prod", "production"],
      ["node --require ./hook.js node_modules/.bin/vercel --prod", "production"],
      ["node node_modules/supabase/bin/supabase db push", "linked project"],
      ["deno run -A npm:vercel --prod", "production"],
      ["deno run -A npm:vercel@59 deploy", "preview"],
      ["corepack pnpm dlx vercel --prod", "production"],
      ["script -q /dev/null vercel --prod", "production"],
      ["arch -arm64 vercel --prod", "production"],
      ["strace -f -o trace.txt vercel --prod", "production"],
    ]
    for (const [command, environment] of cases) {
      expect({ command, environment: ask(command)?.environment }).toEqual({ command, environment })
    }
    expect(CloudCli.script(["script", "-q", "-c", '"vercel --prod"', "/dev/null"])).toBe("vercel --prod")
    for (const command of ["node build.js", "node -e 1", "script -q /dev/null ls", "deno run main.ts", "echo vercel"]) {
      expect({ command, request: ask(command) }).toEqual({ command, request: undefined })
    }
  })
})
