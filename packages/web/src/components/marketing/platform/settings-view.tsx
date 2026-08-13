/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react"
import type { Session } from "@supabase/supabase-js"
import {
  Bot,
  Check,
  CreditCard,
  ExternalLink,
  Globe2,
  KeyRound,
  Laptop,
  Link2,
  LockKeyhole,
  Plug,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react"
import { apiFetch, formatDate, platformAuth, type PlatformConfig } from "./platform-client"
import { PlatformButton } from "./platform-button"

type AccountStatus = {
  user: { email: string; name?: string; avatarUrl?: string }
  entitlement: {
    access: boolean
    state: string
    plan?: "monthly" | "annual" | "founder"
    expiresAt?: string
    message?: string
  }
  canManageBilling: boolean
}

type ProviderDefinition = { id: string; name: string; models: string[] }
type ProviderConnection = {
  id: string
  provider_id: string
  name: string
  models: string[]
  enabled: boolean
}
type ToolDefinition = {
  id: string
  name: string
  description: string
  category: string
  cloudSupport: string
  cloudNote: string
  fields?: Array<{ key: string; label: string; secret?: boolean }>
}
type ToolConnection = {
  id: string
  plugin_id: string | null
  name: string
  kind: "plugin" | "mcp_remote" | "mcp_local"
  enabled: boolean
}
type Device = {
  id: string
  name: string
  platform: string
  permissions: string[]
  status: string
  last_seen_at?: string
}

function planName(status?: AccountStatus) {
  if (status?.entitlement.plan === "founder") return "Founder access"
  if (status?.entitlement.plan === "monthly") return "Vector monthly"
  if (status?.entitlement.plan === "annual") return "Vector annual"
  return "No active plan"
}

export function SettingsView(props: { session: Session; config?: PlatformConfig }) {
  const [status, setStatus] = useState<AccountStatus>()
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [providerCatalog, setProviderCatalog] = useState<ProviderDefinition[]>([])
  const [providerConnections, setProviderConnections] = useState<ProviderConnection[]>([])
  const [providerId, setProviderId] = useState("")
  const [providerKey, setProviderKey] = useState("")
  const [providerModels, setProviderModels] = useState<string[]>([])
  const [toolCatalog, setToolCatalog] = useState<ToolDefinition[]>([])
  const [toolConnections, setToolConnections] = useState<ToolConnection[]>([])
  const [toolId, setToolId] = useState("")
  const [toolValues, setToolValues] = useState<Record<string, string>>({})
  const [mcpName, setMcpName] = useState("")
  const [mcpUrl, setMcpUrl] = useState("")
  const [devices, setDevices] = useState<Device[]>([])
  const [busy, setBusy] = useState("")
  const [message, setMessage] = useState("")

  const selectedProvider = providerCatalog.find((item) => item.id === providerId)
  const selectedTool = toolCatalog.find((item) => item.id === toolId)
  const initials = useMemo(() => {
    const source = status?.user.name || status?.user.email || props.session.user.email || "V"
    return source
      .split(/\s|@/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("")
  }, [props.session.user.email, status])

  const load = async () => {
    try {
      const account = (await apiFetch("/api/account/status", props.session)) as AccountStatus
      setStatus(account)
      setName(account.user.name || "")
      if (!account.entitlement.access) return
      const [providerPayload, toolPayload, catalogPayload, devicePayload] = await Promise.all([
        apiFetch<{ catalog: ProviderDefinition[]; connections: ProviderConnection[] }>(
          "/api/platform/providers",
          props.session,
        ),
        apiFetch<{ connections: ToolConnection[] }>("/api/platform/connections", props.session),
        apiFetch<{ tools: ToolDefinition[] }>("/api/platform/catalog", props.session),
        apiFetch<{ devices: Device[] }>("/api/platform/devices", props.session),
      ])
      setProviderCatalog(providerPayload.catalog || [])
      setProviderConnections(providerPayload.connections || [])
      setToolCatalog((catalogPayload.tools || []).filter((item) => item.cloudSupport === "ready"))
      setToolConnections(toolPayload.connections || [])
      setDevices(devicePayload.devices || [])
      if (!providerId && providerPayload.catalog[0]) setProviderId(providerPayload.catalog[0].id)
      if (!toolId && catalogPayload.tools[0]) {
        const firstReady = catalogPayload.tools.find((item) => item.cloudSupport === "ready")
        if (firstReady) setToolId(firstReady.id)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not load settings.")
    }
  }

  useEffect(() => {
    void load()
  }, [props.session.access_token])

  useEffect(() => {
    setProviderModels(selectedProvider?.models.slice(0, 1) || [])
  }, [providerId])

  useEffect(() => setToolValues({}), [toolId])

  const saveProfile = async () => {
    if (!name.trim()) return setMessage("Enter the name you want Vector to use.")
    setBusy("profile")
    try {
      const auth = await platformAuth()
      const { error } = await auth.auth.updateUser({ data: { full_name: name.trim(), name: name.trim() } })
      if (error) throw error
      await load()
      setMessage("Profile updated.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not update your profile.")
    } finally {
      setBusy("")
    }
  }

  const saveProvider = async () => {
    if (!selectedProvider || !providerKey.trim() || !providerModels.length) {
      return setMessage("Choose a provider, model, and API key.")
    }
    setBusy("provider")
    setMessage("")
    try {
      await apiFetch("/api/platform/providers", props.session, {
        method: "POST",
        body: JSON.stringify({
          providerId: selectedProvider.id,
          name: selectedProvider.name,
          apiKey: providerKey.trim(),
          models: providerModels,
        }),
      })
      setProviderKey("")
      await load()
      setMessage(selectedProvider.name + " connected.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not connect this provider.")
    } finally {
      setBusy("")
    }
  }

  const removeProvider = async (id: string) => {
    setBusy("provider-" + id)
    try {
      await apiFetch("/api/platform/providers", props.session, {
        method: "DELETE",
        body: JSON.stringify({ id }),
      })
      await load()
      setMessage("Model provider removed.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not remove this provider.")
    } finally {
      setBusy("")
    }
  }

  const saveTool = async () => {
    if (!selectedTool) return
    setBusy("tool")
    try {
      await apiFetch("/api/platform/connections", props.session, {
        method: "POST",
        body: JSON.stringify({
          kind: "plugin",
          pluginId: selectedTool.id,
          name: selectedTool.name,
          values: toolValues,
        }),
      })
      await load()
      setMessage(selectedTool.name + " connected.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not connect this tool.")
    } finally {
      setBusy("")
    }
  }

  const saveMcp = async () => {
    if (!mcpName.trim() || !mcpUrl.trim()) return setMessage("Enter an MCP name and HTTPS URL.")
    setBusy("mcp")
    try {
      await apiFetch("/api/platform/connections", props.session, {
        method: "POST",
        body: JSON.stringify({ kind: "mcp_remote", name: mcpName.trim(), url: mcpUrl.trim() }),
      })
      setMcpName("")
      setMcpUrl("")
      await load()
      setMessage("Remote MCP connected.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not connect this MCP server.")
    } finally {
      setBusy("")
    }
  }

  const removeTool = async (id: string) => {
    setBusy("tool-" + id)
    try {
      await apiFetch("/api/platform/connections", props.session, {
        method: "DELETE",
        body: JSON.stringify({ id }),
      })
      await load()
      setMessage("Connection removed.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not remove this connection.")
    } finally {
      setBusy("")
    }
  }

  const pairComputer = async () => {
    setBusy("pair")
    try {
      const payload = await apiFetch<{ url: string }>("/api/platform/devices", props.session, {
        method: "POST",
        body: JSON.stringify({ action: "pair" }),
      })
      location.assign(payload.url)
      setMessage("Vector desktop opened. Return here after pairing finishes.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not pair this computer.")
    } finally {
      setBusy("")
    }
  }

  const setDevicePermission = async (device: Device, permission: "browser" | "shell", enabled: boolean) => {
    const permissions = enabled
      ? [...new Set([...device.permissions, permission])]
      : device.permissions.filter((item) => item !== permission)
    setBusy("device-" + device.id)
    try {
      await apiFetch("/api/platform/devices", props.session, {
        method: "POST",
        body: JSON.stringify({ action: "permissions", id: device.id, permissions }),
      })
      await load()
      setMessage("Computer permissions updated.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not update this computer.")
    } finally {
      setBusy("")
    }
  }

  const updatePassword = async () => {
    if (password.length < 8) return setMessage("Use at least eight characters for your new password.")
    setBusy("password")
    try {
      const auth = await platformAuth()
      const { error } = await auth.auth.updateUser({ password })
      if (error) throw error
      setPassword("")
      setMessage("Password updated.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not update your password.")
    } finally {
      setBusy("")
    }
  }

  const openBilling = async () => {
    setBusy("billing")
    try {
      const payload = await apiFetch<{ url: string }>("/api/account/portal", props.session, { method: "POST" })
      location.assign(payload.url)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not open billing.")
      setBusy("")
    }
  }

  return (
    <div className="platform-page settings-page mx-auto w-full max-w-[1180px]">
      <header className="platform-page-header settings-header">
        <div className="platform-page-title">
          <span><ShieldCheck size={17} /></span>
          <div>
            <h1>Settings</h1>
            <p>Account, models, MCP connections, and approval-gated computer access.</p>
          </div>
        </div>
        <span className="platform-status" data-state={status?.entitlement.access ? "active" : "expired"}>
          {status?.entitlement.access ? "access active" : "plan required"}
        </span>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <a href="#profile"><UserRound size={15} /> Profile</a>
          <a href="#models"><Bot size={15} /> Models</a>
          <a href="#connections"><Plug size={15} /> MCP & tools</a>
          <a href="#computer"><Laptop size={15} /> Computer access</a>
          <a href="#billing"><CreditCard size={15} /> Billing</a>
          <a href="#security"><LockKeyhole size={15} /> Security</a>
        </nav>

        <div className="settings-content">
          <section id="profile" className="settings-card">
            <div className="settings-card-heading">
              <span><UserRound size={17} /></span>
              <div><h2>Profile</h2><p>Your identity across Vector.</p></div>
            </div>
            <div className="settings-profile-row">
              <span className="settings-avatar">
                {status?.user.avatarUrl ? <img src={status.user.avatarUrl} alt="" /> : initials}
              </span>
              <div><strong>{status?.user.name || "Vector member"}</strong><small>{status?.user.email}</small></div>
            </div>
            <div className="settings-fields">
              <label><span>Display name</span><input className="platform-input" value={name} onChange={(event) => setName(event.target.value)} /></label>
              <label><span>Email</span><input className="platform-input" value={status?.user.email || ""} disabled /></label>
            </div>
            <div className="settings-actions">
              <PlatformButton variant="primary" onClick={() => void saveProfile()} disabled={!!busy}>
                <Check size={15} /> Save profile
              </PlatformButton>
            </div>
          </section>

          <section id="models" className="settings-card">
            <div className="settings-card-heading">
              <span><Bot size={17} /></span>
              <div><h2>Model providers</h2><p>Bring your own key. Vector encrypts it and brokers it into isolated builds.</p></div>
            </div>
            <div className="settings-connection-list">
              {providerConnections.map((connection) => (
                <div key={connection.id}>
                  <span><KeyRound size={15} /></span>
                  <div><strong>{connection.name}</strong><small>{connection.models.join(", ")}</small></div>
                  <button type="button" title="Remove provider" onClick={() => void removeProvider(connection.id)} disabled={!!busy}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="settings-provider-form">
              <label>
                <span>Provider</span>
                <select className="platform-input" value={providerId} onChange={(event) => setProviderId(event.target.value)}>
                  {providerCatalog.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                </select>
              </label>
              <label>
                <span>Model</span>
                <select
                  className="platform-input"
                  value={providerModels[0] || ""}
                  onChange={(event) => setProviderModels([event.target.value])}
                >
                  {(selectedProvider?.models || []).map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label>
                <span>API key</span>
                <input
                  className="platform-input"
                  type="password"
                  autoComplete="off"
                  value={providerKey}
                  onChange={(event) => setProviderKey(event.target.value)}
                  placeholder="Stored encrypted"
                />
              </label>
              <PlatformButton variant="primary" onClick={() => void saveProvider()} disabled={!!busy}>
                <Link2 size={15} /> Connect provider
              </PlatformButton>
            </div>
          </section>

          <section id="connections" className="settings-card">
            <div className="settings-card-heading">
              <span><Plug size={17} /></span>
              <div><h2>MCP & tools</h2><p>The same saved connections are available to every Vector Builder project.</p></div>
            </div>
            <div className="settings-connection-list">
              {toolConnections.map((connection) => (
                <div key={connection.id}>
                  <span><Plug size={15} /></span>
                  <div><strong>{connection.name}</strong><small>{connection.kind.replace("_", " ")}</small></div>
                  <button type="button" title="Remove connection" onClick={() => void removeTool(connection.id)} disabled={!!busy}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="settings-tool-form">
              <label>
                <span>Vector tool</span>
                <select className="platform-input" value={toolId} onChange={(event) => setToolId(event.target.value)}>
                  {toolCatalog.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}
                </select>
              </label>
              {selectedTool?.fields?.map((field) => (
                <label key={field.key}>
                  <span>{field.label}</span>
                  <input
                    className="platform-input"
                    type={field.secret ? "password" : "text"}
                    value={toolValues[field.key] || ""}
                    onChange={(event) => setToolValues((current) => ({ ...current, [field.key]: event.target.value }))}
                  />
                </label>
              ))}
              <PlatformButton variant="secondary" onClick={() => void saveTool()} disabled={!!busy || !selectedTool}>
                <Plug size={15} /> Connect tool
              </PlatformButton>
            </div>
            <div className="settings-mcp-form">
              <label><span>Remote MCP name</span><input className="platform-input" value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="Company tools" /></label>
              <label><span>HTTPS server URL</span><input className="platform-input" value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} placeholder="https://mcp.example.com" /></label>
              <PlatformButton variant="secondary" onClick={() => void saveMcp()} disabled={!!busy}>
                <Globe2 size={15} /> Add MCP
              </PlatformButton>
            </div>
          </section>

          <section id="computer" className="settings-card">
            <div className="settings-card-heading">
              <span><Laptop size={17} /></span>
              <div>
                <h2>Computer access</h2>
                <p>Pair Vector desktop, then grant Browser and Shell separately. Every action still requires approval.</p>
              </div>
            </div>
            <div className="settings-device-list">
              {devices.map((device) => (
                <div key={device.id}>
                  <span><Laptop size={16} /></span>
                  <div>
                    <strong>{device.name}</strong>
                    <small>{device.platform} · {device.last_seen_at ? "seen " + formatDate(device.last_seen_at) : device.status}</small>
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={device.permissions.includes("browser")}
                      onChange={(event) => void setDevicePermission(device, "browser", event.target.checked)}
                    />
                    Browser
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={device.permissions.includes("shell")}
                      onChange={(event) => void setDevicePermission(device, "shell", event.target.checked)}
                    />
                    Shell
                  </label>
                </div>
              ))}
              {!devices.length && <p>No computers paired yet.</p>}
            </div>
            <div className="settings-actions">
              <PlatformButton variant="primary" onClick={() => void pairComputer()} disabled={!!busy}>
                <Laptop size={15} /> {busy === "pair" ? "Opening desktop..." : "Pair this computer"}
              </PlatformButton>
            </div>
          </section>

          <section id="billing" className="settings-card">
            <div className="settings-card-heading">
              <span><CreditCard size={17} /></span>
              <div><h2>Billing</h2><p>Builder and desktop access share the same membership.</p></div>
            </div>
            <div className="settings-plan">
              <div>
                <span>Current access</span>
                <strong>{planName(status)}</strong>
                <small>{status?.entitlement.message || (status?.entitlement.expiresAt ? "Renews " + formatDate(status.entitlement.expiresAt) : "Choose a plan in Billing.")}</small>
              </div>
              <span className="platform-status" data-state={status?.entitlement.state || "expired"}>{status?.entitlement.state || "loading"}</span>
            </div>
            <div className="settings-actions">
              {status?.canManageBilling ? (
                <PlatformButton variant="primary" onClick={() => void openBilling()} disabled={!!busy}>
                  <CreditCard size={15} /> Manage billing
                </PlatformButton>
              ) : (
                <a className="platform-primary" href="/billing"><CreditCard size={15} /> View plans</a>
              )}
            </div>
          </section>

          <section id="security" className="settings-card">
            <div className="settings-card-heading">
              <span><LockKeyhole size={17} /></span>
              <div><h2>Security & legal</h2><p>Manage your password and review Vector's policies.</p></div>
            </div>
            <div className="settings-inline-form">
              <input className="platform-input" type="password" minLength={8} autoComplete="new-password" placeholder="New password" value={password} onChange={(event) => setPassword(event.target.value)} />
              <PlatformButton variant="secondary" onClick={() => void updatePassword()} disabled={!!busy}>
                Update password
              </PlatformButton>
            </div>
            <div className="settings-link-grid">
              <a href="/legal/privacy">Privacy policy <ExternalLink size={14} /></a>
              <a href="/legal/terms">Subscription terms <ExternalLink size={14} /></a>
              <a href="/legal/license">Software license <ExternalLink size={14} /></a>
              <a href="/legal/third-party">Third-party notices <ExternalLink size={14} /></a>
            </div>
          </section>
          {message && <p className="account-message settings-message">{message}</p>}
        </div>
      </div>
    </div>
  )
}
