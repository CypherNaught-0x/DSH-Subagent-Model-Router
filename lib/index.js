import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  normalizeConfiguredModels,
  renderCatalogResult,
  renderConfiguredModels,
} from './model-catalog.js'

const name = 'dsh-subagent-dynamic-model'
const inject = ['tools', 'subagents', 'systemPrompt', 'skills', 'llm']
const CATALOG_TOOL_NAME = 'model_subagent_catalog'
const SKILL_URL = new URL('../skills/model-subagent-setup/SKILL.md', import.meta.url)
const SKILL_DIRECTORY_URL = new URL('../skills/model-subagent-setup/', import.meta.url)
const MODEL_SUBAGENT_SECTION_ORDER = 116.25

const ModelConfig = z.object({
  alias: z.string().required(),
  provider: z.string().required(),
  model: z.string().required(),
  displayName: z.string(),
  tags: z.array(z.string()).default([]),
  description: z.string().required(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
})

const Config = z.object({
  models: z.array(ModelConfig).default([]),
  subagentProvider: z.string().default('spawn'),
  toolName: z.string().default('subagent_model'),
  maxDepth: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(3),
  enableRunInBackground: z.boolean().default(true),
})

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function assertToolName(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`dsh-subagent-dynamic-model: ${field} must be a valid tool name`)
  }
}

function outputValueText(values) {
  return values
    .filter((value) => typeof value === 'object' && value !== null && !Array.isArray(value) && value.type === 'text' && typeof value.text === 'string')
    .map((value) => value.text)
    .join('')
}

function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'subagent run was cancelled'
    case 'error': return 'subagent run failed'
    case 'max-tokens': return 'subagent run hit its token limit before finishing'
    case 'refusal': return 'subagent declined the task'
    default: return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

function withPartialText(error, output) {
  const text = output
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

async function settleForegroundRun(run, alias) {
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      const failure = stopReasonError(result)
      if (failure !== undefined) throw new Error(withPartialText(failure, result.output))
      return {
        kind: 'foreground',
        runId: run.id,
        model: alias,
        output: result.output,
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([
    Promise.resolve().then(() => run.dispose()),
  ])

  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

function providerWording(inheritsConversation) {
  if (inheritsConversation) {
    return {
      description: 'Delegate work to a model-selectable subagent that inherits this conversation\'s completed turns (not the current in-flight turn).',
      promptDescription: 'The task for the subagent. It already sees this conversation\'s completed turns, so state only what is new.',
    }
  }
  return {
    description: 'Delegate a self-contained task to a fresh model-selectable subagent with its own context.',
    promptDescription: 'The complete, self-contained task for the subagent. It does not share this conversation, so include everything it needs.',
  }
}

async function collectModelCatalog(ctx, exec) {
  const providerEntries = ctx.llm.listProviders()
  const providers = await Promise.all(providerEntries.map(async (provider) => {
    try {
      const models = await ctx.llm.listModels(provider.id)
      return {
        id: provider.id,
        name: provider.name,
        models: models.map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] }),
        })),
      }
    } catch (error) {
      return {
        id: provider.id,
        name: provider.name,
        models: [],
        error: errorMessage(error),
      }
    }
  }))

  const currentProvider = exec.agent?.options?.provider
  const currentModel = exec.agent?.options?.model
  return {
    ...(typeof currentProvider === 'string' && typeof currentModel === 'string'
      ? { current: { provider: currentProvider, model: currentModel } }
      : {}),
    providers,
  }
}

function registerCatalogTool(ctx) {
  ctx.tools.register(defineTool({
    name: CATALOG_TOOL_NAME,
    description: 'List the model routes currently advertised by registered DSH providers. Use this read-only catalog while configuring model-selectable subagents; catalog absence is advisory and does not prove a manually configured route is invalid.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          current: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string', required: true },
              model: { type: 'string', required: true },
            },
          },
          providers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                error: { type: 'string' },
                models: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      name: { type: 'string', required: true },
                      description: { type: 'string' },
                      inputModalities: {
                        type: 'array',
                        items: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderCatalogResult(value) }],
    },
    isConcurrencySafe: () => true,
    execute(_args, exec) {
      return collectModelCatalog(ctx, exec)
    },
  }))
}

function createDelegationTool(ctx, config, provider, models) {
  const wording = providerWording(provider.inheritsParentContext)
  const catalog = renderConfiguredModels(models)
  const byAlias = new Map(models.map((model) => [model.alias, model]))
  const backgroundEnabled = config.enableRunInBackground !== false
  const toolName = config.toolName ?? 'subagent_model'

  return defineTool({
    name: toolName,
    description: `${wording.description} Select only from the configured routes below, using their tags and usage descriptions to choose.\n${catalog}${backgroundEnabled ? '\nRuns in the background by default; set run_in_background to false only when the next action depends on the result.' : ''}`,
    parameters: {
      model: {
        type: 'string',
        enum: models.map((model) => model.alias),
        required: true,
        description: `Configured model alias. Choose from:\n${catalog}`,
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: wording.promptDescription,
      },
      ...(backgroundEnabled ? {
        run_in_background: {
          type: 'boolean',
          description: 'Whether to return a durable subagent id immediately. Defaults to true. Set false to wait for the result.',
        },
      } : {}),
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'continuable' },
              subagentId: { type: 'string', required: true },
              model: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              runId: { type: 'string', required: true },
              model: { type: 'string', required: true },
              output: {
                type: 'array',
                required: true,
                items: { type: 'json' },
              },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'continuable'
          ? `started ${value.model} subagent ${value.subagentId}`
          : outputValueText(value.output),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error(`${toolName} requires a calling agent`)
      }
      const selected = byAlias.get(args.model)
      if (selected === undefined) {
        throw new Error(`unknown configured model alias "${String(args.model)}"`)
      }
      const request = {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        signal: exec.signal,
        maxDepth: config.maxDepth ?? 3,
        agentOptions: {
          provider: selected.provider,
          model: selected.model,
          ...(selected.maxTokens === undefined ? {} : { maxTokens: selected.maxTokens }),
        },
      }

      if (backgroundEnabled && args.run_in_background !== false) {
        const started = await ctx.subagents.startContinuable({
          provider: config.subagentProvider ?? 'spawn',
          label: args.description,
          request,
          signal: exec.signal,
        })
        return {
          kind: 'continuable',
          subagentId: started.childId,
          model: selected.alias,
        }
      }

      const run = await ctx.subagents.start(config.subagentProvider ?? 'spawn', request)
      return settleForegroundRun(run, selected.alias)
    },
  })
}

async function registerSetupSkill(ctx) {
  const content = await readFile(SKILL_URL, 'utf8')
  ctx.skills.register({
    name: 'model-subagent-setup',
    description: 'Configure which existing DSH model routes an AI agent may use for model-selectable subagents, and generate concise tags and routing descriptions for each choice.',
    whenToUse: 'Use when the user asks to set up, add, remove, review, or improve alternative models for subagents created by dsh-subagent-dynamic-model.',
    invocation: {
      modelInvocable: true,
      userInvocable: true,
    },
    source: 'bundled',
    resourceBase: {
      kind: 'directory',
      path: fileURLToPath(SKILL_DIRECTORY_URL),
    },
    content,
  })
}

async function apply(ctx, config = {}) {
  const models = normalizeConfiguredModels(config.models ?? [])
  const toolName = config.toolName ?? 'subagent_model'
  const subagentProvider = config.subagentProvider ?? 'spawn'
  const maxDepth = config.maxDepth ?? 3
  assertToolName(toolName, 'toolName')
  if (toolName === CATALOG_TOOL_NAME) {
    throw new Error(`dsh-subagent-dynamic-model: toolName must differ from ${CATALOG_TOOL_NAME}`)
  }
  if (typeof subagentProvider !== 'string' || subagentProvider.trim().length === 0) {
    throw new Error('dsh-subagent-dynamic-model: subagentProvider must be a non-empty string')
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error('dsh-subagent-dynamic-model: maxDepth must be a non-negative safe integer')
  }

  await registerSetupSkill(ctx)
  registerCatalogTool(ctx)
  if (models.length === 0) {
    ctx.logger.info('no model-selectable subagent routes configured; load the model-subagent-setup skill to choose routes')
    return
  }

  let disposeTool
  const mount = (provider) => {
    if (!provider.capabilities.depthLimit) {
      throw new Error(`dsh-subagent-dynamic-model: subagent provider "${provider.name}" cannot enforce maxDepth`)
    }
    if (config.enableRunInBackground !== false && provider.prepareContinuable === undefined) {
      throw new Error(`dsh-subagent-dynamic-model: subagent provider "${provider.name}" does not support continuable background runs`)
    }
    disposeTool = ctx.tools.register(createDelegationTool(ctx, config, provider, models))
  }

  ctx.on('subagent/provider-added', (provider) => {
    if (provider.name === subagentProvider && disposeTool === undefined) mount(provider)
  })
  ctx.on('subagent/provider-removed', (providerName) => {
    if (providerName !== subagentProvider || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })

  const present = ctx.subagents.getProvider(subagentProvider)
  if (present !== undefined) mount(present)
  else ctx.logger.info(`subagent provider "${subagentProvider}" is not registered yet; ${toolName} will register when it appears`)

  ctx.systemPrompt.section({
    name: `tool:${toolName}:models`,
    order: MODEL_SUBAGENT_SECTION_ORDER,
    text: (context) => disposeTool === undefined || ctx.tools.get(toolName, context.scope) === undefined
      ? ''
      : `For model-selectable delegation, use \`${toolName}\` and choose only from these configured routes. Treat each description as the owner's routing policy rather than guessing from the raw model name.\n${renderConfiguredModels(models)}`,
  })
}

export {
  CATALOG_TOOL_NAME,
  Config,
  apply,
  inject,
  name,
}
