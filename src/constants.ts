import { RegionSchema } from './plugin/config/schema'
import type { KiroRegion } from './plugin/types'

const VALID_REGIONS: readonly KiroRegion[] = RegionSchema.options

export function isValidRegion(region: string): region is KiroRegion {
  return VALID_REGIONS.includes(region as KiroRegion)
}

export function normalizeRegion(region: string | undefined): KiroRegion {
  if (!region || !isValidRegion(region)) {
    return 'us-east-1'
  }
  return region
}

export function buildUrl(template: string, region: KiroRegion): string {
  const url = template.replace('{{region}}', region)

  try {
    new URL(url)
    return url
  } catch {
    throw new Error(`Invalid URL generated: ${url}`)
  }
}

export function extractRegionFromArn(arn: string | undefined): KiroRegion | undefined {
  if (!arn) return undefined
  const parts = arn.split(':')
  if (parts.length < 6) return undefined
  if (parts[0] !== 'arn') return undefined
  const region = parts[3]
  if (typeof region !== 'string' || !region) return undefined
  return isValidRegion(region) ? (region as KiroRegion) : undefined
}

export const KIRO_CONSTANTS = {
  REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
  REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
  BASE_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
  USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',
  DEFAULT_REGION: 'us-east-1' as KiroRegion,
  AXIOS_TIMEOUT: 120000,
  USER_AGENT: 'KiroIDE',
  SDK_VERSION: '3.738.0',
  SDK_VERSION_USAGE: '3.0.0',
  CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
  ORIGIN_AI_EDITOR: 'AI_EDITOR'
}

export const MODEL_MAPPING: Record<string, string> = {
  // Claude Haiku
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-haiku-4-5-thinking': 'claude-haiku-4.5',
  // Claude Sonnet
  'claude-sonnet-4': 'claude-sonnet-4',
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'claude-sonnet-4-5-thinking': 'claude-sonnet-4.5',
  'claude-sonnet-4-5-1m': 'claude-sonnet-4.5-1m',
  'claude-sonnet-4-5-1m-thinking': 'claude-sonnet-4.5-1m',
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4.6',
  'claude-sonnet-4-6-1m': 'claude-sonnet-4.6-1m',
  'claude-sonnet-4-6-1m-thinking': 'claude-sonnet-4.6-1m',
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-sonnet-5-thinking': 'claude-sonnet-5',
  'claude-sonnet-5-1m': 'claude-sonnet-5-1m',
  'claude-sonnet-5-1m-thinking': 'claude-sonnet-5-1m',
  // Claude Opus
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-opus-4-5-thinking': 'claude-opus-4.5',
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-opus-4-6-thinking': 'claude-opus-4.6',
  'claude-opus-4-6-1m': 'claude-opus-4.6-1m',
  'claude-opus-4-6-1m-thinking': 'claude-opus-4.6-1m',
  'claude-opus-4-7': 'claude-opus-4.7',
  'claude-opus-4-7-thinking': 'claude-opus-4.7',
  'claude-opus-4-8': 'claude-opus-4.8',
  'claude-opus-4-8-thinking': 'claude-opus-4.8',
  'claude-opus-5': 'claude-opus-5',
  'claude-opus-5-thinking': 'claude-opus-5',
  // Auto
  auto: 'auto',
  // Open weight models
  'deepseek-3.2': 'deepseek-3.2',
  'glm-5': 'glm-5',
  'minimax-m2.5': 'minimax-m2.5',
  'minimax-m2.1': 'minimax-m2.1',
  'qwen3-coder-next': 'qwen3-coder-next',
  // OpenAI GPT-5.6
  'gpt-5.6-sol': 'gpt-5.6-sol',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-luna': 'gpt-5.6-luna',
  // Legacy / internal mappings kept for backwards compatibility
  'claude-3-7-sonnet': 'CLAUDE_3_7_SONNET_20250219_V1_0',
  'nova-swe': 'AGI_NOVA_SWE_V1_5',
  'gpt-oss-120b': 'OPENAI_GPT_OSS_120B_1_0',
  'minimax-m2': 'MINIMAX_MINIMAX_M2',
  'kimi-k2-thinking': 'MOONSHOT_KIMI_K2_THINKING'
}

export const SUPPORTED_MODELS = Object.keys(MODEL_MAPPING)

/**
 * Context windows reported by Kiro's ListAvailableModels API.
 *
 * Models not listed here use Kiro's standard 200k context window. OpenCode
 * aliases are included alongside native Kiro IDs because responses report the
 * model selected by the caller rather than the resolved API model.
 */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  auto: 1000000,
  'claude-opus-4.6': 1000000,
  'claude-opus-4-6': 1000000,
  'claude-opus-4-6-thinking': 1000000,
  'claude-opus-4-6-1m': 1000000,
  'claude-opus-4-6-1m-thinking': 1000000,
  'claude-opus-4.7': 1000000,
  'claude-opus-4-7': 1000000,
  'claude-opus-4-7-thinking': 1000000,
  'claude-opus-4.8': 1000000,
  'claude-opus-4-8': 1000000,
  'claude-opus-4-8-thinking': 1000000,
  'claude-opus-5': 1000000,
  'claude-opus-5-thinking': 1000000,
  'claude-sonnet-4.6': 1000000,
  'claude-sonnet-4-6': 1000000,
  'claude-sonnet-4-6-thinking': 1000000,
  'claude-sonnet-4-6-1m': 1000000,
  'claude-sonnet-4-6-1m-thinking': 1000000,
  'claude-sonnet-5': 1000000,
  'claude-sonnet-5-thinking': 1000000,
  'claude-sonnet-5-1m': 1000000,
  'claude-sonnet-5-1m-thinking': 1000000,
  'gpt-5.6-sol': 272000,
  'gpt-5.6-terra': 272000,
  'gpt-5.6-luna': 272000,
  'deepseek-3.2': 164000,
  'qwen3-coder-next': 256000,
  'minimax-m2.5': 196000,
  'minimax-m2.1': 196000
}

export function isLongContextModel(model: string): boolean {
  return (MODEL_CONTEXT_WINDOWS[model] ?? 200000) > 200000
}

export const KIRO_AUTH_SERVICE = {
  ENDPOINT: 'https://prod.{{region}}.auth.desktop.kiro.dev',
  SSO_OIDC_ENDPOINT: 'https://oidc.{{region}}.amazonaws.com',
  BUILDER_ID_START_URL: 'https://view.awsapps.com/start',
  USER_INFO_URL: 'https://view.awsapps.com/api/user/info',
  SCOPES: [
    'codewhisperer:completions',
    'codewhisperer:analysis',
    'codewhisperer:conversations',
    'codewhisperer:transformations',
    'codewhisperer:taskassist'
  ]
}
