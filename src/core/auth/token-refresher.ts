import type { AccountRepository } from '../../infrastructure/database/account-repository'
import { accessTokenExpired } from '../../kiro/auth'
import type { AccountManager } from '../../plugin/accounts'
import { KiroTokenRefreshError } from '../../plugin/errors'
import * as logger from '../../plugin/logger'
import { refreshAccessToken } from '../../plugin/token'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface TokenRefresherConfig {
  token_expiry_buffer_ms: number
  auto_sync_kiro_cli: boolean
  account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage'
}

interface InternalRefreshResult {
  account: ManagedAccount
  /** True only when refreshAccessToken() succeeded directly during this call. */
  directRefresh: boolean
  /** True when the resulting account currently holds a plausibly valid access token. */
  usable: boolean
}

export class TokenRefresher {
  // Shared across every TokenRefresher instance (startup usage refresh and the
  // per-request refresher each construct their own instance) so a rotating
  // refresh token is never exchanged twice concurrently for the same account.
  // A second concurrent exchange with the old token would fail with
  // invalid_grant and could mark a perfectly healthy account permanently
  // unhealthy right after a sibling call already rotated it successfully.
  private static locks = new Map<string, Promise<InternalRefreshResult>>()

  constructor(
    private config: TokenRefresherConfig,
    private accountManager: AccountManager,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository
  ) {}

  async refreshIfNeeded(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    if (!accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
      return { account, shouldContinue: false }
    }

    const result = await this.runExclusive(account.id, () =>
      this.performOidcRefresh(account, auth, showToast)
    )
    return { account: result.account, shouldContinue: !result.directRefresh }
  }

  async forceRefresh(
    account: ManagedAccount,
    auth: KiroAuthDetails
  ): Promise<{ account: ManagedAccount; success: boolean; changed: boolean }> {
    const before = account.accessToken
    const result = await this.runExclusive(account.id, () =>
      this.performForceRefresh(account, auth)
    )
    return {
      account: result.account,
      success: result.usable,
      changed: result.account.accessToken !== before
    }
  }

  /** Ensures only one refresh/recovery flow runs per account at a time; late
   *  callers await and adopt the in-flight operation's outcome instead of
   *  racing it with a second network exchange of the same refresh token. */
  private async runExclusive(
    accountId: string,
    factory: () => Promise<InternalRefreshResult>
  ): Promise<InternalRefreshResult> {
    const existing = TokenRefresher.locks.get(accountId)
    if (existing) {
      return existing
    }

    const promise = factory().finally(() => {
      if (TokenRefresher.locks.get(accountId) === promise) {
        TokenRefresher.locks.delete(accountId)
      }
    })
    TokenRefresher.locks.set(accountId, promise)
    return promise
  }

  private async performOidcRefresh(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: ToastFunction
  ): Promise<InternalRefreshResult> {
    try {
      const newAuth = await refreshAccessToken(auth)
      this.accountManager.updateFromAuth(account, newAuth)
      // Persist only the updated account instead of all accounts — avoids
      // invalidating the whole AccountCache on every token refresh.
      await this.repository.save(account)
      return { account, directRefresh: true, usable: true }
    } catch (e: any) {
      return await this.handleRefreshError(e, account, showToast)
    }
  }

  private async performForceRefresh(
    account: ManagedAccount,
    auth: KiroAuthDetails
  ): Promise<InternalRefreshResult> {
    if (this.config.auto_sync_kiro_cli) {
      try {
        await this.syncFromKiroCli()
      } catch (e) {
        logger.warn('Force refresh: Kiro CLI sync failed', {
          message: e instanceof Error ? e.message : String(e)
        })
      }
    }

    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    const synced = accounts.find((a: ManagedAccount) => a.id === account.id)

    if (
      synced &&
      synced.accessToken !== account.accessToken &&
      !accessTokenExpired(
        this.accountManager.toAuthDetails(synced),
        this.config.token_expiry_buffer_ms
      )
    ) {
      this.accountManager.updateFromAuth(account, this.accountManager.toAuthDetails(synced))
      await this.repository.batchSave(this.accountManager.getAccounts())
      logger.debug('Force refresh: recovered newer token from CLI sync')
      return { account, directRefresh: false, usable: true }
    }

    try {
      const newAuth = await refreshAccessToken(auth)
      this.accountManager.updateFromAuth(account, newAuth)
      await this.repository.batchSave(this.accountManager.getAccounts())
      logger.debug('Force refresh: token refreshed via OIDC')
      return { account, directRefresh: true, usable: true }
    } catch (e: any) {
      logger.warn('Force refresh failed', {
        message: e instanceof Error ? e.message : String(e)
      })
      return { account, directRefresh: false, usable: false }
    }
  }

  private async handleRefreshError(
    error: any,
    account: ManagedAccount,
    showToast: ToastFunction
  ): Promise<InternalRefreshResult> {
    logger.error('Token refresh failed', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
    if (this.config.auto_sync_kiro_cli) {
      try {
        await this.syncFromKiroCli()
      } catch (e) {
        logger.warn('Token refresh recovery: Kiro CLI sync failed', {
          message: e instanceof Error ? e.message : String(e)
        })
      }
    }

    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    const stillAcc = accounts.find((a: ManagedAccount) => a.id === account.id)

    if (
      stillAcc &&
      !accessTokenExpired(
        this.accountManager.toAuthDetails(stillAcc),
        this.config.token_expiry_buffer_ms
      )
    ) {
      this.accountManager.addAccount(stillAcc)
      showToast('Credentials recovered from Kiro CLI sync.', 'info')
      return { account: stillAcc, directRefresh: false, usable: true }
    }

    if (
      error instanceof KiroTokenRefreshError &&
      (error.code === 'ExpiredTokenException' ||
        error.code === 'InvalidTokenException' ||
        error.code === 'ExpiredClientException' ||
        error.code === 'HTTP_401' ||
        error.code === 'HTTP_403' ||
        error.message.includes('Invalid refresh token provided') ||
        error.message.includes('Invalid grant provided') ||
        error.message.includes('Client is expired'))
    ) {
      this.accountManager.markUnhealthy(account, error.code || error.message)
      await this.repository.batchSave(this.accountManager.getAccounts())
      return { account, directRefresh: false, usable: false }
    }

    logger.error('Token refresh unrecoverable', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}
