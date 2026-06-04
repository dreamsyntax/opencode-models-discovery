export interface ModelCapabilities {
  reasoning?: boolean
  vision?: boolean
  tool_call?: boolean
}

export interface ModelPricing {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  unit?: string
  currency?: string
}

export interface OpenAIModel {
  id: string
  object: string
  created: number
  owned_by: string
  name?: string
  type?: string
  capabilities?: ModelCapabilities
  context_length?: number
  max_output_tokens?: number
  pricing?: ModelPricing
}

export interface OpenAIModelsResponse {
  object: string
  data: OpenAIModel[]
}

export interface LiteLLMModelInfo {
  key?: string | null
  mode?: string | null
  max_tokens?: number | null
  max_input_tokens?: number | null
  max_output_tokens?: number | null
  supports_reasoning?: boolean | null
  supports_none_reasoning_effort?: boolean | null
  supports_minimal_reasoning_effort?: boolean | null
  supports_low_reasoning_effort?: boolean | null
  supports_xhigh_reasoning_effort?: boolean | null
  supports_max_reasoning_effort?: boolean | null
  supported_openai_params?: string[] | null
}

export interface LiteLLMModelInfoEntry {
  model_name: string
  litellm_params?: {
    model?: string
  }
  model_info?: LiteLLMModelInfo
}

export interface LiteLLMModelInfoResponse {
  data: LiteLLMModelInfoEntry[]
}

export type ModelType = 'chat' | 'embedding' | 'unknown'

export type LoadingStatus = 'not_loaded' | 'loading' | 'loaded' | 'error'

export interface ModelLoadingState {
  status: LoadingStatus
  startTime?: number
  progress?: number
  eta?: number
  error?: string
}

export type LMStudioModel = OpenAIModel
export type LMStudioModelsResponse = OpenAIModelsResponse
