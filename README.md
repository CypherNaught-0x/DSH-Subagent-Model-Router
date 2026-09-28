# DSH Subagent Model Router

**Give every delegated task the right model—automatically.**

Stop using one model for every kind of work. Configure your preferred fast, affordable, specialized, and high-reasoning models once; the router gives your agent the aliases, tags, and guidance it needs to intelligently select the best route for each delegated task.

That means faster routine work, stronger results on difficult problems, better control over cost, and less model micromanagement. Subagents can run in parallel, their results are reliably joined before the parent responds, and the model chosen for each task stays visible throughout the UI.

## Why use it?

- **Better results where they matter** — reserve your strongest models for architecture, security, deep reasoning, or critical review.
- **Lower cost and latency** — send routine searches, edits, and focused implementation work to faster or more economical routes.
- **Automatic, task-aware routing** — friendly aliases, capability tags, and plain-language usage guidance help the orchestrator choose intelligently.
- **Confident parallel delegation** — launch multiple specialists in the background and reliably collect every result before synthesis.
- **Clear model visibility** — see which model actually handled a task in subagent headers and in the optional Better Sidebar **Sub-agents** tab.
- **Easy setup** — configure your model team from the Web UI, through a guided skill, or directly in a Cordis patch.

> [!TIP]
> Already using [Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)? The router adds an optional **Sub-agents** tab through Better Sidebar's public `registerTab` API.

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
- `configure_subagent_models`: a model-facing tool that reads or replaces only this plugin entry's configuration, without filesystem access.
- `model-subagent-setup`: a guided skill for selecting routes, generating routing guidance, obtaining confirmation, and saving through the constrained configuration tool.
- **Settings → Subagent Models**: a Web settings page for manually adding, editing, and removing routes.
- A hot-reloaded plugin configuration: the `config:` of the `- id: dsh-subagent-model-router` Loader entry in a Cordis patch.
- Foreground execution and durable continuable background subagents.
- Configurable stale-subagent filtering for listing tools, defaulting to 20 parent/user message turns without contact.
- An active-model chip in an opened subagent header.
- An optional Better Sidebar **Sub-agents** tab, with active-model chips on its rows, registered through the public sidebar service (when installed).

With an empty `models` list, the catalog, configuration, and wait tools remain available alongside the settings page and setup skill, but `subagent_model` is not registered. This provides a bootstrap state for initial setup.

## Orchestrator behavior

When model-selectable delegation is available, the system prompt tells the orchestrator not to duplicate work it delegated. After issuing all intended background delegations, it must call `wait-for-subagents` before synthesizing the child results or giving a final answer. While a same-session completion goal is active, the orchestrator must not merely report that another model is handling the task and end its turn with background subagents still outstanding: ending the turn triggers immediate goal continuation and can race child tracking. Waiting joins the outstanding work so the orchestrator can synthesize the results and continue or complete the goal. The wait tool joins every continuable background child started by that parent through `subagent`, `subagent_fork`, `subagent_model`, or `auto_agent_run`; it remains useful when no model routes are configured. It reserves standard, forked, and project-specialist delegation calls before they can publish a child, and after plugin reload it discovers direct continuable children when their durable descriptors confirm their mode and the live Agent is either running or interrupted with parked input (reported separately as paused). It preserves every terminal content block and drops retained records when the parent is disposed, while foreground one-shot runs and job-backed non-continuable delegations remain outside this join because their owning tool already returns or collects the result.

Direct human steering must not leave the parent blocked in an old join. When a committed `agent/inbox/spliced` event inserts a `source.kind: user` message at `next-step` for that parent, an active wait returns `{ kind: "interrupted", pending: [...] }` without cancelling or consuming any child. Each pending entry carries the exact child and run identity when available. The DSH agent loop does not automatically schedule a second tool call after the parent answers. Instead, the plugin's system prompt, tool description, and interruption result explicitly require the parent to answer the steering message first and then call `wait-for-subagents` again before final synthesis. That second call resumes the retained records and returns their eventual terminal output; queued `next-turn` input, model-authored context, cancellations, and events for other sessions do not trigger this outcome. A simultaneous child completion remains retained for the resumed wait.

The continuation manager's durable settlement notice triggers immediate reconciliation when a terminal lifecycle event was missed. Recovery requires matching post-boundary evidence in both the retained child epoch log and the parent notice, so an absent registry entry or an idle/resumable child is never treated as success by itself. For an ordinary tracked start, the record remains bound to the exact child and run identity. After plugin reload, a genuinely running child can instead be discovered without a published run id; its exact retained Agent object plus child and parent log boundaries identify that observed activation safely. A ten-second watchdog provides the same reconciliation as a fallback if the live notice event was also missed. Cancellation still rejects the active tool call without consuming records, and parent disposal still releases tracked children and active waits. If another plugin already owns or scope-shadows the `wait-for-subagents` name, this plugin leaves it untouched and suppresses its wait-specific guidance and tracking for the affected agents.

An interrupted child can be idle with queued input that will not run until explicitly resumed. The wait returns `{ kind: "paused", pending: [...], paused: [...] }` for an exact live child with parked input and an aborted activation suffix, including when discovered after reload. It does not settle the child, discard its queue, or wake it automatically. Address the paused state explicitly: if work should continue, use `send_message` with appropriate instructions, then call the wait again; otherwise report the pause and request direction. Do not blindly restart intentionally interrupted work or repeatedly re-wait. All pending records remain joinable. An idle child without parked input, or a child still running, is not classified this way.

As a defense in depth for Harness versions affected by the continuable ownership-hold ordering bug, the router rejects a model tool call that uses `send_message` to target its own calling agent id. The rejection happens in the public `tools/execute` waterfall before the built-in tool calls the subagent service, and a resident child receives its direct parent id in the error hint. This deliberately narrow guard does not replace the core fix: it cannot protect direct subagent-service callers, reject every other invalid resident relationship, or repair ownership state already corrupted in the current host process. Deploying this source requires the normal plugin rebuild/reload (or a host restart); an already-corrupted process still requires a host restart.

`listingInactivityTurns` keeps old continuable children from crowding model-facing discovery. For each direct parent, the router counts incoming human messages (or parent-agent relay messages for nested agents) and resets a child's window whenever that child receives a parent/user message. Once the configured number of turns passes without contact, `list_agents` omits that child. This is presentation-only: the durable child is not deleted, unloaded, or made unaddressable, so a known id still works with `send_message` and can reappear after contact. Set the option to `0` to disable filtering. After a router reload, children without reliable process-local contact history receive a fresh visibility window rather than being hidden on incomplete evidence.

If a committed manager settlement notice exists but the exact retained result is unavailable, corrupt, or inconsistent, watchdog reconciliation reports a diagnostic error rather than fabricating output or waiting forever. The immediate notice path leaves room for the normal terminal event to arrive first. Plugin unload explicitly rejects active waits and releases tracker state and watchdog timers.

## Model identity chips

The opened subagent header and every row of the Better Sidebar **Sub-agents** tab show the configured friendly display name for the latest adapter-resolved request, falling back to the model id when that route is not in the current router settings. Hover and accessible text expose the complete `provider/model` route. The plugin resets the route at the child's own descriptor so a fork cannot inherit its ancestor's model, and it omits the chip until the child records an authoritative request route.

The native subagent catalog in the session header (`subagent-catalog`) belongs to DSH and shows no model chip; the router no longer replaces it.

When Better Sidebar is installed, the router registers a single-instance **Sub-agents** tab with `betterSidebar.registerTab({ id, title, component, single, order })`. The tab reads each parent's `subagentCatalog` Session projection from the Sessions service list, loads it with `sessions.refreshProjections()` for the root and every expanded branch while visible, renders nested children with model identities, and opens a child through `uiWorkspace.openSession()`. Registration is scoped with `ctx.inject(['betterSidebar'], ...)`, so the native router never waits for the optional service; late service load and unload are handled automatically. The native Better Sidebar controls which tab is selected and currently restores its Start page after refresh; use the `+` menu to reopen **Sub-agents**. (The optional bottom workbench has separate persistence semantics.) When the service is absent, the integration is inert.

## Compatibility

| Plugin version | DeepSeek Harness | Configuration store |
| --- | --- | --- |
| `0.9.0` | `0.1.7-rc.2` and later `0.1.7` builds | Loader entry `config:` in a Cordis patch |
| `0.8.0` and earlier | `0.1.0-rc.6` to `0.1.6` | `subagent-model-router` section of `~/.dsh/settings.yaml` |

DSH 0.1.7 removed `settings.yaml` and the `ctx.settings.register()/get()/watch()` API. A plugin now declares a Config schema whose fields are `.volatile()`: DSH commits a changed value into the running plugin and emits `loader/volatile-update` instead of remounting it, and the Settings service (`ctx.settings`) exposes those fields as a form addressed by the plugin's Loader entry id. This release therefore:

- declares every setting as a volatile Config field and reloads its routes on `loader/volatile-update`;
- writes through `ctx.settings.replace('dsh-subagent-model-router', …)`, which persists into the active profile's `cordis.patch.yml`;
- takes `@deepseek-ai/schemastery` as a peer dependency, because DSH resolves only peer dependencies of a linked plugin root from the running installation and `.volatile()` exists only in the 0.1.7 copy;
- leaves the session-header subagent catalog to DSH, which now renders it from the `subagentCatalog` projection.

On first boot, DSH 0.1.7 renames `~/.dsh/settings.yaml` to `settings.yaml.imported` and imports each section into the entry whose id matches the section name. The old `subagent-model-router` section does not match the entry id `dsh-subagent-model-router`, so it is not imported: move it by hand into a Cordis patch as shown in [Configure through a Cordis patch](#configure-through-a-cordis-patch).

DSH 0.1.7 also caps a parent at 8 active continuable children (`maxActiveSubagents` of the Host `subagent` entry). A background `subagent_model` call beyond that cap fails with `ACTIVATION_LIMIT_REACHED`; wait for a child to finish or raise the cap.

## Requirements

- DeepSeek Harness `0.1.7-rc.2` or a later `0.1.7` build
- The Web profile and built-in subagent conversation UI
- A preset exposing the normal skill loader/tool
- The Host `spawn` subagent provider, included by standard DSH profiles
- Optional: a compatible `dsh-better-sidebar` release exposing the public `registerTab` API (including the native right-sidebar surface)

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
- subagent backend, delegation depth, background execution, and stale-listing turn threshold.

The page talks to a package-owned, same-origin Host endpoint (`/dsh-subagent-model-router/settings`) backed by the DSH Settings service, with schema validation, provider-capability validation, and revision conflict protection. Saving writes the `config:` of the `- id: dsh-subagent-model-router` entry in the active profile's `cordis.patch.yml`; the change applies live: the old delegation tool is removed and the updated schema and prompt guidance are registered immediately. The router turns off the Settings service's generated form for its entry so the same fields are not edited from two pages.

A home patch (`$DSH_HOME/cordis.patch.yml`) or a `--patch` overlay applies after the profile patch. When one of them sets this entry, the Settings service refuses the write and the page shows an error that names both files; edit the overriding patch instead.

The endpoint rejects non-loopback transport and cross-origin mutations by default. A trusted loopback reverse proxy may allow specific browser origins with the comma-separated `DSH_SUBAGENT_MODEL_ROUTER_TRUSTED_ORIGINS` environment variable, for example `https://dsh.example.test`. Requests must still arrive over loopback, and each mutation Origin must exactly match both the request Host and an allowlisted origin.

## Configure through the model-facing tool

`configure_subagent_models` is the preferred path for agent-assisted setup:

- `action: "get"` reads the current normalized settings.
- `action: "update"` replaces the complete model list and optionally changes the backend, depth, or background policy.
- The tool calls the Settings service directly and can modify only its own Loader entry (`dsh-subagent-model-router`, or the id it is mounted under); it accepts no filesystem path and cannot read or write other entries.
- Updates pass the same schema and provider-capability validation as the Web UI, persist to the profile's `cordis.patch.yml`, and apply live.
- An update fails with an explicit error when the Settings service is not loaded, or when a home patch or `--patch` overlay overrides the entry.

The update action is intentionally documented for direct user-requested changes only. The setup skill must show the complete proposed list and receive explicit confirmation before calling it.

## Configure through a Cordis patch

Put the configuration in the `config:` of the plugin's Loader entry. The entry already exists (the bundle mounts it), so the patch names only its `id`. Use the home patch `$DSH_HOME/cordis.patch.yml` (default `~/.dsh/cordis.patch.yml`) to configure every profile at once, or a profile's own `cordis.patch.yml` to configure one profile:

```yaml
- id: dsh-subagent-model-router
  config:
    subagentProvider: spawn
    maxDepth: 3
    enableRunInBackground: true
    listingInactivityTurns: 20
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

See `examples/cordis.patch.yml` for a copyable patch. A patch entry's `config:` replaces the entry's whole config, so list every field you set. With `"patchReload": "live"` in the profile's `package.json` (the web profile default), DSH reloads edited patches while running and the router applies the new routes without a restart; with `"startup"` the change applies at the next launch. An invalid edit is logged and the previous routes stay active.

A configuration in the home patch or a `--patch` overlay takes precedence over the profile patch, so Web UI saves and `configure_subagent_models` updates are refused while it is present (see above).

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
| `models[].maxTokens` | provider default | Optional cap for an initially created or resident child. DSH rc.6 did not restore it after a continuable child was cold-resumed; not re-verified on 0.1.7. |
| `subagentProvider` | `spawn` | Subagent execution backend, not the LLM provider. |
| `maxDepth` | `3` | Maximum delegation depth enforced by the backend for `subagent_model` children. |
| `enableRunInBackground` | `true` | Enable durable background children and default to them. |
| `listingInactivityTurns` | `20` | Omit children from `list_agents` after this many parent/user message turns without contact. `0` disables filtering; direct addressing and resumability are unchanged. |

Every field is volatile. The delegation tool is always named `subagent_model`; a legacy `toolName` field is ignored.

The live catalog is advisory: some adapters accept model ids they do not advertise. Manually entered ids remain allowed but should be user-confirmed.

## Known limitations

The native session-header subagent catalog shows no model chip: DSH 0.1.7 has no additive slot inside a catalog row, and this release no longer replaces the host's `subagent-catalog` cell. The `subagent-model` header chip is still registered at `priority: -1` so a host build that also fills that cell stays shadowed rather than clashing.

Better Sidebar's public tab registry is the supported integration seam. The router does not scrape foreign DOM, inject into native Tasks rows, or modify Better Sidebar source. The registered tab is optional and scoped to the service lifecycle; if Better Sidebar is unavailable, native headers, catalogs, settings, and model chips continue unchanged.

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
├── examples/cordis.patch.yml
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
