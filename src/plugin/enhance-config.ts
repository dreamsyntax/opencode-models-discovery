import { ToastNotifier } from '../ui/toast-notifier'
import { categorizeModel, formatModelName, extractModelOwner } from '../utils'
import { normalizeBaseURL, discoverModelsFromProvider, discoverModelInfoFromProvider, autoDetectOpenAICompatibleProvider, canDiscoverModels } from '../utils/openai-compatible-api'
import { getProviderFilter, getDiscoveryConfig, getModelRegexFilter, getProviderModelRegexFilter, shouldDiscoverModel, shouldDiscoverProviderWithOverride } from '../types/plugin-config'
import type { PluginLogger } from './logger'
import type { PluginInput } from '@opencode-ai/plugin'
import type { LiteLLMModelInfo, LiteLLMModelInfoEntry, OpenAIModel } from '../types'
import type { PluginConfig } from '../types/plugin-config'

interface DiscoveredProvider {
  name: string
  baseURL: string
  models: Record<string, any>
}

const DEFAULT_MODEL_INFO_ENDPOINT = '/v1/model/info'

function hasUsableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function modelInfoScore(modelId: string, entry: LiteLLMModelInfoEntry): number {
  const info = entry.model_info ?? {}
  const modelIdLower = modelId.toLowerCase()
  let score = 0
  if (entry.model_name === modelId) score += 8
  if (info.key === modelId) score += 6
  if (entry.litellm_params?.model === modelId) score += 4
  if (entry.litellm_params?.model?.endsWith(`/${modelId}`)) score += 2
  if (entry.model_name?.toLowerCase() === modelIdLower) score += 3
  if (info.key?.toLowerCase() === modelIdLower) score += 2
  if (entry.litellm_params?.model?.toLowerCase() === modelIdLower) score += 2
  if (entry.litellm_params?.model?.toLowerCase().endsWith(`/${modelIdLower}`)) score += 1
  if (info.mode === 'chat') score += 5
  if (hasUsableNumber(info.max_input_tokens) || hasUsableNumber(info.max_tokens)) score += 10
  if (info.supports_reasoning === true) score += 4
  return score
}

function buildModelInfoMap(entries: LiteLLMModelInfoEntry[]): Map<string, LiteLLMModelInfoEntry> {
  const result = new Map<string, LiteLLMModelInfoEntry>()

  for (const entry of entries) {
    const keys = new Set<string>()
    if (entry.model_name) keys.add(entry.model_name)
    if (entry.model_info?.key) keys.add(entry.model_info.key)
    if (entry.litellm_params?.model) {
      keys.add(entry.litellm_params.model)
      const parts = entry.litellm_params.model.split('/')
      if (parts.length > 1) keys.add(parts.slice(1).join('/'))
      keys.add(parts[parts.length - 1])
    }

    for (const key of keys) {
      for (const lookupKey of new Set([key, key.toLowerCase()])) {
        const existing = result.get(lookupKey)
        if (!existing || modelInfoScore(lookupKey, entry) > modelInfoScore(lookupKey, existing)) {
          result.set(lookupKey, entry)
        }
      }
    }
  }

  return result
}

function createReasoningVariants(info: LiteLLMModelInfo): Record<string, any> | undefined {
  if (info.supports_reasoning !== true || !info.supported_openai_params?.includes('reasoning_effort')) {
    return undefined
  }

  const variants: Record<string, any> = {}
  if (info.supports_none_reasoning_effort === true) variants.none = { reasoningEffort: 'none' }
  if (info.supports_minimal_reasoning_effort === true) variants.minimal = { reasoningEffort: 'minimal' }

  // LiteLLM does not always expose per-tier flags for widely supported efforts.
  if (info.supports_low_reasoning_effort !== false) variants.low = { reasoningEffort: 'low' }
  variants.medium = { reasoningEffort: 'medium' }
  variants.high = { reasoningEffort: 'high' }

  if (info.supports_xhigh_reasoning_effort === true) variants.xhigh = { reasoningEffort: 'xhigh' }
  if (info.supports_max_reasoning_effort === true) variants.max = { reasoningEffort: 'max' }

  return Object.keys(variants).length > 0 ? variants : undefined
}

function applyModelInfo(modelConfig: any, entry: LiteLLMModelInfoEntry | undefined): void {
  const info = entry?.model_info
  if (!info) return

  const contextLimit = hasUsableNumber(info.max_input_tokens) ? info.max_input_tokens : info.max_tokens
  const outputLimit = hasUsableNumber(info.max_output_tokens) ? info.max_output_tokens : info.max_tokens
  if (hasUsableNumber(contextLimit) && hasUsableNumber(outputLimit)) {
    modelConfig.limit = {
      context: contextLimit,
      input: hasUsableNumber(info.max_input_tokens) ? info.max_input_tokens : undefined,
      output: outputLimit,
    }
  }

  if (info.supports_reasoning === true) {
    modelConfig.reasoning = true
  }

  const variants = createReasoningVariants(info)
  if (variants) {
    modelConfig.variants = variants
  }
}

function shouldSkipForModelInfo(entry: LiteLLMModelInfoEntry | undefined, filterNonChat: boolean): boolean {
  if (!filterNonChat) return false
  const mode = entry?.model_info?.mode
  return typeof mode === 'string' && mode.length > 0 && mode !== 'chat'
}

export async function enhanceConfig(
  config: any,
  client: PluginInput['client'],
  toastNotifier: ToastNotifier,
  pluginConfig: PluginConfig,
  logger: PluginLogger
): Promise<void> {
  try {
    const providers = config.provider || {}
    const openAICompatibleProviders: DiscoveredProvider[] = []
    const providerFilter = getProviderFilter(pluginConfig)
    const modelRegexFilter = getModelRegexFilter(pluginConfig, logger.child({ category: 'filtering' }))
    const discoveryConfig = getDiscoveryConfig(pluginConfig)
    const globalDiscoveryEnabled = discoveryConfig.enabled

    for (const [providerName, providerConfig] of Object.entries(providers)) {
      const p = providerConfig as any
      const providerDiscoveryConfig = p.options?.modelsDiscovery ?? {}
      const modelsEndpoint = providerDiscoveryConfig.endpoint ?? '/v1/models'
      const modelInfoEndpoint = providerDiscoveryConfig.modelInfoEndpoint ?? DEFAULT_MODEL_INFO_ENDPOINT
      const filterNonChat = providerDiscoveryConfig.filterNonChat !== false
      const forceDiscoveryEnabled = providerDiscoveryConfig.enabled === true

      if (!forceDiscoveryEnabled && !canDiscoverModels(p)) {
        continue
      }

      if (!shouldDiscoverProviderWithOverride(providerName, providerFilter, globalDiscoveryEnabled, providerDiscoveryConfig)) {
        logger.debug(`Provider ${providerName} model discovery disabled by configuration`)
        continue
      }

      let baseURL: string
      let displayName = providerName

      if (p.options?.baseURL) {
        baseURL = normalizeBaseURL(p.options.baseURL)
      } else {
        continue
      }

      const apiKey = p.options?.apiKey

      let models: OpenAIModel[]
      const discovery = await discoverModelsFromProvider(baseURL, apiKey, modelsEndpoint)
      if (!discovery.ok) {
        logger.warn('Provider model discovery failed', {
          provider: providerName,
          baseURL,
          endpoint: modelsEndpoint,
        })
        continue
      }

      models = discovery.models

      if (models.length === 0) {
        continue
      }

      let modelInfoById = new Map<string, LiteLLMModelInfoEntry>()
      if (typeof modelInfoEndpoint === 'string' && modelInfoEndpoint.length > 0) {
        const modelInfoDiscovery = await discoverModelInfoFromProvider(baseURL, apiKey, modelInfoEndpoint)
        if (modelInfoDiscovery.ok) {
          modelInfoById = buildModelInfoMap(modelInfoDiscovery.entries)
        } else if (providerDiscoveryConfig.modelInfoEndpoint) {
          logger.warn('Provider model info discovery failed', {
            provider: providerName,
            baseURL,
            endpoint: modelInfoEndpoint,
          })
        }
      }

      const existingModels = p.models || {}
      const discoveredModels: Record<string, any> = {}
      let chatModelsCount = 0

      const hasProviderModelRegexFilter = !!providerDiscoveryConfig.models?.includeRegex?.length || !!providerDiscoveryConfig.models?.excludeRegex?.length
      const providerModelRegexFilter = getProviderModelRegexFilter(providerDiscoveryConfig, logger.child({ category: 'filtering' }))
      let smartModelNameEnabled = providerDiscoveryConfig.smartModelName
      if (smartModelNameEnabled === undefined) {
        smartModelNameEnabled = pluginConfig.smartModelName
      }

      for (const model of models) {
        const modelKey = model.id
        if (!existingModels[modelKey]) {
          const activeModelRegexFilter = hasProviderModelRegexFilter ? providerModelRegexFilter : modelRegexFilter
          if (!shouldDiscoverModel(model.id, activeModelRegexFilter)) {
            continue
          }

          const modelInfo = modelInfoById.get(model.id) ?? modelInfoById.get(model.id.toLowerCase())
          if (shouldSkipForModelInfo(modelInfo, filterNonChat)) {
            continue
          }

          const modelType = categorizeModel(model.id)
          if (modelType === 'embedding') {
            continue
          }

          const owner = extractModelOwner(model.id)
          const modelConfig: any = {
            id: model.id,
            name: smartModelNameEnabled ? formatModelName(model) : model.id,
          }

          if (owner) {
            modelConfig.organizationOwner = owner
          }

          if (modelType === 'chat') {
            chatModelsCount++
            modelConfig.modalities = {
              input: ["text", "image"],
              output: ["text"]
            }
          }

          applyModelInfo(modelConfig, modelInfo)

          discoveredModels[modelKey] = modelConfig
        }
      }

      if (Object.keys(discoveredModels).length > 0) {
        p.models = {
          ...existingModels,
          ...discoveredModels,
        }

        openAICompatibleProviders.push({
          name: displayName,
          baseURL,
          models: discoveredModels
        })
      }
    }

    if (openAICompatibleProviders.length > 0) {
      const totalModels = openAICompatibleProviders.reduce((sum, p) => sum + Object.keys(p.models).length, 0)
      logger.info('Provider model discovery completed', {
        providerCount: openAICompatibleProviders.length,
        modelCount: totalModels,
      })
    }

    if (Object.keys(providers).length === 0) {
      const detected = await autoDetectOpenAICompatibleProvider()
      if (detected) {
        logger.info('Detected OpenAI-compatible provider but found no configured providers', {
          provider: detected.name,
          baseURL: detected.baseURL,
        })
      }
    }

  } catch (error) {
    logger.error('Unexpected error in enhanceConfig', {
      error: error instanceof Error ? error.message : String(error),
    })
    toastNotifier.warning("Plugin configuration failed", "Configuration Error").catch(() => { })
  }
}
