# Set up model-selectable subagents

Use this skill to choose which existing Harness model routes are exposed through `subagent_model`, then generate concise routing guidance for each route. Configuration is stored under `subagent-dynamic-model` in `settings.yaml`; do not put model configuration in a Cordis patch.

## Workflow

1. Call `model_subagent_catalog` before proposing configuration. It reports the current agent route and models advertised by each registered provider.
2. Treat the catalog as advisory. A provider may accept an unlisted model id, but never invent an unlisted route without the user naming or confirming it.
3. Show a compact shortlist with exact `provider/model` identities and distinguish alternatives from the current agent route.
4. Ask one concise multi-select question for the routes the user wants exposed. If the user already named them, do not ask again.
5. For each route propose:
   - a short lowercase alias used by the tool's `model` argument;
   - 2-5 lowercase kebab-case tags;
   - a one-sentence `description` beginning with “Use for …” or “Use when …”.
6. Ground descriptions in provider metadata and the user's intended workflow. Do not invent claims about price, speed, context size, privacy, benchmark rank, or modalities.
7. Call `configure_subagent_models` with `action: "get"` to preserve the current backend, tool name, depth, and background defaults unless the user asked to change them.
8. Present the complete proposed replacement model list and obtain explicit confirmation before writing settings.
9. After confirmation, call `configure_subagent_models` with `action: "update"` and the complete `models` array. Pass `subagent_provider`, `tool_name`, `max_depth`, or `enable_run_in_background` only when the user approved changing those values. Do not edit `settings.yaml` directly when this tool is available.
10. Settings apply live. Verify that the delegation tool is visible and its `model` enum contains exactly the selected aliases. If the package was newly installed or its Client bundle changed, restart DSH and refresh the page first.

## Settings shape

```yaml
subagent-dynamic-model:
  subagentProvider: spawn
  toolName: subagent_model
  maxDepth: 3
  enableRunInBackground: true
  models:
    - alias: fast
      provider: provider-route
      model: exact-model-id
      displayName: Human-readable model name
      tags: [fast, routine]
      description: Use for quick, well-scoped tasks where the user prefers low latency.
      # Optional output cap. On DSH rc.6 this is not restored after a
      # continuable child is cold-resumed:
      # maxTokens: 8192
```

`alias` values must be unique and use lowercase letters, numbers, underscores, or hyphens. Tags must be lowercase kebab-case. `provider` is the LLM route; `subagentProvider` is the execution backend and normally remains `spawn`.

## Editing safety

- `configure_subagent_models` is the preferred model-facing write path. It is limited to this plugin's namespace, validates the same schema as the UI, and needs no filesystem permission.
- Never call its `update` action without a direct user request and explicit confirmation of the complete replacement list.
- Prefer the settings UI when guiding a human through manual configuration.
- Do not add settings to `cordis.patch.yml`; the Cordis patch only mounts the plugin.
- Direct `settings.yaml` editing is a fallback only when the configuration tool is unavailable. Preserve unrelated namespaces and use normal approval escalation if the file is outside the workspace.
