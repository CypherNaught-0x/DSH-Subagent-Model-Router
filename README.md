# dsh-subagent-dynamic-model

A DeepSeek Harness Cordis plugin for delegating subagent work to a configured model route that can differ from the parent agent's current model.

## What it adds

- `subagent_model`: a delegation tool whose `model` argument is restricted to user-configured aliases.
- Per-model tags and routing descriptions embedded in the tool schema and system prompt.
- `model_subagent_catalog`: a read-only view of models advertised by registered LLM providers.
- `configure_subagent_models`: a namespace-scoped model-facing tool for reading or updating this plugin's settings without filesystem access.
- `model-subagent-setup`: a guided skill for selecting routes, generating routing guidance, obtaining confirmation, and saving through the constrained configuration tool.
- **Settings → Subagent Models**: a Web settings page for manually adding, editing, and removing routes.
- A hot-reloaded `subagent-dynamic-model` namespace in `~/.dsh/settings.yaml`.
- Foreground execution and durable continuable background subagents.
- An active-model chip in an opened subagent header.
- Active-model chips in healthy rows of the parent session's subagent catalog.

With an empty `models` list, only the catalog tool, settings page, and setup skill are registered. This provides a bootstrap state for initial setup.

## Model identity chips

The opened subagent header and every healthy row in its parent's subagent catalog show the model id from the latest adapter-resolved request. Hover and accessible text expose the complete `provider/model` route. The plugin resets the route at the child's own descriptor so a fork cannot inherit its ancestor's model, and it omits the chip until the child records an authoritative request route.

## Requirements

- DeepSeek Harness `0.1.0-rc.6` or compatible
- The Web profile and built-in subagent conversation UI
- A preset exposing the normal skill loader/tool
- The Host `spawn` subagent provider, included by standard DSH profiles

## Install

```sh
# From npm once published
dsh plugin --profile web add dsh-subagent-dynamic-model

# Or from this checkout
dsh plugin --profile web add ./dsh-subagent-dynamic-model
```

If `cordis-plugin-development` is still installed, remove it first:

```sh
dsh plugin --profile web remove cordis-plugin-development
dsh plugin --profile web add ./dsh-subagent-dynamic-model
```

Restart `dsh web` after installation and refresh the page. Open **Settings → Subagent Models**, or invoke:

```text
/model-subagent-setup
```

## Configure through the Web UI

The **Subagent Models** settings page provides controls for:

- model alias, display name, LLM provider route, and exact model id;
- comma-separated routing tags and the “when to use” description;
- optional per-model output-token caps;
- subagent backend, delegation depth, and background execution.

On DSH rc.6, the built-in Web settings API exposes only a fixed namespace allowlist. This plugin therefore uses a package-owned, same-origin Host endpoint backed by the same Settings service, schema validation, persistence, and revision conflict protection. Successful changes apply live: the old delegation tool is removed and the updated schema and prompt guidance are registered immediately.

The endpoint rejects non-loopback connections and cross-origin mutations, so the page is unavailable from a non-local browser connection.

## Configure through the model-facing tool

`configure_subagent_models` is the preferred path for agent-assisted setup:

- `action: "get"` reads the current normalized settings.
- `action: "update"` replaces the complete model list and optionally changes the backend, depth, or background policy.
- The tool calls the Settings service directly and can modify only `subagent-dynamic-model`; it accepts no filesystem path and cannot read or write other namespaces.
- Updates pass the same schema and provider-capability validation as the Web UI, persist to `settings.yaml`, and apply live.

The update action is intentionally documented for direct user-requested changes only. The setup skill must show the complete proposed list and receive explicit confirmation before calling it.

## Configure through `settings.yaml`

Merge the following namespace into `~/.dsh/settings.yaml`:

```yaml
subagent-dynamic-model:
  subagentProvider: spawn
  maxDepth: 3
  enableRunInBackground: true
  models:
    - alias: fast
      provider: acme
      model: acme-fast
      displayName: Acme Fast
      tags: [fast, routine]
      description: Use for quick, well-scoped tasks where low latency matters.
    - alias: deep
      provider: acme
      model: acme-reasoner
      displayName: Acme Reasoner
      tags: [reasoning, review]
      description: Use for difficult analysis, architecture decisions, and adversarial review.
      maxTokens: 16384
```

See `examples/settings.yaml` for a copyable document fragment. The settings file is watched; valid edits apply without changing a Cordis patch.

### Settings reference

| Field | Default | Purpose |
| --- | --- | --- |
| `models` | `[]` | Routes exposed to AI agents. An empty list leaves setup/catalog only. |
| `models[].alias` | required | Stable selector shown in the tool's `model` enum. |
| `models[].provider` | required | Exact registered LLM provider route. |
| `models[].model` | required | Exact model id interpreted by that provider. |
| `models[].displayName` | alias | Human-readable label in routing guidance. |
| `models[].tags` | `[]` | Lowercase kebab-case routing tags. |
| `models[].description` | required | One sentence describing when to use this route. |
| `models[].maxTokens` | provider default | Optional cap for an initially created or resident child. DSH rc.6 does not restore it after a continuable child is cold-resumed. |
| `subagentProvider` | `spawn` | Subagent execution backend, not the LLM provider. |
| `maxDepth` | `3` | Maximum delegation depth enforced by the backend. |
| `enableRunInBackground` | `true` | Enable durable background children and default to them. |

The delegation tool is always named `subagent_model`. Legacy `toolName` values from versions before 0.4 are ignored and are removed the next time the namespace is saved.

The live catalog is advisory: some adapters accept model ids they do not advertise. Manually entered ids remain allowed but should be user-confirmed.

## Migrating from 0.1

Version 0.1 stored these values in an id-targeted profile `cordis.patch.yml` entry. For 0.2:

1. Copy that entry's `config` object under `subagent-dynamic-model:` in `~/.dsh/settings.yaml`.
2. Remove the old `- id: dsh-subagent-dynamic-model` override from the profile patch. The plugin's bundle already mounts the row.
3. Restart DSH once to load the new Host schema and Client settings page. Future settings changes apply live.

## Known limitations

DSH rc.6 has no additive slot inside a subagent catalog row, so the plugin owns the existing `subagent-catalog` header cell to render row chips. It claims that cell by registering at `priority: -1` — a list cell renders its lowest live priority, and the host's own entry sits at the default `0`. The `subagent-model` cell is registered the same way so a host build that also fills it stays shadowed rather than clashing. Catalog interaction changes in DSH must be mirrored here until the host exposes a row extension slot or renders `subagentModelRoute` itself.

## Development

```sh
pnpm install
pnpm test
```

Project layout:

```text
dsh-subagent-dynamic-model/
├── lib/
│   ├── index.js
│   ├── client.js
│   └── model-catalog.js
├── skills/model-subagent-setup/SKILL.md
├── examples/settings.yaml
├── test/
│   ├── client.test.js
│   ├── model-catalog.test.js
│   └── plugin.test.js
├── cordis.patch.yml
└── package.json
```

The Client bundle is plain `window.__ModuleLoader__.load(...)` JavaScript and requires no build step.

## License

MIT
