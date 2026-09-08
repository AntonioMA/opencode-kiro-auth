import { describe, expect, test } from 'bun:test'
import { MODEL_CONTEXT_WINDOWS, SUPPORTED_MODELS } from '../constants.js'
import { getContextWindowSize, resolveKiroModel } from '../plugin/models.js'

describe('resolveKiroModel', () => {
  test('resolves newly advertised model slugs', () => {
    expect(resolveKiroModel('auto')).toBe('auto')
    expect(resolveKiroModel('deepseek-3.2')).toBe('deepseek-3.2')
    expect(resolveKiroModel('minimax-m2.5')).toBe('minimax-m2.5')
    expect(resolveKiroModel('minimax-m2.1')).toBe('minimax-m2.1')
    expect(resolveKiroModel('qwen3-coder-next')).toBe('qwen3-coder-next')
    expect(resolveKiroModel('gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(resolveKiroModel('gpt-5.6-terra')).toBe('gpt-5.6-terra')
    expect(resolveKiroModel('gpt-5.6-luna')).toBe('gpt-5.6-luna')
  })

  test('keeps existing supported Claude slugs intact', () => {
    expect(resolveKiroModel('claude-sonnet-4-5')).toBe('claude-sonnet-4.5')
    expect(resolveKiroModel('claude-sonnet-4')).toBe('claude-sonnet-4')
    expect(resolveKiroModel('claude-opus-4-8')).toBe('claude-opus-4.8')
    expect(resolveKiroModel('claude-opus-4-8-thinking')).toBe('claude-opus-4.8')
  })

  test('resolves claude-sonnet-5 slugs', () => {
    expect(resolveKiroModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(resolveKiroModel('claude-sonnet-5-thinking')).toBe('claude-sonnet-5')
    expect(resolveKiroModel('claude-sonnet-5-1m')).toBe('claude-sonnet-5-1m')
    expect(resolveKiroModel('claude-sonnet-5-1m-thinking')).toBe('claude-sonnet-5-1m')
  })

  test('rejects removed qwen3-coder-480b slug', () => {
    expect(() => resolveKiroModel('qwen3-coder-480b')).toThrow(
      'Unsupported model: qwen3-coder-480b'
    )
  })

  test('supported model list excludes removed qwen3-coder-480b slug', () => {
    expect(SUPPORTED_MODELS).not.toContain('qwen3-coder-480b')
  })

  test('uses Kiro context windows for native model IDs', () => {
    expect(getContextWindowSize('auto')).toBe(1000000)
    expect(getContextWindowSize('claude-opus-4.6')).toBe(1000000)
    expect(getContextWindowSize('gpt-5.6-sol')).toBe(272000)
    expect(getContextWindowSize('deepseek-3.2')).toBe(164000)
    expect(getContextWindowSize('qwen3-coder-next')).toBe(256000)
    expect(MODEL_CONTEXT_WINDOWS['minimax-m2.5']).toBe(196000)
  })

  test('rejects unknown slugs', () => {
    expect(() => resolveKiroModel('this-model-does-not-exist')).toThrow(
      'Unsupported model: this-model-does-not-exist'
    )
  })
})
