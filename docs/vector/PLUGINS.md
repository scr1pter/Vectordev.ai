# Writing and upgrading Vector plugins

Use Vector's public plugin SDK for new plugins:

```ts
import { tool, type Plugin } from "@vectordevai/plugin"
import type { TuiPlugin } from "@vectordevai/plugin/tui"
```

The package also exports `/tool`, `/v2/effect`, `/v2/effect/integration`, `/v2/effect/plugin`, and `/v2/promise`. Match the SDK version to the Vector release you target. The first public package publication is pending the [owner's approval and package checks](owner-actions/npm-plugin.md); a staged package is not proof of registry availability.

Local plugins and custom tools may keep an existing scoped `@<scope>/plugin` or `@<scope>/plugin/tui` import when that exact module cannot resolve. Vector maps only that missing SDK entry point to its bundled SDK. A dependency that already resolves keeps its own implementation. npm-installed plugins are responsible for declaring their dependencies and receive no such fallback. Authors should still migrate explicit imports to `@vectordevai/plugin`, especially before distributing a plugin.

The compatibility loader prepares affected local modules in Vector's runtime cache. It preserves their original `import.meta` origin and local resource paths, retains Solid's TSX transformation, and leaves original plugin files and installed package manifests unchanged. It does not install packages or make a registry request to provide the fallback.

For theme packages, declare relative paths in `package.json`:

```json
{
  "vector-themes": ["themes/day.json", "themes/night.json"]
}
```

Manifest keys ending in `-themes` are also accepted. Vector combines their entries and removes duplicate paths. Every alias receives the same validation: entries must be nonempty relative paths that stay within the package. Prefer `vector-themes` for new packages.

Use `vector plugin <module>` to install a published plugin and add it to configuration. Use `vector --pure` when diagnosing a failure without external plugins.
