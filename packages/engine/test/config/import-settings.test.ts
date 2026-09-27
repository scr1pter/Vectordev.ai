import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { EffectFlock } from "@vectordevai/core/util/effect-flock"
import { ConfigImport } from "@/config/import-settings"
import { ConfigMigration } from "@vectordevai/core/config/migration"
import { ConfigParse } from "@/config/parse"
import { GlobalBus } from "@/bus/global"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

// Historical fixture names come from retained attribution, never production code.
const notices = await Bun.file(new URL("../../../../THIRD_PARTY_NOTICES.md", import.meta.url)).text()
const previous = notices
  .split("<!-- vector-upstream-attribution -->")[1]
  ?.match(/^Copyright \(c\) \d{4} (.+)$/m)?.[1]
  ?.trim()
  .toLowerCase()
if (!previous) throw new Error("Missing attribution for historical upgrade fixture")

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, EffectFlock.node, CrossSpawnSpawner.node])))

it.live("imports neutral JSON and extensionless TOML while retaining the original files", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    for (const [name, text] of [
      ["config.json", '{"permission":{"bash":"deny"}}'],
      ["config", 'provider = "fixture"\nmodel = "model"\n[permission]\nedit = "deny"\n'],
    ]) {
      const directory = path.join(root, name.replace(/\W/g, ""))
      yield* fs.ensureDir(directory)
      yield* fs.writeFileString(path.join(directory, name), text)
      yield* ConfigImport.run(directory)
      expect(yield* fs.readFileString(path.join(directory, name))).toBe(text)
      const imported = yield* fs.readJson(path.join(directory, "vector.jsonc"))
      expect(imported).toMatchObject({
        $schema: "https://vectordev.ai/config.json",
        permission: name === "config" ? { edit: "deny" } : { bash: "deny" },
      })
      expect(yield* ConfigImport.run(directory)).toBeUndefined()
    }
  }),
)

it.live("imports recognized project assets and both config layers once without changing originals", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const source = path.join(directory, `.${previous}`)
    for (const name of [
      "agents/reviewer.md",
      "commands/review.md",
      "plugins/example.ts",
      "skills/review/SKILL.md",
      "themes/custom.json",
      "tools/example.ts",
    ])
      yield* fs.writeWithDirs(path.join(source, name), `fixture:${name}`)
    yield* fs.writeFileString(
      path.join(source, `${previous}.jsonc`),
      '{"permission":{"bash":"deny"},"theme":"custom","mcp":{"fixture":{"type":"local","command":["fixture"]}}}',
    )
    yield* fs.writeFileString(path.join(source, `${previous}.local.json`), '{"permission":{"edit":"deny"}}')
    yield* fs.writeWithDirs(path.join(directory, ".unrelated", "data.json"), '{"model":"must-not-import"}')
    const input = {
      directory,
      worktree: directory,
      home: path.join(directory, "home"),
      global: path.join(directory, "global"),
    }
    const imported = yield* ConfigMigration.discover(input)
    expect(imported).toHaveLength(3)
    const target = path.join(directory, ".vector")
    expect(yield* fs.readJson(path.join(target, "vector.jsonc"))).toMatchObject({
      permission: { bash: "deny" },
      theme: "custom",
    })
    expect(yield* fs.readJson(path.join(target, "vector.local.jsonc"))).toMatchObject({ permission: { edit: "deny" } })
    expect(yield* fs.exists(path.join(source, ".gitignore"))).toBe(false)
    for (const name of [
      "agents/reviewer.md",
      "commands/review.md",
      "plugins/example.ts",
      "skills/review/SKILL.md",
      "themes/custom.json",
      "tools/example.ts",
    ]) {
      expect(yield* fs.readFileString(path.join(target, name))).toBe(`fixture:${name}`)
      expect(yield* fs.readFileString(path.join(source, name))).toBe(`fixture:${name}`)
    }
    expect(yield* ConfigMigration.discover(input)).toEqual([])
  }),
)

it.live("protects current assets and respects disabled project config during migration", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeWithDirs(path.join(directory, `.${previous}`, "agents", "reviewer.md"), "earlier")
    yield* fs.writeWithDirs(path.join(directory, `.${previous}`, "commands", "review.md"), "earlier")
    yield* fs.writeWithDirs(path.join(directory, ".vector", "agents", "reviewer.md"), "current")
    const input = {
      directory,
      worktree: directory,
      home: path.join(directory, "home"),
      global: path.join(directory, "global"),
    }
    expect(yield* ConfigMigration.discover({ ...input, disableProject: true })).toEqual([])
    expect(String(yield* ConfigMigration.discover(input).pipe(Effect.exit))).toContain("conflict")
    expect(yield* fs.readFileString(path.join(directory, ".vector", "agents", "reviewer.md"))).toBe("current")
    expect(yield* fs.exists(path.join(directory, ".vector", "vector-migration.json"))).toBe(false)
  }),
)

it.live("skips unreadable folders and unrelated dot folders that only look like agent folders", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const home = path.join(root, "home")
    const directory = path.join(home, "project")
    for (const name of [
      "home/.cursor/agents/.keep",
      "home/.cursor/plugins/local/.keep",
      "home/.cursor/mcp.json",
      "home/.oh-my-zsh/plugins/git/git.plugin.zsh",
      "home/.oh-my-zsh/themes/robbyrussell.zsh-theme",
      "home/.oh-my-zsh/tools/upgrade.sh",
      "home/project/.github/agents/reviewer.md",
      "home/project/.github/skills/review/SKILL.md",
      "home/project/.obsidian/plugins/example/main.js",
      "home/project/.obsidian/themes/Minimal/theme.css",
      "home/project/.earlier-agent/agents/reviewer.md",
      "home/project/.earlier-agent/commands/review.md",
      "home/.Trash/deleted.json",
      "home/.locked/locked.json",
    ])
      yield* fs.writeWithDirs(path.join(root, name), "{}")
    yield* fs.writeFileString(
      path.join(home, ".cursor", "mcp.json"),
      '{"mcp":{"docs":{"type":"local","command":["x"]}}}',
    )
    yield* fs.writeFileString(
      path.join(directory, ".earlier-agent", "earlier-agent.json"),
      '{"$schema":"https://earlier-agent.ai/config.json","permission":{"bash":"deny"}}',
    )
    yield* fs.writeFileString(path.join(directory, "notes"), 'model = "must-not-import"\n')
    yield* fs.writeFileString(path.join(home, ".locked", "locked.json"), '{"model":"must-not-import"}')
    const locked = [path.join(home, ".Trash"), path.join(home, ".locked"), path.join(directory, "notes")]
    yield* Effect.forEach(locked, (item) => fs.chmod(item, 0o000))
    yield* Effect.addFinalizer(() => Effect.forEach(locked, (item) => fs.chmod(item, 0o755).pipe(Effect.ignore)))
    const input = { directory, worktree: directory, home, global: path.join(root, "global") }
    expect(yield* ConfigMigration.discover(input)).toEqual([])
    expect(yield* fs.exists(path.join(home, ".vector"))).toBe(false)
    expect(yield* fs.exists(path.join(directory, ".vector"))).toBe(false)
  }),
)

it.live("retries an earlier folder until it can be listed and skips unreadable folders inside it", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const home = path.join(root, "home")
    const global = path.join(root, "global")
    const parent = path.join(root, "work", "locked")
    const directory = path.join(parent, "app")
    const source = path.join(directory, `.${previous}`)
    yield* fs.writeWithDirs(path.join(home, `.${previous}`, `${previous}.json`), '{"model":"fixture/model"}')
    yield* fs.writeWithDirs(path.join(global, "config.json"), '{"model":"fixture/model"}')
    yield* fs.writeWithDirs(path.join(source, `${previous}.json`), '{"permission":{"bash":"deny"}}')
    yield* fs.writeWithDirs(path.join(source, "agents", "reviewer.md"), "reviewer")
    yield* fs.writeWithDirs(path.join(source, "commands", "secret.md"), "secret")
    yield* fs.writeWithDirs(path.join(source, "skills", "locked", "SKILL.md"), "locked")
    // Mode 0o311 keeps the parent traversable, so the project below it stays reachable while its listing fails.
    const modes = [
      [home, 0o000],
      [global, 0o000],
      [parent, 0o311],
      [source, 0o000],
    ] as const
    yield* Effect.forEach(modes, ([item, mode]) => fs.chmod(item, mode))
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...modes.map(([item]) => item), path.join(source, "skills", "locked")], (item) =>
        fs.chmod(item, 0o755).pipe(Effect.ignore),
      ),
    )
    const input = { directory, worktree: path.join(root, "work"), home, global }
    expect(yield* ConfigMigration.discover(input)).toEqual([])
    expect(yield* fs.exists(path.join(directory, ".vector"))).toBe(false)

    yield* fs.chmod(source, 0o755)
    yield* fs.chmod(path.join(source, "commands", "secret.md"), 0o000)
    yield* fs.chmod(path.join(source, "skills", "locked"), 0o000)
    const target = path.join(directory, ".vector")
    expect((yield* ConfigMigration.discover(input)).map((item) => item.target)).toEqual([
      path.join(target, "vector.jsonc"),
      target,
    ])
    expect(yield* fs.readJson(path.join(target, "vector.jsonc"))).toMatchObject({ permission: { bash: "deny" } })
    expect(yield* fs.readFileString(path.join(target, "agents", "reviewer.md"))).toBe("reviewer")
    expect(yield* fs.exists(path.join(target, "commands", "secret.md"))).toBe(false)
    expect(yield* fs.exists(path.join(target, "skills", "locked"))).toBe(false)
    expect(yield* fs.exists(path.join(target, "vector-migration.json"))).toBe(true)
    yield* Effect.forEach([home, global], (item) => fs.chmod(item, 0o755))
    expect(yield* fs.exists(path.join(home, ".vector"))).toBe(false)
    expect(yield* fs.exists(path.join(global, "vector.jsonc"))).toBe(false)
  }),
)

it.live("imports a linked earlier folder and keeps linked assets as links", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const shared = path.join(root, "shared")
    const directory = path.join(root, "project")
    yield* fs.writeWithDirs(path.join(shared, "earlier", `${previous}.json`), '{"permission":{"bash":"deny"}}')
    yield* fs.writeWithDirs(path.join(shared, "agent.md"), "linked agent")
    yield* fs.writeWithDirs(path.join(shared, "skills", "review", "SKILL.md"), "linked skill")
    yield* fs.writeWithDirs(path.join(shared, "earlier", "commands", "review.md"), "review")
    yield* fs.ensureDir(path.join(shared, "earlier", "agents"))
    yield* fs.ensureDir(directory)
    const source = path.join(directory, `.${previous}`)
    yield* fs.symlink(path.join(shared, "earlier"), source)
    yield* fs.symlink(path.join(shared, "agent.md"), path.join(source, "agents", "linked.md"))
    yield* fs.symlink(path.join(shared, "missing.md"), path.join(source, "agents", "broken.md"))
    yield* fs.symlink(path.join(shared, "skills"), path.join(source, "skills"))
    const input = { directory, worktree: directory, home: path.join(root, "home"), global: path.join(root, "global") }
    const target = path.join(directory, ".vector")
    expect((yield* ConfigMigration.discover(input)).map((item) => item.target)).toEqual([
      path.join(target, "vector.jsonc"),
      target,
    ])
    expect(yield* fs.readJson(path.join(target, "vector.jsonc"))).toMatchObject({ permission: { bash: "deny" } })
    expect(yield* fs.readFileString(path.join(target, "commands", "review.md"))).toBe("review")
    expect(yield* fs.readLink(path.join(target, "agents", "linked.md"))).toBe(
      yield* fs.realPath(path.join(shared, "agent.md")),
    )
    expect(yield* fs.readFileString(path.join(target, "skills", "review", "SKILL.md"))).toBe("linked skill")
    expect(yield* fs.readLink(path.join(target, "skills"))).toBe(yield* fs.realPath(path.join(shared, "skills")))
    expect(yield* fs.exists(path.join(target, "agents", "broken.md"))).toBe(false)
    expect(yield* ConfigMigration.discover(input)).toEqual([])
    // An import interrupted before its marker is retried without treating its own links as conflicts.
    yield* fs.remove(path.join(target, "vector-migration.json"))
    expect((yield* ConfigMigration.discover(input)).map((item) => item.target)).toEqual([target])
  }),
)

it.live("imports config-only earlier project and home folders, including runtime MCP servers", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const directory = path.join(root, "project")
    const source = path.join(directory, `.${previous}`)
    yield* fs.writeWithDirs(
      path.join(source, `${previous}.local.json`),
      JSON.stringify({
        $schema: `https://${previous}.ai/config.json`,
        mcp: { docs: { type: "remote", url: "https://example.test/mcp", headers: { Authorization: "placeholder" } } },
      }),
    )
    yield* fs.writeFileString(path.join(source, `${previous}.json`), '{"permission":{"bash":"deny"}}')
    yield* fs.writeFileString(path.join(source, "package.json"), `{"dependencies":{"@${previous}-ai/plugin":"1"}}`)
    yield* fs.writeFileString(path.join(source, ".gitignore"), "node_modules\npackage.json\n")
    yield* fs.writeWithDirs(path.join(source, "node_modules", "fixture", "index.js"), "")
    const home = path.join(root, "home")
    yield* fs.writeWithDirs(path.join(home, `.${previous}`, `${previous}.jsonc`), '{"model":"fixture/model"}')
    yield* fs.writeWithDirs(path.join(home, `.${previous}`, "bin", "fixture"), "")
    const input = { directory, worktree: directory, home, global: path.join(root, "global") }
    const imported = yield* ConfigMigration.discover(input)
    const target = path.join(directory, ".vector")
    expect(imported.map((item) => item.target)).toEqual([
      path.join(home, ".vector", "vector.jsonc"),
      path.join(target, "vector.jsonc"),
      path.join(target, "vector.local.jsonc"),
    ])
    expect(yield* fs.readJson(path.join(home, ".vector", "vector.jsonc"))).toMatchObject({ model: "fixture/model" })
    expect(yield* fs.exists(path.join(home, ".vector", "bin"))).toBe(false)
    expect(yield* fs.readJson(path.join(target, "vector.jsonc"))).toMatchObject({ permission: { bash: "deny" } })
    expect(yield* fs.readJson(path.join(target, "vector.local.jsonc"))).toMatchObject({
      mcp: { docs: { type: "remote", url: "https://example.test/mcp", headers: { Authorization: "placeholder" } } },
    })
    expect(yield* fs.exists(path.join(target, "package.json"))).toBe(false)
    expect(yield* fs.exists(path.join(target, "node_modules"))).toBe(false)
    expect(yield* ConfigMigration.discover(input)).toEqual([])
  }),
)

it.live("merges neutral, prior json and jsonc settings once without changing originals", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    const originals = {
      "config.json": JSON.stringify({ shell: "/bin/zsh", permission: { bash: "deny" }, model: "neutral/model" }),
      "previous.json": JSON.stringify({
        model: "json/model",
        disabled_providers: ["openai"],
        permission: { edit: "deny" },
      }),
      "previous.jsonc":
        '{\n // Keep this explanation.\n "$schema": "https://example.test/config.json",\n "model": "jsonc/model",\n "mcp": {"docs": {"type": "remote", "url": "https://example.test/mcp"}}\n}',
      "vector.jsonc": '{"$schema":"https://vectordev.ai/config.json"}',
    }
    yield* Effect.forEach(Object.entries(originals), ([file, text]) => fs.writeFileString(path.join(dir, file), text))
    const notices: unknown[] = []
    const listener = (event: { payload: unknown }) => notices.push(event.payload)
    GlobalBus.on("event", listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
    const result = yield* ConfigImport.run(dir)
    expect(result?.sources.map((file) => path.basename(file))).toEqual([
      "config.json",
      "previous.json",
      "previous.jsonc",
    ])
    const text = yield* fs.readFileString(path.join(dir, "vector.jsonc"))
    expect(ConfigParse.jsonc(text, "test")).toMatchObject({
      $schema: "https://vectordev.ai/config.json",
      shell: "/bin/zsh",
      model: "jsonc/model",
      disabled_providers: ["openai"],
      permission: { bash: "deny", edit: "deny" },
      mcp: { docs: { type: "remote", url: "https://example.test/mcp" } },
    })
    expect(text).toContain("Keep this explanation.")
    expect(notices).toHaveLength(1)
    expect(yield* ConfigImport.run(dir)).toBeUndefined()
    expect(notices).toHaveLength(1)
    for (const [file, original] of Object.entries(originals).filter(([file]) => file !== "vector.jsonc")) {
      expect(yield* fs.readFileString(path.join(dir, file))).toBe(original)
    }
  }),
)

it.live("does not overwrite active Vector settings or import unrelated and credential files", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeFileString(path.join(dir, "vector.json"), '{"permission":{"bash":"deny"}}')
    yield* fs.writeFileString(path.join(dir, "previous.json"), '{"permission":{"bash":"allow"}}')
    expect(yield* ConfigImport.run(dir)).toBeUndefined()
    expect(yield* fs.exists(path.join(dir, "vector.jsonc"))).toBe(false)
    yield* fs.remove(path.join(dir, "vector.json"))
    yield* fs.remove(path.join(dir, "previous.json"))
    yield* fs.writeFileString(path.join(dir, "other.json"), '{"repository":"unrelated"}')
    yield* fs.writeFileString(path.join(dir, "auth.json"), '{"model":"must-not-import"}')
    expect(yield* ConfigImport.run(dir)).toBeUndefined()
    expect(yield* fs.exists(path.join(dir, "vector.jsonc"))).toBe(false)
  }),
)

it.live("refuses ambiguous config families and malformed schema-identified settings", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeFileString(path.join(dir, "one.json"), '{"permission":{"bash":"deny"}}')
    yield* fs.writeFileString(path.join(dir, "two.json"), '{"permission":{"bash":"allow"}}')
    expect(String(yield* ConfigImport.run(dir).pipe(Effect.exit))).toContain("Multiple settings files")
    expect(yield* fs.exists(path.join(dir, "vector.jsonc"))).toBe(false)
    yield* fs.remove(path.join(dir, "two.json"))
    yield* fs.writeFileString(
      path.join(dir, "one.json"),
      '{"$schema":"https://example.test/config.json","permission":123}',
    )
    expect(String(yield* ConfigImport.run(dir).pipe(Effect.exit))).toContain("Correct this config")
  }),
)

it.live("imports runtime MCP layers by filename shape in the existing config directory", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const fs = yield* FSUtil.Service
    yield* fs.writeFileString(
      path.join(dir, "previous.local.json"),
      '{"mcp":{"docs":{"type":"remote","url":"https://example.test/mcp"}}}',
    )
    yield* fs.writeFileString(path.join(dir, "previous.local.jsonc"), '{"mcp":{"docs":{"enabled":false}}}')
    yield* fs.writeFileString(path.join(dir, ".gitignore"), "custom-entry\n")
    expect(yield* ConfigImport.run(dir, true)).toBeDefined()
    expect(yield* fs.readFileString(path.join(dir, ".gitignore"))).toBe(
      "custom-entry\nvector.local.json\nvector.local.jsonc\n",
    )
    expect(yield* fs.readJson(path.join(dir, "vector.local.jsonc"))).toMatchObject({
      mcp: { docs: { type: "remote", url: "https://example.test/mcp", enabled: false } },
    })
    expect(yield* ConfigImport.run(dir, true)).toBeUndefined()
  }),
)
