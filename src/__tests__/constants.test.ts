import { describe, expect, test } from 'bun:test'
import {
  isLongContextModel,
  MODEL_CONTEXT_WINDOWS,
  normalizeRegion,
  SUPPORTED_MODELS
} from '../constants.js'

describe('isLongContextModel', () => {
  test('returns true for models above the standard context window', () => {
    const expectedLongContext = Object.entries(MODEL_CONTEXT_WINDOWS)
      .filter(([, context]) => context > 200000)
      .map(([model]) => model)
    expect(expectedLongContext.length).toBeGreaterThan(0)
    for (const model of expectedLongContext) {
      expect(isLongContextModel(model)).toBe(true)
    }
  })

  test('returns false for models at or below the standard context window', () => {
    const standard = SUPPORTED_MODELS.filter(
      (model) => (MODEL_CONTEXT_WINDOWS[model] ?? 200000) <= 200000
    )
    expect(standard.length).toBeGreaterThan(0)
    for (const model of standard) {
      expect(isLongContextModel(model)).toBe(false)
    }
  })

  test('returns false for unknown model strings', () => {
    expect(isLongContextModel('unknown-model')).toBe(false)
    expect(isLongContextModel('')).toBe(false)
    expect(isLongContextModel('claude-sonnet-4-6')).toBe(true)
  })
})

describe('normalizeRegion', () => {
  test('accepts configured AWS regions with the installed Zod enum shape', () => {
    expect(normalizeRegion('us-west-2')).toBe('us-west-2')
  })
})
