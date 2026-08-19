# Set up model-selectable subagents

Use this skill to choose which existing Harness model routes are exposed through `subagent_model`, then generate concise routing guidance for each route. Configuration is stored under `subagent-model-router` in `settings.yaml`; do not put model configuration in a Cordis patch.

## Workflow

1. Call `model_subagent_catalog` before proposing configuration. It reports the current agent route and models advertised by each registered provider.
2. Treat the catalog as advisory. A provider may accept an unlisted model id, but never invent an unlisted route without the user naming or confirming it.
3. Show a compact shortlist with exact `provider/model` identities and distinguish alternatives from the current agent route.
4. Ask one concise multi-select question for the routes the user wants exposed. If the user already named them, do not ask again.
5. Determine a concrete routing role for every selected model before writing tags or descriptions:
   - First infer suitable workloads from the exact `provider/model` identity, catalog metadata, and reliable general knowledge about that model family.
   - Use inferred knowledge only when it supports a meaningful task distinction, such as routine implementation, deep architecture reasoning, large-context review, security analysis, multimodal work, or inexpensive background work.
   - If the evidence is missing, uncertain, or does not distinguish this route from the others, do not produce a generic fallback. Use `ask_user_question` once with one multi-select question per ambiguous model. Offer 3-5 concrete workload options appropriate to the available evidence and include a “Custom role” option. Examples include routine coding, complex debugging, architecture and planning, adversarial review, large-context synthesis, and multimodal analysis.
   - Treat the user's selected options as their routing policy. If they select “Custom role,” ask only for the missing custom wording.
6. For each route propose:
   - a short lowercase alias used by the tool's `model` argument;
   - 2-5 lowercase kebab-case tags that reflect its concrete routing role;
   - a one-sentence `description` beginning with “Use for …” or “Use when …” that names the work to delegate and, where useful, how it differs from the other configured routes.
7. Reject circular or content-free descriptions. Never write phrases such as “when selecting the Luna route,” “when using this model,” “for broad tasks,” or “for coding tasks” without specific workload criteria. A valid description must help an agent choose between at least two configured routes without relying on their aliases or model names.
8. Ground factual claims in provider metadata or reliable model knowledge. Do not invent claims about price, speed, context size, privacy, benchmark rank, or modalities. When such a property would affect routing but is uncertain, ask the user instead.
9. Call `configure_subagent_models` with `action: "get"` to preserve the current backend, depth, and background defaults unless the user asked to change them.
10. Present the complete proposed replacement model list and obtain explicit confirmation before writing settings.
11. After confirmation, call `configure_subagent_models` with `action: "update"` and the complete `models` array. Pass `subagent_provider`, `max_depth`, or `enable_run_in_background` only when the user approved changing those values. Do not edit `settings.yaml` directly when this tool is available.
12. Settings apply live. Verify that the delegation tool is visible and its `model` enum contains exactly the selected aliases. If the package was newly installed or its Client bundle changed, restart DSH and refresh the page first.

## Settings shape

```yaml
subagent-model-router:
  subagentProvider: spawn
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
