const ALIAS_RE = /^[a-z0-9][a-z0-9_-]*$/
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/

function requiredText(value, field, index) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`dsh-subagent-model-router: models[${index}].${field} must be a non-empty string`)
  }
  return value.trim()
}

/** Validate, normalize, and detach configured model choices. */
function normalizeConfiguredModels(input) {
  if (!Array.isArray(input)) {
    throw new Error('dsh-subagent-model-router: models must be an array')
  }

  const aliases = new Set()
  return input.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`dsh-subagent-model-router: models[${index}] must be an object`)
    }

    const alias = requiredText(entry.alias, 'alias', index)
    if (!ALIAS_RE.test(alias)) {
      throw new Error(`dsh-subagent-model-router: models[${index}].alias must use lowercase letters, numbers, underscores, or hyphens`)
    }
    if (aliases.has(alias)) {
      throw new Error(`dsh-subagent-model-router: duplicate model alias "${alias}"`)
    }
    aliases.add(alias)

    const provider = requiredText(entry.provider, 'provider', index)
    const model = requiredText(entry.model, 'model', index)
    const description = requiredText(entry.description, 'description', index)
    const displayName = entry.displayName === undefined
      ? alias
      : requiredText(entry.displayName, 'displayName', index)

    const sourceTags = entry.tags ?? []
    if (!Array.isArray(sourceTags)) {
      throw new Error(`dsh-subagent-model-router: models[${index}].tags must be an array`)
    }
    const tags = []
    const seenTags = new Set()
    for (let tagIndex = 0; tagIndex < sourceTags.length; tagIndex += 1) {
      const tag = requiredText(sourceTags[tagIndex], `tags[${tagIndex}]`, index)
      if (!TAG_RE.test(tag)) {
        throw new Error(`dsh-subagent-model-router: models[${index}].tags[${tagIndex}] must be lowercase kebab-case`)
      }
      if (seenTags.has(tag)) continue
      seenTags.add(tag)
      tags.push(tag)
    }

    const maxTokens = entry.maxTokens
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
      throw new Error(`dsh-subagent-model-router: models[${index}].maxTokens must be a positive safe integer`)
    }

    return {
      alias,
      provider,
      model,
      displayName,
      tags,
      description,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }
  })
}

/** Render configured choices as concise model-facing routing guidance. */
function renderConfiguredModels(models) {
  return models.map((entry) => {
    const tags = entry.tags.length === 0 ? '' : ` [tags: ${entry.tags.join(', ')}]`
    return `- ${entry.alias}: ${entry.displayName} (${entry.provider}/${entry.model})${tags} — ${entry.description}`
  }).join('\n')
}

/** Render the read-only live LLM catalog result for a tool response. */
function renderCatalogResult(value) {
  const lines = []
  if (value.current !== undefined) {
    lines.push(`Current agent route: ${value.current.provider}/${value.current.model}`)
  }
  for (const provider of value.providers) {
    lines.push(`Provider ${provider.name} (${provider.id})`)
    if (provider.error !== undefined) {
      lines.push(`  Catalog unavailable: ${provider.error}`)
      continue
    }
    if (provider.models.length === 0) {
      lines.push('  No models advertised (the route may still accept manually configured model ids).')
      continue
    }
    for (const model of provider.models) {
      const description = model.description === undefined ? '' : ` — ${model.description}`
      lines.push(`  - ${model.name} (${model.id})${description}`)
    }
  }
  return lines.length === 0 ? 'No registered model providers were found.' : lines.join('\n')
}

export {
  normalizeConfiguredModels,
  renderCatalogResult,
  renderConfiguredModels,
}
