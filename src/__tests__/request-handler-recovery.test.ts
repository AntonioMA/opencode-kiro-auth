import { afterAll, describe, expect, mock, test } from 'bun:test'

let cliSyncCalls = 0

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  getTimestamp: () => '2026-07-22T00:00:00.000Z',
  log: () => {},
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {},
  warn: () => {}
}))

mock.module('../plugin/sync/kiro-cli.js', () => ({
  syncFromKiroCli: async () => {
    cliSyncCalls++
  },
  writeToKiroCli: async () => {}
}))

const { RequestHandler } = await import('../core/request/request-handler.js')

afterAll(() => {
  mock.restore()
})

function makeAccount(overrides: any = {}) {
  return {
    id: 'account-1',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'refresh-token',
    accessToken: 'stale-access-token',
    expiresAt: Date.now() - 60_000,
    isHealthy: false,
    unhealthyReason: 'ExpiredTokenException',
    failCount: 10,
    usedCount: 0,
    limitCount: 0,
    ...overrides
  }
}

function makeConfig(overrides: any = {}) {
  return {
    max_request_iterations: 5,
    request_timeout_ms: 5_000,
    rate_limit_max_retries: 2,
    rate_limit_retry_delay_ms: 1,
    token_expiry_buffer_ms: 120000,
    auto_sync_kiro_cli: false,
    account_selection_strategy: 'sticky',
    enable_log_api_request: false,
    ...overrides
  }
}

function makeAccountManager(initial: any[]) {
  let accounts = [...initial]
  return {
    getAccounts: () => [...accounts],
    getAccountCount: () => accounts.length,
    reconcileAccount: (a: any) => {
      const i = accounts.findIndex((x) => x.id === a.id)
      if (i === -1) accounts.push(a)
      else accounts[i] = a
    },
    addAccount: (a: any) => {
      const i = accounts.findIndex((x) => x.id === a.id)
      if (i === -1) accounts.push(a)
      else accounts[i] = a
    },
    toAuthDetails: (a: any) => ({
      access: a.accessToken,
      refresh: a.refreshToken,
      expires: a.expiresAt,
      authMethod: a.authMethod,
      region: a.region,
      email: a.email
    })
  }
}

function makeRepository(findAllResult: any[]) {
  const calls = { findAll: 0, invalidateCache: 0 }
  return {
    calls,
    findAll: async () => {
      calls.findAll++
      return findAllResult
    },
    invalidateCache: () => {
      calls.invalidateCache++
    }
  }
}

describe('RequestHandler.attemptNonInteractiveRecovery', () => {
  test('reconciling a fresh persisted credential recovers the account without any refresh call', async () => {
    cliSyncCalls = 0
    const staleAccount = makeAccount()
    const freshAccount = makeAccount({
      isHealthy: true,
      unhealthyReason: undefined,
      accessToken: 'fresh-access',
      expiresAt: Date.now() + 3600000,
      failCount: 0
    })

    const accountManager = makeAccountManager([staleAccount])
    const repository = makeRepository([freshAccount])
    const config = makeConfig({ auto_sync_kiro_cli: true })

    const handler: any = new RequestHandler(accountManager as any, config, repository as any)
    let forceRefreshCalls = 0
    handler.tokenRefresher = {
      forceRefresh: async () => {
        forceRefreshCalls++
        return { account: staleAccount, success: false, changed: false }
      }
    }

    const recovered = await handler.attemptNonInteractiveRecovery()

    expect(recovered).toBe(true)
    expect(cliSyncCalls).toBe(1)
    expect(forceRefreshCalls).toBe(0)
    expect(accountManager.getAccounts()[0].accessToken).toBe('fresh-access')
  })

  test('falls back to forceRefresh when reconciliation does not produce a usable account', async () => {
    const staleAccount = makeAccount()
    const accountManager = makeAccountManager([staleAccount])
    const repository = makeRepository([staleAccount]) // unchanged, still permanently unhealthy
    const config = makeConfig()

    const handler: any = new RequestHandler(accountManager as any, config, repository as any)
    let forceRefreshCalls = 0
    handler.tokenRefresher = {
      forceRefresh: async () => {
        forceRefreshCalls++
        return { account: staleAccount, success: true, changed: true }
      }
    }

    const recovered = await handler.attemptNonInteractiveRecovery()

    expect(recovered).toBe(true)
    expect(forceRefreshCalls).toBe(1)
  })

  test('returns false when neither reconciliation nor forceRefresh recover an account', async () => {
    const staleAccount = makeAccount()
    const accountManager = makeAccountManager([staleAccount])
    const repository = makeRepository([staleAccount])
    const config = makeConfig()

    const handler: any = new RequestHandler(accountManager as any, config, repository as any)
    let forceRefreshCalls = 0
    handler.tokenRefresher = {
      forceRefresh: async () => {
        forceRefreshCalls++
        return { account: staleAccount, success: false, changed: false }
      }
    }

    const recovered = await handler.attemptNonInteractiveRecovery()

    expect(recovered).toBe(false)
    expect(forceRefreshCalls).toBe(1)
  })

  test('repository reload failure is non-fatal and reports no recovery', async () => {
    const staleAccount = makeAccount()
    const accountManager = makeAccountManager([staleAccount])
    const repository = {
      findAll: async () => {
        throw new Error('db unavailable')
      },
      invalidateCache: () => {}
    }
    const config = makeConfig()

    const handler: any = new RequestHandler(accountManager as any, config, repository as any)
    const recovered = await handler.attemptNonInteractiveRecovery()

    expect(recovered).toBe(false)
  })
})

describe('RequestHandler request loop: recovery-before-browser-auth wiring', () => {
  test('a successful non-interactive recovery is retried without ever calling interactive OAuth', async () => {
    const staleAccount = makeAccount()
    const freshAccount = makeAccount({
      isHealthy: true,
      unhealthyReason: undefined,
      accessToken: 'fresh-access',
      expiresAt: Date.now() + 3600000,
      failCount: 0
    })

    const accountManager = makeAccountManager([staleAccount])
    const repository = makeRepository([freshAccount])
    const config = makeConfig()

    let oauthAuthorizeCalls = 0
    const client = {
      provider: {
        oauth: {
          authorize: async () => {
            oauthAuthorizeCalls++
          },
          callback: async () => {}
        }
      },
      tui: { showToast: async () => {} }
    }

    const handler: any = new RequestHandler(
      accountManager as any,
      config,
      repository as any,
      client
    )
    handler.tokenRefresher = {
      forceRefresh: async () => ({ account: staleAccount, success: false, changed: false })
    }
    // After recovery, the loop selects an account again. We only need to prove
    // that point was reached without interactive auth, so fail fast there with
    // a distinguishable marker instead of driving a full SDK round-trip.
    handler.accountSelector = {
      selectHealthyAccount: async () => {
        throw new Error('STOP_TEST_MARKER')
      }
    }

    await expect(
      handler.handle(
        'https://q.us-east-1.amazonaws.com/models/claude-sonnet-4-5',
        { body: '{}' },
        () => {}
      )
    ).rejects.toThrow('STOP_TEST_MARKER')

    expect(oauthAuthorizeCalls).toBe(0)
    expect(accountManager.getAccounts()[0].accessToken).toBe('fresh-access')
  })

  test('interactive OAuth still runs when no non-interactive recovery is possible', async () => {
    const staleAccount = makeAccount()
    const accountManager = makeAccountManager([staleAccount])
    const repository = makeRepository([staleAccount])
    const config = makeConfig()

    let oauthAuthorizeCalls = 0
    const client = {
      provider: {
        oauth: {
          authorize: async () => {
            oauthAuthorizeCalls++
          },
          callback: async () => {}
        }
      },
      tui: { showToast: async () => {} }
    }

    const handler: any = new RequestHandler(
      accountManager as any,
      config,
      repository as any,
      client
    )
    handler.tokenRefresher = {
      forceRefresh: async () => ({ account: staleAccount, success: false, changed: false })
    }

    await expect(
      handler.handle(
        'https://q.us-east-1.amazonaws.com/models/claude-sonnet-4-5',
        { body: '{}' },
        () => {}
      )
    ).rejects.toThrow()

    expect(oauthAuthorizeCalls).toBe(1)
  })
})
