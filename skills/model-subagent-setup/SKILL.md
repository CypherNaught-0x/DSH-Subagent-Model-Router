# Set up model-selectable subagents

Use this skill to choose which of the Harness's existing model routes are exposed through `subagent_model`, then write concise routing guidance that helps an AI agent choose among them.

## Workflow

1. Call `model_subagent_catalog` before proposing any configuration. It reports the current agent route and the models advertised by every registered provider.
2. Treat the catalog as advisory. A provider may accept an unlisted model id, but never invent an unlisted route without the user naming or confirming it.
3. Show the user a compact shortlist. Include the exact `provider/model` identity and clearly distinguish it from the current agent route.
4. Ask one concise multi-select question for the routes the user wants exposed. If the user has already named the routes, do not ask again.
5. For each selected route, propose:
   - a short lowercase alias used by the `model` tool argument;
   - 2-5 lowercase kebab-case tags;
   - a one-sentence `description` beginning with “Use for …” or “Use when …”.
6. Ground descriptions in provider catalog metadata and the user's intended workflow. Do not make unsupported claims about price, speed, context size, privacy, benchmark rank, or modalities. When the catalog does not describe a distinction, ask the user or phrase the guidance as their routing preference.
7. Present the complete proposed configuration and obtain confirmation before editing profile configuration.
8. Read the target profile's existing `cordis.patch.yml`, preserve unrelated entries, and add or replace the id-targeted patch shown below. A DSH patch replaces the row's whole `config`, so keep every field the user wants.
9. Validate with `dsh --profile <profile> --dump-config`. If the Harness is already running, profile patch HMR should apply a valid edit; if the package was newly installed, tell the user to restart that profile.
10. Re-run `model_subagent_catalog` only if provider topology changed during setup. After configuration is active, verify that `subagent_model` is visible and that its `model` enum contains exactly the selected aliases.

## Configuration shape

```yaml
- id: dsh-subagent-dynamic-model
  config:
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

`alias` values must be unique and use lowercase letters, numbers, underscores, or hyphens. Tags must be lowercase kebab-case. The configured `provider` is the LLM route; `subagentProvider` is the execution backend and normally remains `spawn`.

## Editing safety

- Default to the currently active profile; in the Web app this is normally `web`. If ambiguous, ask which profile to configure.
- Use `${DSH_HOME:-$HOME/.dsh}/profiles/<profile>/cordis.patch.yml` unless the runtime reports a different DSH home.
- Read before editing and never replace the complete patch file just to add this row.
- Do not edit a shipped agent preset or the installation's shipped composition.
- If file policy blocks the profile edit, use the normal approval escalation for that exact write; do not work around the sandbox.
