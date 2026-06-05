interface DiscoveredProvider {
  name: string
  baseURL: string
  models: Record<string, any>
}

export function generateOutputConfig(
  discoveredProviders: DiscoveredProvider[],
  originalConfig: any
): Record<string, any> {
  const output: Record<string, any> = { provider: {} }

  for (const discovered of discoveredProviders) {
    const originalProvider = originalConfig.provider?.[discovered.name]
    if (!originalProvider) continue

    const options: Record<string, any> = {}
    if (originalProvider.options) {
      for (const [key, value] of Object.entries(originalProvider.options)) {
        if (key === 'modelsDiscovery') continue
        if (key === 'apiKey') continue
        options[key] = value
      }
    }

    output.provider[discovered.name] = {
      npm: originalProvider.npm,
      name: originalProvider.name,
      options,
      models: discovered.models,
    }
  }

  return output
}
