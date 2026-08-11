export type ToolField = { key: string; label: string; secret?: boolean }
export type ToolCatalogItem = {
  id: string
  name: string
  category: string
  description: string
  auth: "none" | "token" | "oauth"
  cloudSupport: "ready" | "oauth_required" | "secret_broker_required" | "runtime_required" | "desktop_only"
  cloudNote: string
  fields?: ToolField[]
}

const item = (
  id: string,
  name: string,
  category: string,
  description: string,
  auth: ToolCatalogItem["auth"] = "none",
  fields?: ToolField[],
) => {
  const desktopOnly = new Set(["computer-use", "desktop-commander", "chrome-devtools", "terraform"])
  const secretBroker = new Set(["kubernetes", "azure"])
  const runtimeRequired = new Set(["fetch", "playwright"])
  const browserRuntimeReady = id === "playwright" && Boolean(process.env.VECTOR_CLOUD_SANDBOX_IMAGE?.trim())
  const cloudSupport: ToolCatalogItem["cloudSupport"] = desktopOnly.has(id)
    ? "desktop_only"
    : auth === "oauth"
      ? "oauth_required"
      : auth === "token" || secretBroker.has(id)
        ? "secret_broker_required"
        : runtimeRequired.has(id) && !browserRuntimeReady
          ? "runtime_required"
          : "ready"
  const cloudNote =
    cloudSupport === "desktop_only"
      ? "Available in Vector desktop; this integration needs local software that is not present in cloud sandboxes."
      : cloudSupport === "oauth_required"
        ? "Cloud OAuth authorization is not available yet."
        : cloudSupport === "secret_broker_required"
          ? "Requires Vector's scoped secret broker before it can run safely in cloud workspaces."
          : cloudSupport === "runtime_required"
            ? "Requires a cloud runtime dependency that Vector has not enabled yet."
            : "Ready for isolated Vector Cloud workspaces."
  return { id, name, category, description, auth, cloudSupport, cloudNote, fields }
}

export function cloudReadyTool(item: ToolCatalogItem) {
  return item.cloudSupport === "ready"
}

export const TOOL_CATALOG: ToolCatalogItem[] = [
  item("github", "GitHub", "Source & deploy", "Repositories, branches, issues, pull requests, and reviews.", "token", [
    { key: "token", label: "Personal access token", secret: true },
  ]),
  item("vercel", "Vercel", "Source & deploy", "Deployments, projects, logs, and environment configuration.", "oauth"),
  item("netlify", "Netlify", "Source & deploy", "Sites, deploys, DNS, and edge functions.", "token", [
    { key: "NETLIFY_PERSONAL_ACCESS_TOKEN", label: "Personal access token", secret: true },
  ]),
  item("railway", "Railway", "Source & deploy", "Services, environments, and deployment status.", "token", [
    { key: "RAILWAY_API_TOKEN", label: "API token", secret: true },
  ]),
  item("render", "Render", "Source & deploy", "Services, deploys, logs, and Postgres instances.", "token", [
    { key: "token", label: "API key", secret: true },
  ]),
  item("aws", "AWS", "Source & deploy", "IAM-scoped infrastructure operations and CloudWatch.", "token", [
    { key: "AWS_REGION", label: "Default region" },
  ]),
  item("supabase", "Supabase", "Databases & payments", "Databases, auth, migrations, storage, and schemas.", "token", [
    { key: "SUPABASE_ACCESS_TOKEN", label: "Access token", secret: true },
  ]),
  item("neon", "Neon", "Databases & payments", "Serverless Postgres branches, roles, and queries.", "oauth"),
  item("postgres", "Postgres", "Databases & payments", "Read-only queries and schema inspection.", "token", [
    { key: "connection", label: "Connection string", secret: true },
  ]),
  item("stripe", "Stripe", "Databases & payments", "Products, prices, webhooks, and test-mode workflows.", "token", [
    { key: "token", label: "Secret or restricted key", secret: true },
  ]),
  item("linear", "Linear", "Project tracking", "Issues, projects, comments, and status updates.", "oauth"),
  item("jira", "Jira", "Project tracking", "Issues, sprints, and boards across Atlassian projects.", "oauth"),
  item("asana", "Asana", "Project tracking", "Tasks, projects, and status updates.", "oauth"),
  item("sentry", "Sentry", "Observability", "Errors, stack traces, releases, and performance health.", "oauth"),
  item("posthog", "PostHog", "Observability", "Analytics, feature flags, and session data.", "token", [
    { key: "token", label: "Personal API key", secret: true },
  ]),
  item("datadog", "Datadog", "Observability", "Monitors, dashboards, logs, and incidents.", "token", [
    { key: "DATADOG_API_KEY", label: "API key", secret: true },
    { key: "DATADOG_APP_KEY", label: "Application key", secret: true },
  ]),
  item("notion", "Notion", "Docs & comms", "Project documentation, specs, and databases.", "oauth"),
  item("google-drive", "Google Drive", "Docs & comms", "Files, documents, and shared drives.", "oauth"),
  item("slack", "Slack", "Docs & comms", "Approved status updates and engineering notifications.", "token", [
    { key: "SLACK_BOT_TOKEN", label: "Bot token", secret: true },
    { key: "SLACK_TEAM_ID", label: "Team ID" },
  ]),
  item("discord", "Discord", "Docs & comms", "Server messages and community notifications.", "token", [
    { key: "DISCORD_TOKEN", label: "Bot token", secret: true },
  ]),
  item("figma", "Figma", "Design & browser", "Inspect designs and turn them into implementation context.", "oauth"),
  item("chrome-devtools", "Chrome DevTools", "Design & browser", "Navigate, inspect, and debug a controlled browser."),
  item("computer-use", "Computer Use", "Design & browser", "Controlled desktop workflows beyond the browser."),
  item("playwright", "Playwright", "Design & browser", "Browser navigation, interaction, assertions, and screenshots."),
  item("browserbase", "Browserbase", "Design & browser", "Persistent cloud browser sessions and captures.", "token", [
    { key: "BROWSERBASE_API_KEY", label: "API key", secret: true },
    { key: "BROWSERBASE_PROJECT_ID", label: "Project ID" },
  ]),
  item("desktop-commander", "Desktop Commander", "Design & browser", "Terminal, process, and precise file operations."),
  item("context7", "Context7", "Search & knowledge", "Version-accurate library documentation for agents."),
  item("firecrawl", "Firecrawl", "Search & knowledge", "Crawl sites and extract structured web data.", "token", [
    { key: "FIRECRAWL_API_KEY", label: "API key", secret: true },
  ]),
  item("exa", "Exa", "Search & knowledge", "Neural search and research for agents."),
  item("brave-search", "Brave Search", "Search & knowledge", "Independent web, news, and image search.", "token", [
    { key: "BRAVE_API_KEY", label: "API key", secret: true },
  ]),
  item("fetch", "Fetch", "Search & knowledge", "Read a URL as clean, agent-ready content."),
  item("memory", "Memory", "Search & knowledge", "Knowledge-graph memory across sessions."),
  item("sequential-thinking", "Sequential Thinking", "Search & knowledge", "Structured reasoning for complex work."),
  item("higgsfield", "Higgsfield", "AI & media", "Generate image and video assets.", "oauth"),
  item("elevenlabs", "ElevenLabs", "AI & media", "Speech, voice, and audio tools.", "token", [
    { key: "ELEVENLABS_API_KEY", label: "API key", secret: true },
  ]),
  item("fal", "fal.ai", "AI & media", "Run hosted generative media models.", "oauth"),
  item("replicate", "Replicate", "AI & media", "Search and run open models.", "oauth"),
  item("cloudflare", "Cloudflare", "Infrastructure", "Workers, KV, R2, D1, and account tooling.", "oauth"),
  item("kubernetes", "Kubernetes", "Infrastructure", "Pods, deployments, services, and logs."),
  item("terraform", "Terraform", "Infrastructure", "Registry lookup and infrastructure-as-code workflows."),
  item("azure", "Azure", "Infrastructure", "Azure resources through the official MCP server."),
  item("gitlab", "GitLab", "Source & deploy", "Projects, merge requests, and pipelines.", "oauth"),
  item("heroku", "Heroku", "Source & deploy", "Apps, dynos, add-ons, and Postgres.", "token", [
    { key: "HEROKU_API_KEY", label: "Authorization token", secret: true },
  ]),
  item("digitalocean", "DigitalOcean", "Source & deploy", "Droplets, App Platform, and managed databases.", "token", [
    { key: "DIGITALOCEAN_API_TOKEN", label: "API token", secret: true },
  ]),
  item("mongodb", "MongoDB", "Databases & payments", "Query collections and manage Atlas.", "token", [
    { key: "MDB_MCP_CONNECTION_STRING", label: "Connection string", secret: true },
  ]),
  item("redis", "Redis", "Databases & payments", "Keys, streams, and vector search.", "token", [
    { key: "REDIS_HOST", label: "Host" },
    { key: "REDIS_PORT", label: "Port" },
    { key: "REDIS_PWD", label: "Password", secret: true },
  ]),
]

type McpConfig =
  | {
      type: "remote"
      url: string
      headers?: Record<string, string | undefined>
      oauth?: false
      enabled: true
      timeout: number
    }
  | {
      type: "local"
      command: Array<string | undefined>
      environment?: Record<string, string | undefined>
      enabled: true
      timeout: number
    }

const remote = (url: string, headers?: Record<string, string | undefined>): McpConfig => ({
  type: "remote",
  url,
  ...(headers ? { headers, oauth: false as const } : {}),
  enabled: true,
  timeout: 120_000,
})
const local = (command: Array<string | undefined>, environment?: Record<string, string | undefined>): McpConfig => ({
  type: "local",
  command,
  ...(environment ? { environment } : {}),
  enabled: true,
  timeout: 120_000,
})

export function buildPluginMcp(pluginId: string, values: Record<string, string>): McpConfig | undefined {
  switch (pluginId) {
    case "github":
      return remote("https://api.githubcopilot.com/mcp/", { Authorization: `Bearer ${values.token}` })
    case "vercel":
      return remote("https://mcp.vercel.com")
    case "netlify":
      return local(["npx", "-y", "@netlify/mcp"], {
        NETLIFY_PERSONAL_ACCESS_TOKEN: values.NETLIFY_PERSONAL_ACCESS_TOKEN,
      })
    case "railway":
      return local(["npx", "-y", "@railway/mcp-server"], { RAILWAY_API_TOKEN: values.RAILWAY_API_TOKEN })
    case "render":
      return remote("https://mcp.render.com/mcp", { Authorization: `Bearer ${values.token}` })
    case "aws":
      return local(["uvx", "awslabs.aws-api-mcp-server@latest"], { AWS_REGION: values.AWS_REGION || "us-east-1" })
    case "supabase":
      return local(["npx", "-y", "@supabase/mcp-server-supabase@latest"], {
        SUPABASE_ACCESS_TOKEN: values.SUPABASE_ACCESS_TOKEN,
      })
    case "neon":
      return remote("https://mcp.neon.tech/mcp")
    case "postgres":
      return local(["npx", "-y", "@modelcontextprotocol/server-postgres", values.connection])
    case "stripe":
      return remote("https://mcp.stripe.com", { Authorization: `Bearer ${values.token}` })
    case "linear":
      return remote("https://mcp.linear.app/sse")
    case "jira":
      return remote("https://mcp.atlassian.com/v1/sse")
    case "asana":
      return remote("https://mcp.asana.com/sse")
    case "sentry":
      return remote("https://mcp.sentry.dev/mcp")
    case "posthog":
      return remote("https://mcp.posthog.com/mcp", { Authorization: `Bearer ${values.token}` })
    case "datadog":
      return local(["npx", "-y", "@winor30/mcp-server-datadog"], {
        DATADOG_API_KEY: values.DATADOG_API_KEY,
        DATADOG_APP_KEY: values.DATADOG_APP_KEY,
      })
    case "notion":
      return remote("https://mcp.notion.com/mcp")
    case "slack":
      return local(["npx", "-y", "@modelcontextprotocol/server-slack"], {
        SLACK_BOT_TOKEN: values.SLACK_BOT_TOKEN,
        SLACK_TEAM_ID: values.SLACK_TEAM_ID,
      })
    case "discord":
      return local(["npx", "-y", "mcp-discord"], { DISCORD_TOKEN: values.DISCORD_TOKEN })
    case "figma":
      return remote("https://mcp.figma.com/mcp")
    case "chrome-devtools":
      return local(["npx", "-y", "chrome-devtools-mcp@latest"])
    case "computer-use":
      return local(["uvx", "computer-control-mcp@latest"])
    case "playwright":
      return local(["playwright-mcp"])
    case "browserbase":
      return local(["npx", "-y", "@browserbasehq/mcp"], {
        BROWSERBASE_API_KEY: values.BROWSERBASE_API_KEY,
        BROWSERBASE_PROJECT_ID: values.BROWSERBASE_PROJECT_ID,
      })
    case "desktop-commander":
      return local(["npx", "-y", "@wonderwhy-er/desktop-commander@latest"])
    case "context7":
      return local(["npx", "-y", "@upstash/context7-mcp"])
    case "firecrawl":
      return local(["npx", "-y", "firecrawl-mcp"], { FIRECRAWL_API_KEY: values.FIRECRAWL_API_KEY })
    case "exa":
      return remote("https://mcp.exa.ai/mcp")
    case "brave-search":
      return local(["npx", "-y", "@brave/brave-search-mcp-server", "--transport", "stdio"], {
        BRAVE_API_KEY: values.BRAVE_API_KEY,
      })
    case "fetch":
      return local(["uvx", "mcp-server-fetch"])
    case "memory":
      return local(["npx", "-y", "@modelcontextprotocol/server-memory"])
    case "sequential-thinking":
      return local(["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"])
    case "higgsfield":
      return remote("https://mcp.higgsfield.ai/mcp")
    case "elevenlabs":
      return local(["uvx", "elevenlabs-mcp"], { ELEVENLABS_API_KEY: values.ELEVENLABS_API_KEY })
    case "fal":
      return remote("https://mcp.fal.ai/mcp")
    case "replicate":
      return remote("https://mcp.replicate.com/sse")
    case "cloudflare":
      return remote("https://mcp.cloudflare.com/mcp")
    case "kubernetes":
      return local(["npx", "-y", "mcp-server-kubernetes"])
    case "terraform":
      return local(["docker", "run", "-i", "--rm", "hashicorp/terraform-mcp-server"])
    case "azure":
      return local(["npx", "-y", "@azure/mcp@latest", "server", "start"])
    case "gitlab":
      return remote("https://gitlab.com/api/v4/mcp")
    case "heroku":
      return local(["npx", "-y", "@heroku/mcp-server"], { HEROKU_API_KEY: values.HEROKU_API_KEY })
    case "digitalocean":
      return local(["npx", "-y", "@digitalocean/mcp"], { DIGITALOCEAN_API_TOKEN: values.DIGITALOCEAN_API_TOKEN })
    case "mongodb":
      return local(["npx", "-y", "mongodb-mcp-server@latest"], {
        MDB_MCP_CONNECTION_STRING: values.MDB_MCP_CONNECTION_STRING,
      })
    case "redis":
      return local(["uvx", "--from", "redis-mcp-server@latest", "redis-mcp-server"], {
        REDIS_HOST: values.REDIS_HOST,
        REDIS_PORT: values.REDIS_PORT,
        REDIS_PWD: values.REDIS_PWD,
      })
    default:
      return undefined
  }
}
