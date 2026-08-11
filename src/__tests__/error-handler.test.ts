import { describe, expect, test } from 'bun:test'
import { ErrorHandler } from '../core/request/error-handler.js'

function makeAccount(overrides: any = {}) {
  return {
    id: 'account-1',
    email: 'user@example.com',
    failCount: 0,
    ...overrides
  }
}

function makeAccountManager() {
  return {
    markUnhealthy: () => {},
    markRateLimited: () => {},
    getAccountCount: () => 1
  }
}

const repo: any = { batchSave: async () => {} }
const config = { rate_limit_max_retries: 2, rate_limit_retry_delay_ms: 1 }

describe('ErrorHandler 401 handling', () => {
  test('401 requests a forced refresh instead of blindly retrying the same token', async () => {
    const handler = new ErrorHandler(config, makeAccountManager() as any, repo)
    const account = makeAccount()
    const response = new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })

    const result = await handler.handle(
      new Error('401'),
      response,
      account as any,
      { retry: 0 },
      () => {}
    )

    expect(result.shouldRetry).toBe(true)
    expect(result.forceRefresh).toBe(true)
    expect(result.newContext?.retry).toBe(1)
  })

  test('401 stops retrying once max retries are exhausted', async () => {
    const handler = new ErrorHandler(config, makeAccountManager() as any, repo)
    const account = makeAccount()
    const response = new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })

    const result = await handler.handle(
      new Error('401'),
      response,
      account as any,
      { retry: 2 },
      () => {}
    )

    expect(result.shouldRetry).toBe(false)
  })
})
