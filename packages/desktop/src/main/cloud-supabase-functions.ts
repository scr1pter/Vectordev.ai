import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"

import { listEnv } from "./cloud-console"
import { scanSecretContent } from "./secret-scanner"
import {
  booleanField,
  management,
  numberField,
  refPath,
  responseArray,
  stringField,
  type SupabaseContext,
} from "./cloud-supabase-api"

// Edge Functions of the linked project: deploying a folder from
// supabase/functions/<name> with the Management API's deploy endpoint, which
// bundles on Supabase's side so no Supabase CLI or Docker is needed here, and
// the project's function secrets, which are shown by name only.

const FUNCTIONS_DIR = join("supabase", "functions")
const FUNCTION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENTRYPOINTS = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs"]
const IMPORT_MAPS = ["deno.json", "deno.jsonc", "import_map.json"]
const PRIVATE_FILE =
  /^(?:\.env(?:\.|$)|\.(?:npmrc|pypirc|netrc)$|credentials(?:\.json)?$|service[-_]account.*\.json$|id_(?:rsa|ed25519|ecdsa)(?:\.|$))|\.(?:pem|key|p12|pfx)$/i
const SKIP = new Set(["node_modules", ".git", ".DS_Store", "dist", ".turbo"])
const MAX_FILES = 500
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024

export type DeployedFunction = {
  id: string
  slug: string
  name: string
  status?: string
  version?: number
  verifyJwt?: boolean
  updatedAt?: string
}

function summarize(item: unknown): DeployedFunction | undefined {
  const slug = stringField(item, "slug")
  if (!slug) return
  const updated = stringField(item, "updated_at") ?? numberField(item, "updated_at")
  return {
    id: stringField(item, "id") ?? slug,
    slug,
    name: stringField(item, "name") ?? slug,
    status: stringField(item, "status"),
    version: numberField(item, "version"),
    verifyJwt: booleanField(item, "verify_jwt"),
    updatedAt: typeof updated === "number" ? new Date(updated).toISOString() : updated,
  }
}

// Folders that look deployable: a name Supabase accepts and an entrypoint.
// _shared and other underscore folders are code the functions import.
export async function localFunctions(directory: string) {
  const entries = await readdir(join(directory, FUNCTIONS_DIR), { withFileTypes: true }).catch(() => [])
  const names = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && FUNCTION_NAME.test(entry.name))
      .map(async (entry) => ((await entrypoint(join(directory, FUNCTIONS_DIR, entry.name))) ? entry.name : undefined)),
  )
  return names.filter((name): name is string => Boolean(name)).toSorted()
}

async function entrypoint(folder: string) {
  for (const name of ENTRYPOINTS) {
    if ((await stat(join(folder, name)).catch(() => undefined))?.isFile()) return name
  }
}

// https://supabase.com/docs/reference/api/v1-list-all-functions
export async function listFunctions(context: SupabaseContext, directory: string) {
  const deployed = responseArray(await management(context, refPath(context, "/functions")))
    .map(summarize)
    .filter((item): item is DeployedFunction => Boolean(item))
  return { deployed, local: await localFunctions(directory) }
}

// https://supabase.com/docs/reference/api/v1-deploy-a-function — a multipart
// body with `metadata` (JSON: entrypoint_path, import_map_path, verify_jwt,
// name) and one `file` part per source file. Paths are relative to the project
// root, as the Supabase CLI sends them, so `../_shared` imports resolve.
// https://supabase.com/changelog/33720-deploy-and-update-edge-functions-using-the-management-api
export async function deployFunction(context: SupabaseContext, input: { directory: string; name: string }) {
  const name = input.name.trim()
  if (!FUNCTION_NAME.test(name)) {
    throw new Error(`"${input.name}" is not a function name. Use letters, numbers, hyphens and underscores.`)
  }
  const folder = join(input.directory, FUNCTIONS_DIR, name)
  const root = await realpath(input.directory)
  await requireFunctionDirectory(folder, root)
  const entry = await entrypoint(folder)
  if (!entry) {
    throw new Error(`${join(FUNCTIONS_DIR, name)} has no ${ENTRYPOINTS.join(", ")} to deploy.`)
  }
  const shared = join(input.directory, FUNCTIONS_DIR, "_shared")
  const files = [
    ...(await collect(folder, root)),
    ...((await lstat(shared).catch(() => undefined)) ? await collect(shared, root) : []),
  ]
  if (files.length > MAX_FILES) throw new Error(`${name} has more than ${MAX_FILES} files to upload.`)
  const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size))
  if (sizes.some((size) => size > MAX_FILE_BYTES)) throw new Error(`${name} has a file larger than 5 MB.`)
  if (sizes.reduce((total, size) => total + size, 0) > MAX_TOTAL_BYTES) throw new Error(`${name} is larger than 20 MB.`)

  const path = (file: string) => relative(input.directory, file).split(sep).join("/")
  const importMap = IMPORT_MAPS.map((file) => join(folder, file)).find((file) => files.includes(file))
  const metadata = {
    name,
    entrypoint_path: path(join(folder, entry)),
    import_map_path: importMap ? path(importMap) : undefined,
    verify_jwt: await verifyJwt(input.directory, name),
  }
  const form = new FormData()
  form.set("metadata", JSON.stringify(metadata))
  const secrets = [
    ...context.secrets,
    ...listEnv(context.projectPath, context.taskId)
      .filter((item) => item.visibility === "server")
      .map((item) => item.value),
  ].filter((value) => value.length >= 4)
  for (const file of files) {
    const canonical = await realpath(file)
    const relativePath = relative(root, canonical)
    if (
      relativePath.startsWith(`..${sep}`) ||
      relativePath === ".." ||
      isAbsolute(relativePath) ||
      (await lstat(file)).isSymbolicLink()
    ) {
      throw new Error(`Function source ${path(file)} must stay inside the project and cannot be a symbolic link.`)
    }
    const content = await readFile(file)
    const text = content.toString("utf8")
    if (scanSecretContent(text, path(file)).length || secrets.some((secret) => text.includes(secret))) {
      throw new Error(
        `Function source ${path(file)} contains a credential. Move it to Function secrets before deploying.`,
      )
    }
    form.append("file", new Blob([content]), path(file))
  }
  const deployed = summarize(
    await management(context, refPath(context, `/functions/deploy?slug=${encodeURIComponent(name)}`), {
      method: "POST",
      body: form,
      // Supabase bundles on its side; a large function can take a while.
      signal: AbortSignal.timeout(120_000),
    }),
  )
  return {
    function: deployed ?? { id: name, slug: name, name },
    files: files.length,
    verifyJwt: metadata.verify_jwt,
    url: `https://${context.projectRef}.supabase.co/functions/v1/${name}`,
    detail: `${name} deployed to ${context.projectName}${deployed?.version ? ` as version ${deployed.version}` : ""}.`,
  }
}

async function requireFunctionDirectory(folder: string, root: string) {
  const info = await lstat(folder)
  const local = relative(root, await realpath(folder))
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    local.startsWith(`..${sep}`) ||
    local === ".." ||
    isAbsolute(local)
  ) {
    throw new Error("Function source directories must stay inside the project and cannot be symbolic links.")
  }
}

async function collect(folder: string, root: string): Promise<string[]> {
  await requireFunctionDirectory(folder, root)
  const entries = await readdir(folder, { withFileTypes: true })
  const nested = await Promise.all(
    entries
      .filter((entry) => !SKIP.has(entry.name) && !PRIVATE_FILE.test(entry.name))
      .map((entry) =>
        entry.isDirectory()
          ? collect(join(folder, entry.name), root)
          : entry.isFile()
            ? [join(folder, entry.name)]
            : [],
      ),
  )
  return nested.flat()
}

// supabase/config.toml can turn JWT verification off per function, which lets
// anyone on the internet call it:
// https://supabase.com/docs/guides/functions/function-configuration
export async function verifyJwt(directory: string, name: string) {
  const config = await readFile(join(directory, "supabase", "config.toml"), "utf8").catch(() => "")
  const section = config.split(/^\s*\[/m).find((part) => part.startsWith(`functions.${name}]`))
  const value = section?.match(/^\s*verify_jwt\s*=\s*(true|false)\s*$/m)?.[1]
  return value !== "false"
}

// https://supabase.com/docs/reference/api/v1-delete-a-function
export async function deleteFunction(context: SupabaseContext, input: { slug: string }) {
  const slug = input.slug.trim()
  if (!FUNCTION_NAME.test(slug)) throw new Error(`"${input.slug}" is not a function name.`)
  await management(context, refPath(context, `/functions/${encodeURIComponent(slug)}`), { method: "DELETE" })
  return { deleted: slug, detail: `${slug} was deleted from ${context.projectName}.` }
}

// Names only: Supabase's list includes each value (or its digest), and none of
// it may reach the console or the model.
// https://supabase.com/docs/reference/api/v1-list-all-secrets
export async function listFunctionSecrets(context: SupabaseContext) {
  const secrets = responseArray(await management(context, refPath(context, "/secrets")))
    .map((item) => {
      const name = stringField(item, "name")
      if (!name) return
      // Supabase provides these itself and refuses changes to them.
      return { name, updatedAt: stringField(item, "updated_at"), reserved: name.startsWith("SUPABASE_") }
    })
    .filter((item): item is { name: string; updatedAt: string | undefined; reserved: boolean } => Boolean(item))
  return { secrets }
}

function secretName(value: string) {
  const name = value.trim()
  if (!SECRET_NAME.test(name)) throw new Error(`"${value}" is not a secret name. Use letters, digits and underscores.`)
  if (name.startsWith("SUPABASE_")) throw new Error(`${name} is managed by Supabase and cannot be set.`)
  return name
}

// The console passes values the user typed. The agent passes only names, and
// each value comes from this project's stored environment, so it never goes
// through the model. https://supabase.com/docs/reference/api/v1-bulk-create-secrets
export async function setFunctionSecrets(
  context: SupabaseContext,
  input: { secrets?: { name: string; value: string }[]; fromEnv?: string[] },
) {
  const env = listEnv(context.projectPath, context.taskId)
  const fromEnv = (input.fromEnv ?? []).map((name) => {
    const found = env.find((item) => item.key === name.trim())
    if (!found) {
      throw new Error(
        `${name} is not one of this project's environment variables. Add it in Vector Cloud > Environment variables first.`,
      )
    }
    return { name: secretName(found.key), value: found.value }
  })
  const typed = (input.secrets ?? []).map((item) => {
    if (!item.value) throw new Error(`Enter a value for ${item.name}.`)
    return { name: secretName(item.name), value: item.value }
  })
  const secrets = [...typed, ...fromEnv]
  if (!secrets.length) throw new Error("Choose at least one secret to set.")
  context.secrets.push(...secrets.map((item) => item.value))
  await management(context, refPath(context, "/secrets"), { method: "POST", json: secrets })
  return {
    set: secrets.map((item) => item.name),
    detail: `Set ${secrets.length} function secret${secrets.length === 1 ? "" : "s"} on ${context.projectName}. Functions read new values on their next start.`,
  }
}

// https://supabase.com/docs/reference/api/v1-bulk-delete-secrets
export async function deleteFunctionSecrets(context: SupabaseContext, input: { names: string[] }) {
  const names = input.names.map(secretName)
  if (!names.length) throw new Error("Choose at least one secret to delete.")
  await management(context, refPath(context, "/secrets"), { method: "DELETE", json: names })
  return { deleted: names, detail: `Deleted ${names.join(", ")} from ${context.projectName}.` }
}
