import path from "node:path"

// Match dependency behavior and API shapes, never another product's identifier.
export function rewriteGitLab(source: string) {
  if (!source.includes("Vector owns credential resolution"))
    throw new Error("The GitLab credential isolation patch is missing; reinstall dependencies before building")
  const rewritten = source
    .replace(/(\.join\(cacheHome, )"[^"]+"(, "gitlab-(?:workflow-model-cache|model-configs)\.json"\))/g, '$1"vector"$2')
    .replace(/\b[A-Z][A-Z0-9_]*_GITLAB_AUTH_CLIENT_ID\b/g, "VECTOR_GITLAB_AUTH_CLIENT_ID")
    .replace(/(var (?:VECTOR_GITLAB_AUTH_CLIENT_ID|BUNDLED_CLIENT_ID) = )"[^"]*";/g, '$1"";')
    .replace(/    if \(instanceUrl === GITLAB_COM_URL\) \{\n      return VECTOR_GITLAB_AUTH_CLIENT_ID;\n    \}\n/g, "")
    .replace(/function get[A-Za-z]+AuthPath\(\) \{[\s\S]*?(?=function withUserAgentSuffix\()/g, "")
    .replace(/'[^'\n ]+ auth login gitlab'/g, "'vector auth login gitlab'")
  if (
    !rewritten.includes('join(cacheHome, "vector", "gitlab-workflow-model-cache.json")') ||
    !rewritten.includes('join(cacheHome, "vector", "gitlab-model-configs.json")') ||
    !rewritten.includes('var VECTOR_GITLAB_AUTH_CLIENT_ID = "";') ||
    !rewritten.includes('var BUNDLED_CLIENT_ID = "";') ||
    /return VECTOR_GITLAB_AUTH_CLIENT_ID|function get[A-Za-z]+AuthPath/.test(rewritten)
  )
    throw new Error("GitLab dependency layout changed; review the Vector compatibility rewrite")
  return rewritten
}

export async function prepareGitLab() {
  // Isolated installs expose this dependency only to the workspaces that declare it.
  const manifests = new Set(
    ["../packages/core", "../packages/engine"].map((directory) =>
      Bun.resolveSync("gitlab-ai-provider/package.json", path.resolve(import.meta.dir, directory)),
    ),
  )
  for (const manifest of manifests) {
    if ((await Bun.file(manifest).json()).version !== "6.10.0")
      throw new Error("Review the GitLab compatibility rewrite before changing dependency versions")
    for (const format of ["js", "mjs"]) {
      const file = Bun.file(path.join(path.dirname(manifest), "dist", `index.${format}`))
      const source = await file.text()
      const rewritten = rewriteGitLab(source)
      if (rewritten !== source) await file.write(rewritten)
    }
  }
}

if (import.meta.main) await prepareGitLab()
