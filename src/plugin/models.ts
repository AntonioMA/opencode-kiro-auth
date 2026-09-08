import { MODEL_CONTEXT_WINDOWS, MODEL_MAPPING, SUPPORTED_MODELS } from '../constants'

export function resolveKiroModel(model: string): string {
  const resolved = MODEL_MAPPING[model]
  if (!resolved) {
    throw new Error(`Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`)
  }
  return resolved
}

export function getContextWindowSize(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? 200000
}
