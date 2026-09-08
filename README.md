# DSH Subagent Model Router

**Give every delegated task the right model—automatically.**

Stop using one model for every kind of work. Configure your preferred fast, affordable, specialized, and high-reasoning models once; the router gives your agent the aliases, tags, and guidance it needs to intelligently select the best route for each delegated task.

That means faster routine work, stronger results on difficult problems, better control over cost, and less model micromanagement. Subagents can run in parallel, their results are reliably joined before the parent responds, and the model chosen for each task stays visible throughout the UI.

## Why use it?

- **Better results where they matter** — reserve your strongest models for architecture, security, deep reasoning, or critical review.
- **Lower cost and latency** — send routine searches, edits, and focused implementation work to faster or more economical routes.
- **Automatic, task-aware routing** — friendly aliases, capability tags, and plain-language usage guidance help the orchestrator choose intelligently.
- **Confident parallel delegation** — launch multiple specialists in the background and reliably collect every result before synthesis.
- **Clear model visibility** — see which model actually handled a task in subagent headers, catalog rows, and Better Sidebar's Tasks view.
- **Easy setup** — configure your model team from the Web UI, through a guided skill, or directly in `settings.yaml`.

> [!TIP]
> Already using [Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)? The router enhances its existing **Tasks** tree with inline model chips—no separate topology view or Better Sidebar modification required.

## See it in action

### Follow every specialist from Better Sidebar

![Better Sidebar Tasks view showing delegated subagents and their selected model chips](docs/screenshots/better-sidebar-task-model-chips.png)

*See parallel delegated work, current status, and the selected model together in the task tree you already use.*

### Build your ideal model team

![Subagent Model Router settings for aliases, providers, tags, token limits, and routing guidance](docs/screenshots/subagent-model-router-settings.png)

*Define friendly routes and tell the orchestrator when each model shines—from quick, budget-friendly tasks to your most demanding work.*

## What it adds

- `subagent_model`: a delegation tool whose `model` argument is restricted to user-configured aliases.
- `wait-for-subagents`: a join tool that waits for this agent's outstanding continuable background children, including standard and model-routed delegations, and returns their terminal results.
- Per-model tags and routing descriptions embedded in the tool schema and system prompt.
- `model_subagent_catalog`: a read-only view of models advertised by registered LLM providers.
- `configure_subagent_models`: a namespace-scoped model-facing tool for reading or updating this plugin's settings without filesystem access.
- `model-subagent-setup`: a guided skill for selecting routes, generating routing guidance, obtaining confirmation, and saving through the constrained configuration tool.
- **Settings → Subagent Models**: a Web settings page for manually adding, editing, and removing routes.
- A hot-reloaded `subagent-model-router` namespace in `~/.dsh/settings.yaml`.
- Foreground execution and durable continuable background subagents.
- An active-model chip in an opened subagent header.
- Active-model chips in healthy rows of the parent session's subagent catalog.
- An optional inline model chip in each existing Better Sidebar **Tasks** row.

With an empty `models` list, the catalog, configuration, and wait tools remain available alongside the settings page and setup skill, but `subagent_model` is not registered. This provides a bootstrap state for initial setup.

## Orchestrator behavior

When model-selectable delegation is available, the system prompt tells the orchestrator not to duplicate work it delegated. After issuing all intended background delegations, it must call `wait-for-subagents` before synthesizing the child results or giving a final answer. While a same-session completion goal is active, the orchestrator must not merely report that another model is handling the task and end its turn with background subagents still outstanding: ending the turn triggers immediate goal continuation and can race child tracking. Waiting joins the outstanding work so the orchestrator can synthesize the results and continue or complete the goal. The wait tool joins every continuable background child started by that parent through `subagent`, `subagent_fork`, `subagent_model`, or `auto_agent_run`; it remains useful when no model routes are configured. It reserves standard, forked, and project-specialist delegation calls before they can publish a child, and after plugin reload it discovers direct continuable children when their durable descriptors confirm their mode and the live Agent is either running or interrupted with parked input (reported separately as paused). It preserves every terminal content block and drops retained records when the parent is disposed, while foreground one-shot runs and job-backed non-continuable delegations remain outside this join because their owning tool already returns or collects the result.

Direct human steering must not leave the parent blocked in an old join. When a committed `agent/inbox/spliced` event inserts a `source.kind: user` message at `next-step` for that parent, an active wait returns `{ kind: "interrupted", pending: [...] }` without cancelling or consuming any child. Each pending entry carries the exact child and run identity when available. The DSH agent loop does not automatically schedule a second tool call after the parent answers. Instead, the plugin's system prompt, tool description, and interruption result explicitly require the parent to answer the steering message first and then call `wait-for-subagents` again before final synthesis. That second call resumes the retained records and returns their eventual terminal output; queued `next-turn` input, model-authored context, cancellations, and events for other sessions do not trigger this outcome. A simultaneous child completion remains retained for the resumed wait.

The continuation manager's durable settlement notice triggers immediate reconciliation when a terminal lifecycle event was missed. Recovery requires matching post-boundary evidence in both the retained child epoch log and the parent notice, so an absent registry entry or an idle/resumable child is never treated as success by itself. For an ordinary tracked start, the record remains bound to the exact child and run identity. After plugin reload, a genuinely running child can instead be discovered without a published run id; its exact retained Agent object plus child and parent log boundaries identify that observed activation safely. A ten-second watchdog provides the same reconciliation as a fallback if the live notice event was also missed. Cancellation still rejects the active tool call without consuming records, and parent disposal still releases tracked children and active waits. If another plugin already owns or scope-shadows the `wait-for-subagents` name, this plugin leaves it untouched and suppresses its wait-specific guidance and tracking for the affected agents.

An interrupted child can be idle with queued input that will not run until explicitly resumed. The wait returns `{ kind: "paused", pending: [...], paused: [...] }` for an exact live child with parked input and an aborted activation suffix, including when discovered after reload. It does not settle the child, discard its queue, or wake it automatically. Address the paused state explicitly: if work should continue, use `send_message` with appropriate instructions, then call the wait again; otherwise report the pause and request direction. Do not blindly restart intentionally interrupted work or repeatedly re-wait. All pending records remain joinable. An idle child without parked input, or a child still running, is not classified this way.

If a committed manager settlement notice exists but the exact retained result is unavailable, corrupt, or inconsistent, watchdog reconciliation reports a diagnostic error rather than fabricating output or waiting forever. The immediate notice path leaves room for the normal terminal event to arrive first. Plugin unload explicitly rejects active waits and releases tracker state and watchdog timers.

## Model identity chips

The opened subagent header and every healthy row in its parent's subagent catalog show the configured friendly display name for the latest adapter-resolved request, falling back to the model id when that route is not in the current router settings. Hover and accessible text expose the complete `provider/model` route. The plugin resets the route at the child's own descriptor so a fork cannot inherit its ancestor's model, and it omits the chip until the child records an authoritative request route.

When Better Sidebar is installed, the router's client extension maps its semantic **Tasks** tree rows to the authoritative DSH session/catalog snapshot and appends a compact, non-interactive chip beside each subagent label. It reuses the native header/catalog projection and friendly-name formatter, preserves completed-run identity, and adds the full route to the tree row's accessible name. The observer and every injected node are lifecycle-managed and removed when the router unloads. No Better Sidebar source change, replacement tab, runtime import, or settings toggle is required; when Better Sidebar is absent, the extension is inert.

## Requirements

- DeepSeek Harness `0.1.0-rc.6` or compatible
- The Web profile and built-in subagent conversation UI
- A preset exposing the normal skill loader/tool
- The Host `spawn` subagent provider, included by standard DSH profiles
- Optional: a compatible `dsh-better-sidebar` release with its semantic Tasks tree (`0.15.2` and `0.16.x` are supported)

## Install

```sh
# From npm once published
dsh plugin --profile web add dsh-subagent-model-router

# Or from inside this checkout
dsh plugin --profile web add .
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

The endpoint rejects non-loopback transport and cross-origin mutations by default. A trusted loopback reverse proxy may allow specific browser origins with the comma-separated `DSH_SUBAGENT_MODEL_ROUTER_TRUSTED_ORIGINS` environment variable, for example `https://dsh.example.test`. Requests must still arrive over loopback, and each mutation Origin must exactly match both the request Host and an allowlisted origin.

## Configure through the model-facing tool

`configure_subagent_models` is the preferred path for agent-assisted setup:

- `action: "get"` reads the current normalized settings.
- `action: "update"` replaces the complete model list and optionally changes the backend, depth, or background policy.
- The tool calls the Settings service directly and can modify only `subagent-model-router`; it accepts no filesystem path and cannot read or write other namespaces.
- Updates pass the same schema and provider-capability validation as the Web UI, persist to `settings.yaml`, and apply live.

The update action is intentionally documented for direct user-requested changes only. The setup skill must show the complete proposed list and receive explicit confirmation before calling it.

## Configure through `settings.yaml`

Merge the following namespace into `~/.dsh/settings.yaml`:

```yaml
subagent-model-router:
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

## Known limitations

DSH rc.6 has no additive slot inside a subagent catalog row, so the plugin owns the existing `subagent-catalog` header cell to render row chips. It claims that cell by registering at `priority: -1` — a list cell renders its lowest live priority, and the host's own entry sits at the default `0`. The `subagent-model` cell is registered the same way so a host build that also fills it stays shadowed rather than clashing. Catalog interaction changes in DSH must be mirrored here until the host exposes a row extension slot or renders `subagentModelRoute` itself.

Better Sidebar currently exposes tab and file-viewer registration but no additive seam inside its built-in Tasks rows. To keep the feature wholly owned by this plugin, the router targets only Better Sidebar's semantic root/tree/treeitem attributes and the public DSH sessions snapshot; it does not depend on CSS-module class names. An incompatible change to that semantic DOM may require a router update. The router deliberately contributes no fallback topology tab, keeping one authoritative task tree.

## Development

```sh
pnpm install
pnpm test
```

Project layout:

```text
dsh-subagent-model-router/
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
