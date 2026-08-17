# dsh-subagent-dynamic-model

A DeepSeek Harness Cordis plugin for delegating subagent work to a configured model route that can differ from the parent agent's current model.

## What it adds

- `subagent_model`: one delegation tool whose `model` argument is restricted to configured aliases.
- Per-model `tags` and routing `description` text embedded in both the tool schema and the system prompt.
- `model_subagent_catalog`: a read-only tool that lists models advertised by the Harness's currently registered LLM providers.
- `model-subagent-setup`: a setup skill that guides model selection, generates safe routing descriptions, edits the profile patch, and validates the result.
- Foreground execution and durable continuable background subagents.

With an empty `models` list, only the catalog tool and setup skill are registered. This provides a bootstrap state: install first, then invoke `/model-subagent-setup`.

## Requirements

- DeepSeek Harness `0.1.0-rc.6` or compatible
- A preset that exposes the normal skill loader/tool
- The Host `spawn` subagent provider (included by standard DSH profiles)

## Install

```sh
# From npm once published
dsh plugin --profile web add dsh-subagent-dynamic-model

# Or from this checkout
dsh plugin --profile web add ./dsh-subagent-dynamic-model
```

If the earlier `cordis-plugin-development` package is already installed, remove it before adding the renamed package so both bundles do not register the same tools:

```sh
dsh plugin --profile web remove cordis-plugin-development
dsh plugin --profile web add ./dsh-subagent-dynamic-model
```

Restart the profile after first installation. Then invoke:

```text
/model-subagent-setup
```

The skill calls `model_subagent_catalog`, asks which routes to expose, proposes aliases/tags/descriptions, and adds an id-targeted entry to the selected profile's `cordis.patch.yml`.

## Manual configuration

Add this to `~/.dsh/profiles/web/cordis.patch.yml` (preserving other entries):

```yaml
- id: dsh-subagent-dynamic-model
  config:
    subagentProvider: spawn
    toolName: subagent_model
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

Validate without booting:

```sh
dsh --profile web --dump-config
```

Profile patches replace a row's entire `config`; restate every plugin field you want to preserve.

### Configuration reference

| Field | Default | Purpose |
| --- | --- | --- |
| `models` | `[]` | Routes exposed to the AI agent. An empty list leaves setup/catalog only. |
| `models[].alias` | required | Stable selector shown in the tool's `model` enum. |
| `models[].provider` | required | Exact registered LLM provider route. |
| `models[].model` | required | Exact model id interpreted by that provider. |
| `models[].displayName` | alias | Human-readable label in routing guidance. |
| `models[].tags` | `[]` | Lowercase kebab-case routing tags. |
| `models[].description` | required | One-sentence guidance describing when to use this route. |
| `models[].maxTokens` | provider default | Optional output cap for the initially created or still-resident child. DSH rc.6 does not restore this override after a continuable child is cold-resumed. |
| `subagentProvider` | `spawn` | Subagent execution backend, not the LLM provider. |
| `toolName` | `subagent_model` | Name of the model-facing delegation tool. |
| `maxDepth` | `3` | Maximum delegation depth enforced by the backend. |
| `enableRunInBackground` | `true` | Enable durable background children and default to them. |

The live catalog is advisory: some adapters accept model ids they do not advertise. Manually configured ids remain allowed, but should be user-confirmed.

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
│   └── model-catalog.js
├── skills/model-subagent-setup/SKILL.md
├── examples/cordis.patch.yml
├── test/plugin.test.js
├── cordis.patch.yml
└── package.json
```

## License

MIT
