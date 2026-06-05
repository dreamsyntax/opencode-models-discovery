import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ToastNotifier } from '../ui/toast-notifier'
import { validateConfig } from '../utils/validation'
import { enhanceConfig } from './enhance-config'
import { generateOutputConfig } from '../utils/generate-output-config'
import type { PluginLogger } from './logger'
import type { PluginInput } from '@opencode-ai/plugin'
import type { PluginConfig } from '../types/plugin-config'

export function createConfigHook(
  client: PluginInput['client'],
  toastNotifier: ToastNotifier,
  pluginConfig: PluginConfig,
  logger: PluginLogger,
  directory: string
) {
  return async (config: any) => {
    if (config && (Object.isFrozen?.(config) || Object.isSealed?.(config))) {
      logger.warn('Config object is frozen or sealed; cannot modify directly')
      return
    }

    const validation = validateConfig(config)
    if (!validation.isValid) {
      logger.error('Invalid config provided', { errors: validation.errors })
      toastNotifier.error("Plugin configuration is invalid", "Configuration Error").catch(() => { })
      return
    }

    if (validation.warnings.length > 0) {
      logger.warn('Config warnings', { warnings: validation.warnings })
    }


    const discoveryPromise = enhanceConfig(
      config,
      client,
      toastNotifier,
      pluginConfig,
      logger.child({ category: 'discovery' })
    )
    const timeoutMs = 5000

    try {
      const discoveredProviders = await Promise.race([
        discoveryPromise,
        new Promise<never>((resolve) => {
          setTimeout(() => resolve(undefined as never), timeoutMs)
        })
      ])

      if (discoveredProviders && discoveredProviders.length > 0) {
        try {
          const outputConfig = generateOutputConfig(discoveredProviders, config)
          const outputPath = join(directory, 'opencode-desktop.json')
          await writeFile(outputPath, JSON.stringify(outputConfig, null, 2), 'utf-8')
          logger.info('Generated opencode-desktop.json', {
            providerCount: discoveredProviders.length,
            modelCount: discoveredProviders.reduce((sum, p) => sum + Object.keys(p.models).length, 0),
          })
        } catch (writeError) {
          logger.warn('Failed to write opencode-desktop.json', {
            error: writeError instanceof Error ? writeError.message : String(writeError),
          })
        }
      }
    } catch (error) {
      logger.error('Config enhancement failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
