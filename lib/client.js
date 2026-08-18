window.__ModuleLoader__.load({
  id: 'dsh-subagent-dynamic-model',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const SETTINGS_NAMESPACE = 'subagent-dynamic-model'
    const SETTINGS_ROUTE = '/dsh-subagent-dynamic-model/settings'

    const styles = {
      section: { maxWidth: 820, display: 'flex', flexDirection: 'column', gap: 16, color: 'var(--dsw-alias-label-primary)' },
      heading: { margin: 0, fontSize: 18, lineHeight: '26px' },
      intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '22px' },
      tip: { margin: 0, padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, color: 'var(--dsw-alias-label-secondary)', fontSize: 13, lineHeight: '20px' },
      code: { color: 'var(--dsw-alias-label-primary)', fontFamily: 'monospace', fontWeight: 600 },
      panel: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 },
      field: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      label: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
      input: { boxSizing: 'border-box', width: '100%', minHeight: 36, padding: '7px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit' },
      textarea: { boxSizing: 'border-box', width: '100%', minHeight: 76, resize: 'vertical', padding: '8px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit' },
      rowHead: { display: 'flex', alignItems: 'center', gap: 8 },
      rowTitle: { margin: 0, fontSize: 15, flex: 1 },
      actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      button: { minHeight: 34, padding: '0 13px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 17, background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', font: 'inherit' },
      primaryButton: { minHeight: 36, padding: '0 16px', border: 0, borderRadius: 18, background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)', cursor: 'pointer', font: 'inherit' },
      dangerButton: { minHeight: 32, padding: '0 11px', border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: 16, background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer', font: 'inherit' },
      error: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 },
      success: { margin: 0, color: 'var(--dsw-alias-state-success-primary)', fontSize: 13 },
      notice: { margin: 0, color: 'var(--dsw-alias-state-warn-label)', fontSize: 13 },
      checkbox: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 },
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function emptyModel() {
      return {
        alias: '',
        provider: '',
        model: '',
        displayName: '',
        tags: '',
        description: '',
        maxTokens: '',
      }
    }

    function draftFromValue(value) {
      const source = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
      const models = Array.isArray(source.models) ? source.models : []
      return {
        subagentProvider: typeof source.subagentProvider === 'string' ? source.subagentProvider : 'spawn',
        toolName: typeof source.toolName === 'string' ? source.toolName : 'subagent_model',
        maxDepth: Number.isSafeInteger(source.maxDepth) ? String(source.maxDepth) : '3',
        enableRunInBackground: source.enableRunInBackground !== false,
        models: models.map((entry) => ({
          alias: typeof entry.alias === 'string' ? entry.alias : '',
          provider: typeof entry.provider === 'string' ? entry.provider : '',
          model: typeof entry.model === 'string' ? entry.model : '',
          displayName: typeof entry.displayName === 'string' ? entry.displayName : '',
          tags: Array.isArray(entry.tags) ? entry.tags.join(', ') : '',
          description: typeof entry.description === 'string' ? entry.description : '',
          maxTokens: Number.isSafeInteger(entry.maxTokens) ? String(entry.maxTokens) : '',
        })),
      }
    }

    function parseTags(value) {
      return [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))]
    }

    function validateDraft(draft) {
      if (draft.subagentProvider.trim().length === 0) return 'Subagent provider is required.'
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(draft.toolName)) return 'Tool name must start with a letter and contain only letters, numbers, underscores, or hyphens.'
      if (draft.toolName === 'model_subagent_catalog' || draft.toolName === 'configure_subagent_models') return 'Tool name must differ from model_subagent_catalog and configure_subagent_models.'
      const maxDepth = Number(draft.maxDepth)
      if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) return 'Maximum depth must be a non-negative integer.'
      const aliases = new Set()
      for (let index = 0; index < draft.models.length; index += 1) {
        const row = draft.models[index]
        const label = `Model ${index + 1}`
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(row.alias)) return `${label}: alias must use lowercase letters, numbers, underscores, or hyphens.`
        if (aliases.has(row.alias)) return `${label}: alias “${row.alias}” is duplicated.`
        aliases.add(row.alias)
        if (row.provider.trim().length === 0) return `${label}: provider is required.`
        if (row.model.trim().length === 0) return `${label}: model id is required.`
        if (row.description.trim().length === 0) return `${label}: usage description is required.`
        const tags = parseTags(row.tags)
        if (tags.some((tag) => !/^[a-z0-9][a-z0-9-]*$/.test(tag))) return `${label}: tags must be lowercase kebab-case.`
        if (row.maxTokens.trim().length > 0) {
          const maxTokens = Number(row.maxTokens)
          if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) return `${label}: max tokens must be a positive integer.`
        }
      }
      return undefined
    }

    function settingsFromDraft(draft) {
      return {
        subagentProvider: draft.subagentProvider.trim(),
        toolName: draft.toolName.trim(),
        maxDepth: Number(draft.maxDepth),
        enableRunInBackground: draft.enableRunInBackground,
        models: draft.models.map((row) => ({
          alias: row.alias.trim(),
          provider: row.provider.trim(),
          model: row.model.trim(),
          ...(row.displayName.trim().length === 0 ? {} : { displayName: row.displayName.trim() }),
          tags: parseTags(row.tags),
          description: row.description.trim(),
          ...(row.maxTokens.trim().length === 0 ? {} : { maxTokens: Number(row.maxTokens) }),
        })),
      }
    }

    async function requestSettings(method, body) {
      const response = await fetch(SETTINGS_ROUTE, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      let value
      try {
        value = await response.json()
      } catch {
        throw new Error(`Subagent model settings returned HTTP ${response.status}.`)
      }
      if (!response.ok) {
        throw new Error(typeof value.error === 'string' ? value.error : `Subagent model settings returned HTTP ${response.status}.`)
      }
      return value
    }

    function Field(props) {
      return h('label', { style: styles.field },
        h('span', { style: styles.label }, props.label),
        props.children,
      )
    }

    function textInput(value, onChange, options = {}) {
      return h('input', {
        style: styles.input,
        value,
        onChange: (event) => onChange(event.target.value),
        ...options,
      })
    }

    function createSettingsSection(ctx, connection, remote) {
      return function SubagentModelsSettings() {
        const [snapshot, setSnapshot] = React.useState({
          status: 'loading',
          writable: false,
          descriptor: undefined,
          error: null,
          saved: false,
        })
        const [draft, setDraft] = React.useState(() => draftFromValue({}))

        React.useEffect(() => {
          let active = true
          let generation = 0
          const load = async () => {
            const ownGeneration = ++generation
            if (!connection.isLoopback) {
              if (active) setSnapshot({ status: 'unavailable', writable: false, descriptor: undefined, error: 'Settings can only be edited from the local DSH Web page.', saved: false })
              return
            }
            setSnapshot((previous) => ({ ...previous, status: 'loading', error: null, saved: false }))
            try {
              const value = await requestSettings('GET')
              const descriptor = value.descriptor
              if (descriptor === undefined) throw new Error('Subagent model settings endpoint returned no descriptor.')
              if (!active || ownGeneration !== generation) return
              setDraft(draftFromValue(descriptor.value))
              setSnapshot({ status: 'ready', writable: value.writable, descriptor, error: null, saved: false })
            } catch (error) {
              if (!active || ownGeneration !== generation) return
              setSnapshot((previous) => ({ ...previous, status: 'error', error: messageOf(error), saved: false }))
            }
          }
          const offRemote = remote.$on('settings/document-updated', (namespace) => {
            if (namespace === SETTINGS_NAMESPACE) load()
          })
          const offConnection = ctx.on('connection/reset', load)
          load()
          return () => {
            active = false
            offRemote()
            offConnection()
          }
        }, [])

        const updateGlobal = (field, value) => {
          setDraft((previous) => ({ ...previous, [field]: value }))
          setSnapshot((previous) => ({ ...previous, saved: false }))
        }
        const updateModel = (index, field, value) => {
          setDraft((previous) => ({
            ...previous,
            models: previous.models.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row),
          }))
          setSnapshot((previous) => ({ ...previous, saved: false }))
        }
        const addModel = () => {
          setDraft((previous) => ({ ...previous, models: [...previous.models, emptyModel()] }))
          setSnapshot((previous) => ({ ...previous, saved: false }))
        }
        const removeModel = (index) => {
          setDraft((previous) => ({ ...previous, models: previous.models.filter((_row, rowIndex) => rowIndex !== index) }))
          setSnapshot((previous) => ({ ...previous, saved: false }))
        }
        const save = async () => {
          const failure = validateDraft(draft)
          if (failure !== undefined) {
            setSnapshot((previous) => ({ ...previous, status: 'error', error: failure, saved: false }))
            return
          }
          if (!snapshot.writable || snapshot.descriptor === undefined) return
          setSnapshot((previous) => ({ ...previous, status: 'saving', error: null, saved: false }))
          try {
            const value = await requestSettings('PUT', {
              section: settingsFromDraft(draft),
              expectedRevision: snapshot.descriptor.revision,
            })
            const descriptor = value.descriptor
            setDraft(draftFromValue(descriptor.value))
            setSnapshot((previous) => ({ ...previous, status: 'ready', writable: value.writable, descriptor, error: null, saved: true }))
          } catch (error) {
            setSnapshot((previous) => ({ ...previous, status: 'error', error: messageOf(error), saved: false }))
          }
        }

        const modelCards = draft.models.map((row, index) => h('div', { key: `${index}:${row.alias}`, style: styles.panel },
          h('div', { style: styles.rowHead },
            h('h3', { style: styles.rowTitle }, row.displayName.trim() || row.alias.trim() || `Model ${index + 1}`),
            h('button', { type: 'button', style: styles.dangerButton, onClick: () => removeModel(index), disabled: !snapshot.writable }, 'Remove'),
          ),
          h('div', { style: styles.grid },
            h(Field, { label: 'Alias' }, textInput(row.alias, (value) => updateModel(index, 'alias', value), { placeholder: 'fast' })),
            h(Field, { label: 'Display name' }, textInput(row.displayName, (value) => updateModel(index, 'displayName', value), { placeholder: 'Fast model' })),
            h(Field, { label: 'Provider route' }, textInput(row.provider, (value) => updateModel(index, 'provider', value), { placeholder: 'provider-id' })),
            h(Field, { label: 'Model ID' }, textInput(row.model, (value) => updateModel(index, 'model', value), { placeholder: 'model-id' })),
            h(Field, { label: 'Tags (comma-separated)' }, textInput(row.tags, (value) => updateModel(index, 'tags', value), { placeholder: 'fast, routine' })),
            h(Field, { label: 'Max tokens (optional)' }, textInput(row.maxTokens, (value) => updateModel(index, 'maxTokens', value), { type: 'number', min: 1, step: 1, placeholder: 'Provider default' })),
          ),
          h(Field, { label: 'When to use this model' },
            h('textarea', {
              style: styles.textarea,
              value: row.description,
              onChange: (event) => updateModel(index, 'description', event.target.value),
              placeholder: 'Use for quick, well-scoped tasks where low latency matters.',
            }),
          ),
        ))

        return h('section', { style: styles.section },
          h('h2', { style: styles.heading }, 'Subagent Models'),
          h('p', { style: styles.intro }, 'Choose the model routes exposed to AI agents for delegated work. Changes are stored under subagent-dynamic-model in settings.yaml and apply live.'),
          h('p', { style: styles.tip },
            'Prefer guided setup? In chat, run ',
            h('code', { style: styles.code }, '/model-subagent-setup'),
            ' to discover available routes and generate distinct routing descriptions.',
          ),
          h('div', { style: styles.panel },
            h('h3', { style: styles.rowTitle }, 'Delegation defaults'),
            h('div', { style: styles.grid },
              h(Field, { label: 'Subagent provider' }, textInput(draft.subagentProvider, (value) => updateGlobal('subagentProvider', value), { placeholder: 'spawn' })),
              h(Field, { label: 'Tool name' }, textInput(draft.toolName, (value) => updateGlobal('toolName', value), { placeholder: 'subagent_model' })),
              h(Field, { label: 'Maximum depth' }, textInput(draft.maxDepth, (value) => updateGlobal('maxDepth', value), { type: 'number', min: 0, step: 1 })),
            ),
            h('label', { style: styles.checkbox },
              h('input', {
                type: 'checkbox',
                checked: draft.enableRunInBackground,
                onChange: (event) => updateGlobal('enableRunInBackground', event.target.checked),
              }),
              'Enable durable background subagents',
            ),
          ),
          ...modelCards,
          h('div', { style: styles.actions },
            h('button', { type: 'button', style: styles.button, onClick: addModel, disabled: !snapshot.writable }, 'Add model'),
            h('button', { type: 'button', style: styles.primaryButton, onClick: save, disabled: !snapshot.writable || snapshot.status === 'saving' }, snapshot.status === 'saving' ? 'Saving…' : 'Save changes'),
          ),
          !snapshot.writable && snapshot.status === 'ready' ? h('p', { style: styles.notice }, 'This settings provider is read-only.') : null,
          snapshot.error !== null ? h('p', { style: styles.error }, snapshot.error) : null,
          snapshot.saved ? h('p', { style: styles.success }, 'Saved. The subagent tool has been updated live.') : null,
          snapshot.status === 'loading' ? h('p', { style: styles.intro }, 'Loading settings…') : null,
        )
      }
    }

    const inject = ['slots', 'connection', 'remote']

    function apply(ctx) {
      const slots = ctx.get('slots')
      const connection = ctx.get('connection')
      const remote = ctx.get('remote')
      if (slots === undefined || connection === undefined || remote === undefined) return
      const Section = createSettingsSection(ctx, connection, remote)
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'subagent-dynamic-model',
        order: 25,
        label: 'Subagent Models',
      }, Section))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
