import { describe, expect, mock, test } from 'bun:test'

let refreshCalls = 0
let refreshBehavior: (auth: any) => Promise<any> = async (auth: any) => ({
  ...auth,
  access: 'fresh-access',
  refresh: 'fresh-refresh',
  expires: Date.now() + 3600000
})

mock.module('../plugin/token.js', () => ({
  refreshAccessToken: async (auth: any) => {
    refreshCalls++
    return refreshBehavior(auth)
  }
}))

// Other test files (accounts.test.ts, auth-handler.test.ts) call
// `mock.module('../kiro/auth.js', ...)` without ever restoring it, and
// bun:test's module mocks are process-global rather than file-scoped. Pin our
// own real-shaped implementation here so this file's expiry assertions are
// correct regardless of which other test files already ran in this process.
mock.module('../kiro/auth.js', () => ({
  decodeRefreshToken: (t: string) => ({ refreshToken: t }),
  encodeRefreshToken: (p: any) => p.refreshToken,
  accessTokenExpired: (auth: any, bufferMs = 120000) => {
    if (!auth.access || !auth.expires) return true
    return Date.now() >= auth.expires - bufferMs
  }
}))

const { TokenRefresher } = await import('../core/auth/token-refresher.js')
const { KiroTokenRefreshError } = await import('../plugin/errors.js')

function makeAccount(overrides: any = {}) {
  return {
    id: 'account-1',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'refresh-token',
    accessToken: 'stale-access-token',
    expiresAt: Date.now() - 60_000,
    isHealthy: true,
    failCount: 0,
    usedCount: 0,
    limitCount: 0,
    ...overrides
  }
}

function makeAuth(acc: any) {
  return {
    access: acc.accessToken,
    refresh: acc.refreshToken,
    expires: acc.expiresAt,
    authMethod: acc.authMethod,
    region: acc.region,
    email: acc.email
  }
}

function makeAccountManager(accounts: any[]) {
  const list = accounts
  return {
    getAccounts: () => list,
    toAuthDetails: (a: any) => makeAuth(a),
    updateFromAuth: (a: any, auth: any) => {
      const acc = list.find((x) => x.id === a.id)
      if (!acc) return
      acc.accessToken = auth.access
      acc.refreshToken = auth.refresh || acc.refreshToken
      acc.expiresAt = auth.expires
      acc.failCount = 0
      acc.isHealthy = true
      delete acc.unhealthyReason
    },
    markUnhealthy: (a: any, reason: string) => {
      const acc = list.find((x) => x.id === a.id)
      if (!acc) return
      acc.isHealthy = false
      acc.unhealthyReason = reason
      acc.failCount = 10
    },
    addAccount: (a: any) => {
      const i = list.findIndex((x) => x.id === a.id)
      if (i === -1) list.push(a)
      else list[i] = a
    }
  }
}

function makeRepository(findAllResult: any[] = []) {
  const calls = { save: 0, batchSave: 0, invalidateCache: 0, findAll: 0 }
  return {
    calls,
    save: async () => {
      calls.save++
    },
    batchSave: async () => {
      calls.batchSave++
    },
    invalidateCache: () => {
      calls.invalidateCache++
    },
    findAll: async () => {
      calls.findAll++
      return findAllResult
    }
  }
}

function makeConfig(overrides: any = {}) {
  return {
    token_expiry_buffer_ms: 120000,
    auto_sync_kiro_cli: false,
    account_selection_strategy: 'sticky',
    ...overrides
  }
}

describe('TokenRefresher.refreshIfNeeded', () => {
  test('skips refresh when token is not expired', async () => {
    refreshCalls = 0
    const acc = makeAccount({ expiresAt: Date.now() + 3600000 })
    const accountManager = makeAccountManager([acc])
    const repository = makeRepository()
    const refresher = new TokenRefresher(
      makeConfig(),
      accountManager as any,
      async () => {},
      repository as any
    )

    const result = await refresher.refreshIfNeeded(acc, makeAuth(acc), () => {})
    expect(result.shouldContinue).toBe(false)
    expect(refreshCalls).toBe(0)
  })

  test('successful refresh updates the account and does not require a loop continue', async () => {
    refreshCalls = 0
    refreshBehavior = async (auth: any) => ({
      ...auth,
      access: 'fresh-access',
      refresh: 'fresh-refresh',
      expires: Date.now() + 3600000
    })
    const acc = makeAccount()
    const accountManager = makeAccountManager([acc])
    const repository = makeRepository()
    const refresher = new TokenRefresher(
      makeConfig(),
      accountManager as any,
      async () => {},
      repository as any
    )

    const result = await refresher.refreshIfNeeded(acc, makeAuth(acc), () => {})
    expect(result.shouldContinue).toBe(false)
    expect(result.account.accessToken).toBe('fresh-access')
    expect(refreshCalls).toBe(1)
    expect(repository.calls.save).toBe(1)
  })

  test('concurrent refreshIfNeeded calls for the same account share one network exchange', async () => {
    refreshCalls = 0
    let resolveRefresh!: (v: any) => void
    refreshBehavior = (auth: any) =>
      new Promise((resolve) => {
        resolveRefresh = () =>
          resolve({
            ...auth,
            access: 'fresh-access-shared',
            refresh: 'fresh-refresh-shared',
            expires: Date.now() + 3600000
          })
      })

    const acc = makeAccount()
    const accountManager = makeAccountManager([acc])
    const repository = makeRepository()
    const refresher = new TokenRefresher(
      makeConfig(),
      accountManager as any,
      async () => {},
      repository as any
    )

    const p1 = refresher.refreshIfNeeded(acc, makeAuth(acc), () => {})
    const p2 = refresher.refreshIfNeeded(acc, makeAuth(acc), () => {})

    // Let both calls reach the in-flight refresh before resolving it.
    await new Promise((r) => setTimeout(r, 10))
    resolveRefresh(undefined)

    const [r1, r2] = await Promise.all([p1, p2])
    expect(refreshCalls).toBe(1)
    expect(r1.account.accessToken).toBe('fresh-access-shared')
    expect(r2.account.accessToken).toBe('fresh-access-shared')
  })

  test('a losing rotating-token refresh cannot mark the account permanently unhealthy after a winning refresh', async () => {
    refreshCalls = 0
    let callCount = 0
    refreshBehavior = async (auth: any) => {
      callCount++
      if (callCount === 1) {
        return {
          ...auth,
          access: 'winner-access',
          refresh: 'winner-refresh',
          expires: Date.now() + 3600000
        }
      }
      throw new KiroTokenRefreshError('Invalid grant provided', 'invalid_grant')
    }

    const acc = makeAccount()
    const accountManager = makeAccountManager([acc])
    const repository = makeRepository()
    const refresher = new TokenRefresher(
      makeConfig(),
      accountManager as any,
      async () => {},
      repository as any
    )

    // Because of the per-account lock, only one of these performs a real
    // network refresh; the other adopts its result.
    const [r1, r2] = await Promise.all([
      refresher.refreshIfNeeded(acc, makeAuth(acc), () => {}),
      refresher.refreshIfNeeded(acc, makeAuth(acc), () => {})
    ])

    expect(callCount).toBe(1)
    expect(acc.isHealthy).toBe(true)
    expect(acc.accessToken).toBe('winner-access')
    expect(r1.account.accessToken).toBe('winner-access')
    expect(r2.account.accessToken).toBe('winner-access')
  })

  test('refresh failure with recoverable Kiro CLI credentials adopts the recovered account', async () => {
    refreshCalls = 0
    refreshBehavior = async () => {
      throw new KiroTokenRefreshError('Invalid grant provided', 'invalid_grant')
    }

    const acc = makeAccount()
    const recovered = makeAccount({
      accessToken: 'recovered-access',
      expiresAt: Date.now() + 3600000
    })
    const accountManager = makeAccountManager([acc])
    const repository = makeRepository([recovered])
    const refresher = new TokenRefresher(
      makeConfig(),
      accountManager as any,
      async () => {},
      repository as any
    )

    const result = await refresher.refreshIfNeeded(acc, makeAuth(acc), () => {})
    expect(result.shouldContinue).toBe(true)
    expect(result.account.accessToken).toBe('recovered-access')
  })

  test('refresh failure with no recovery marks the account permanently unhealthy', async () => {
    refreshCalls = 0
    refreshBehavior = async () => {
      throw new KiroTokenRefreshError('Invalid grant provided', 'invalid_grant')
    }

    const acc = makeAccount()
    const accountManager = makeAccountManager([acc])
    const repository = makeRepository([]) // nothing recoverable
    const refresher = new TokenRefresher(
      makeConfig(),
      accountManager as any,
      async () => {},
      repository as any
    )

    const result = await refresher.refreshIfNeeded(acc, makeAuth(acc), () => {})
    expect(result.shouldContinue).toBe(true)
    expect(acc.isHealthy).toBe(false)
    expect(acc.unhealthyReason).toBe('invalid_grant')
  })
})

describe('TokenRefresher.forceRefresh', () => {
  test('returns success:false without throwing when refresh fails and nothing is recoverable', async () => {
    refreshCalls = 0
    refreshBehavior = async () => {
      throw new KiroTokenRefreshError('boom', 'NETWORK_ERROR')
    }

    const acc = makeAccount()
    const accountManager = makeAccountManager([acc])
    const repository = makeRepository([acc])
    const refresher = new TokenRefresher(
      makeConfig(),
      accountManager as any,
      async () => {},
      repository as any
    )

    const result = await refresher.forceRefresh(acc, makeAuth(acc))
    expect(result.success).toBe(false)
    expect(result.changed).toBe(false)
  })

  test('adopts a newer, non-expired token found via repository sync without hitting the network', async () => {
    refreshCalls = 0
    const acc = makeAccount({ accessToken: 'old-access' })
    const synced = makeAccount({ accessToken: 'synced-access', expiresAt: Date.now() + 3600000 })
    const accountManager = makeAccountManager([acc])
    const repository = makeRepository([synced])
    const refresher = new TokenRefresher(
      makeConfig(),
      accountManager as any,
      async () => {},
      repository as any
    )

    const result = await refresher.forceRefresh(acc, makeAuth(acc))
    expect(result.success).toBe(true)
    expect(result.changed).toBe(true)
    expect(acc.accessToken).toBe('synced-access')
    expect(refreshCalls).toBe(0)
  })

  test('reports success:true and changed:true after a successful network refresh', async () => {
    refreshCalls = 0
    refreshBehavior = async (auth: any) => ({
      ...auth,
      access: 'network-fresh-access',
      refresh: 'network-fresh-refresh',
      expires: Date.now() + 3600000
    })
    const acc = makeAccount({ accessToken: 'old-access' })
    const accountManager = makeAccountManager([acc])
    const repository = makeRepository([acc])
    const refresher = new TokenRefresher(
      makeConfig(),
      accountManager as any,
      async () => {},
      repository as any
    )

    const result = await refresher.forceRefresh(acc, makeAuth(acc))
    expect(result.success).toBe(true)
    expect(result.changed).toBe(true)
    expect(acc.accessToken).toBe('network-fresh-access')
  })

  test('concurrent forceRefresh calls for the same account share one network exchange', async () => {
    refreshCalls = 0
    let resolveRefresh!: (v: any) => void
    refreshBehavior = (auth: any) =>
      new Promise((resolve) => {
        resolveRefresh = () =>
          resolve({
            ...auth,
            access: 'force-shared-access',
            refresh: 'force-shared-refresh',
            expires: Date.now() + 3600000
          })
      })

    const acc = makeAccount()
    const accountManager = makeAccountManager([acc])
    const repository = makeRepository([acc])
    const refresher = new TokenRefresher(
      makeConfig(),
      accountManager as any,
      async () => {},
      repository as any
    )

    const p1 = refresher.forceRefresh(acc, makeAuth(acc))
    const p2 = refresher.forceRefresh(acc, makeAuth(acc))
    await new Promise((r) => setTimeout(r, 10))
    resolveRefresh(undefined)

    const [r1, r2] = await Promise.all([p1, p2])
    expect(refreshCalls).toBe(1)
    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
  })
})
