# Community OAuth plugins with an owned client

Part 2.22 is implemented for the legacy Engine and native Core plugin loaders. Built-in provider registrations remain disabled until their separate owner actions are complete. ChatGPT sign-in remains deliberately disabled in the built-in integration. This opt-in is for independently maintained plugins whose authors own and are authorized to use their OAuth registration.

## Plugin declaration

Use a dedicated installed package with an exact version and a `vectorOAuth` array in its own `package.json`:

```json
{
  "name": "@example/vector-owned-auth",
  "version": "1.0.0",
  "vectorOAuth": [
    {
      "provider": "github-copilot",
      "clientId": "your-owned-client-id",
      "issuer": "https://identity.example",
      "apiOrigins": ["https://inference.example"]
    }
  ]
}
```

The HTTPS origins must be exact origins, with no path, trailing slash, credentials, query or fragment. Declare at most one registration per provider. This declaration is an assertion by the plugin author, not evidence of provider authorization. Known borrowed-client package-name suffixes remain blocked, including a package whose manifest exposes a blocked name through a differently named entrypoint.

Inspect the installed entrypoint before loading it:

```sh
vector auth plugin approve /absolute/path/to/package/index.js --provider github-copilot
```

The first command prints the resolved package name, exact version, canonical package path, entrypoint, content digest, client ID, issuer and API origins. It exits without approval. After reviewing those details and the warning, repeat with `--accept-risk` to explicitly opt in. The inspection command reads files; it does not import or execute the plugin. Restart every Vector process that will use it after approving or updating the plugin.

```sh
vector auth plugin approve /absolute/path/to/package/index.js --provider github-copilot --accept-risk
vector auth plugin list
vector auth plugin revoke <approval-id>
```

Consent is stored in a private, atomic `plugin-oauth-approvals.json` under the user's Vector data directory. It is independent of project and global application configuration. A project cannot approve a plugin through its options or by adding a catalog display marker. Desktop and CLI must use the same user data directory and namespace to observe the same consent.

## Identity and credentials

Approval binds the canonical package root, resolved entrypoint, exact version, package content digest, provider, client, issuer and inference origins. The digest covers regular package files, including supporting files and the manifest; `.git` and `node_modules` are excluded. Keep the plugin in a dedicated package rather than at a changing project root. Runtime dependencies still execute with the plugin's trust; review and pin those dependencies separately. Symlinked package content, an oversized package, malformed declarations and non-private or symlinked consent files fail closed.

A different version, changed supporting file, moved installation, changed registration or entrypoint needs new consent. A cached module whose content changed requires a process restart; changing files while an import runs does not grant approval to the changed content. Existing loaded code remains trusted until revoked or the process stops.

Completed OAuth credentials and delegated API keys carry the exact approval ID, client and issuer. Supported authorization callbacks reject a different client, provider or issuer. Refresh and inference paths bind the exact loaded plugin's approval. Revocation stops subsequent supported authorization, refresh and inference requests; it does not cancel a request that has already left the process. Normal custom fetch wrappers retain the request-time origin and revocation checks, and guarded inference refuses redirects.

The built-in Copilot gate stays false. Approval never enables automatic use of `GITHUB_TOKEN` or unrelated environment credentials. A paused provider absent from the frozen catalog needs models declared by the community plugin or user configuration; consent alone does not create a model catalog.

## Trust boundary and remaining owner work

A plugin is arbitrary executable code with normal process capabilities. Consent is not a sandbox, a credential isolation boundary against malicious plugins, or an endorsement by Vector or the provider. The supported plugin OAuth and SDK option interfaces enforce the checks described above. A plugin that makes its own network calls or ignores host SDK options remains trusted code. Only approve a reviewed plugin and a client whose ownership and provider terms have been established.

No client was registered, real credential read, sign-in performed, account changed, or built-in sign-in gate enabled by this implementation. The first npm plugin package publication still requires the separate owner action in [npm-plugin.md](./npm-plugin.md).
