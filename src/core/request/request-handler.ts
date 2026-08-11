import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import type { KiroConfig } from '../../plugin/config'
import { isPermanentError } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { transformToSdkRequest } from '../../plugin/request'
import { createSdkClient } from '../../plugin/sdk-client'
import { syncFromKiroCli } from '../../plugin/sync/kiro-cli'
import type { KiroAuthDetails, ManagedAccount, SdkPreparedRequest } from '../../plugin/types'
import { AccountSelector } from '../account/account-selector'
import { UsageTracker } from '../account/usage-tracker'
import { TokenRefresher } from '../auth/token-refresher'
import { ErrorHandler } from './error-handler'
import { ResponseHandler } from './response-handler'
import { RetryStrategy } from './retry-strategy'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/
const REAUTH_FAILURE_COOLDOWN_MS = 60000

export class RequestHandler {
  private accountSelector: AccountSelector
  private tokenRefresher: TokenRefresher
  private errorHandler: ErrorHandler
  private responseHandler: ResponseHandler
  private usageTracker: UsageTracker
  private retryStrategy: RetryStrategy
  private reauthInFlight: Promise<boolean> | null = null
  private lastFailedReauthAt = 0
  private static kiroRequestQueue: Promise<void> = Promise.resolve()

  constructor(
    private accountManager: AccountManager,
    private config: KiroConfig,
    private repository: AccountRepository,
    private client?: any
  ) {
    this.accountSelector = new AccountSelector(accountManager, config, syncFromKiroCli, repository)
    this.tokenRefresher = new TokenRefresher(config, accountManager, syncFromKiroCli, repository)
    this.errorHandler = new ErrorHandler(config, accountManager, repository)
    this.responseHandler = new ResponseHandler()
    this.usageTracker = new UsageTracker(config, accountManager, repository)
    this.retryStrategy = new RetryStrategy(config)
  }

  async handle(input: any, init: any, showToast: ToastFunction): Promise<Response> {
    const url = typeof input === 'string' ? input : input.url

    if (!KIRO_API_PATTERN.test(url)) {
      return fetch(input, init)
    }

    return this.enqueueKiroRequest(() => this.handleKiroRequest(url, init, showToast))
  }

  private async enqueueKiroRequest<T>(run: () => Promise<T>): Promise<T> {
    const previous = RequestHandler.kiroRequestQueue
    let release!: () => void

    RequestHandler.kiroRequestQueue = new Promise((resolve) => {
      release = resolve
    })

    await previous.catch(() => {})

    try {
      return await run()
    } finally {
      release()
    }
  }

  private async handleKiroRequest(
    url: string,
    init: any,
    showToast: ToastFunction
  ): Promise<Response> {
    const body = init?.body ? JSON.parse(init.body) : {}
    const model = this.extractModel(url) || body.model || 'claude-sonnet-4-5'
    const think =
      model.endsWith('-thinking') || !!body.providerOptions?.thinkingConfig || !!body.thinkingConfig
    const budget =
      body.providerOptions?.thinkingConfig?.thinkingBudget ||
      body.thinkingConfig?.thinkingBudget ||
      body.thinkingConfig?.budget_tokens ||
      20000

    let retry = 0
    let bearerRetried = false
    let consecutiveNullAccounts = 0
    const retryContext = this.retryStrategy.createContext()

    while (true) {
      const check = this.retryStrategy.shouldContinue(retryContext)
      if (!check.canContinue) {
        throw new Error(check.error)
      }

      if (this.allAccountsPermanentlyUnhealthy()) {
        if (await this.attemptNonInteractiveRecovery()) {
          continue
        }
        const reauthed = await this.triggerReauth(showToast)
        if (!reauthed) {
          throw new Error('All accounts are permanently unhealthy. Please re-authenticate.')
        }
        continue
      }

      let acc = await this.accountSelector.selectHealthyAccount(showToast).catch(async (e) => {
        if (e instanceof Error && e.message.includes('reauth required')) {
          if (await this.attemptNonInteractiveRecovery()) {
            return null
          }
          const reauthed = await this.triggerReauth(showToast)
          if (!reauthed)
            throw new Error('All accounts are unhealthy or rate-limited. Please re-authenticate.')
          return null
        }
        throw e
      })
      if (!acc) {
        consecutiveNullAccounts++
        const backoffDelay = Math.min(1000 * Math.pow(2, consecutiveNullAccounts - 1), 10000)
        await this.sleep(backoffDelay)
        continue
      }

      consecutiveNullAccounts = 0

      const tokenResult = await this.tokenRefresher.refreshIfNeeded(
        acc,
        this.accountManager.toAuthDetails(acc),
        showToast
      )
      if (tokenResult.shouldContinue) {
        acc = tokenResult.account
        await this.sleep(500)
        continue
      }

      // Rebuild auth from the (possibly refreshed) account rather than reusing
      // a pre-refresh snapshot, so the SDK client always sends the token that
      // was just persisted, never a stale one from before refreshIfNeeded().
      acc = tokenResult.account
      const auth = this.accountManager.toAuthDetails(acc)

      const sdkPrep = this.prepareSdkRequest(init?.body, model, auth, think, budget, showToast)

      const apiTimestamp = this.config.enable_log_api_request ? logger.getTimestamp() : null
      if (apiTimestamp) {
        this.logSdkRequest(sdkPrep, acc, apiTimestamp)
      }
      try {
        const client = createSdkClient(auth, sdkPrep.region, sdkPrep.effort)
        const command = new GenerateAssistantResponseCommand({
          conversationState: sdkPrep.conversationState as any,
          profileArn: sdkPrep.profileArn
        })

        const sdkResponse = await client.send(command)

        if (apiTimestamp) {
          this.logSdkResponse(sdkPrep, apiTimestamp)
        }

        this.handleSuccessfulRequest(acc)
        this.usageTracker.syncUsage(acc, auth)

        return await this.responseHandler.handleSdkSuccess(
          sdkResponse,
          model,
          sdkPrep.conversationId,
          sdkPrep.streaming,
          sdkPrep.toolNameMap
        )
      } catch (e: any) {
        const httpStatus = e?.$metadata?.httpStatusCode

        if (httpStatus && apiTimestamp) {
          this.logSdkError(sdkPrep, e, acc, apiTimestamp)
        }

        if (httpStatus === 403 && !bearerRetried) {
          const msg = e?.message || ''
          if (
            msg.includes('bearer token included in the request is invalid') ||
            msg.includes('The bearer token included in the request is invalid')
          ) {
            bearerRetried = true
            logger.warn('403 bearer invalid on first attempt, forcing token refresh and retrying')
            await this.tokenRefresher.forceRefresh(acc, this.accountManager.toAuthDetails(acc))
            continue
          }
        }

        if (httpStatus) {
          const mockResponse = new Response(
            JSON.stringify({ message: e.message, __type: e.name }),
            {
              status: httpStatus,
              statusText: e.name || 'Error',
              headers: { 'Content-Type': 'application/json' }
            }
          )

          const errorResult = await this.errorHandler.handle(
            e,
            mockResponse,
            acc,
            { retry, bearerRetried },
            showToast
          )

          if (errorResult.shouldRetry) {
            if (errorResult.newContext) {
              retry = errorResult.newContext.retry
              bearerRetried = errorResult.newContext.bearerRetried ?? bearerRetried
            }
            if (errorResult.forceRefresh) {
              await this.tokenRefresher.forceRefresh(acc, this.accountManager.toAuthDetails(acc))
            }
            if (errorResult.switchAccount) {
              continue
            }
            continue
          }

          const errMsg = e?.message || `Kiro Error: ${httpStatus}`
          if (/input is too long/i.test(errMsg)) {
            return new Response(
              JSON.stringify({
                error: {
                  message: 'input is too long for requested model',
                  type: 'invalid_request_error',
                  code: 'context_length_exceeded'
                }
              }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
              }
            )
          }
          throw new Error(`Kiro Error: ${httpStatus}`)
        }

        const networkResult = await this.errorHandler.handleNetworkError(e, { retry }, showToast)

        if (networkResult.shouldRetry) {
          if (networkResult.newContext) {
            retry = networkResult.newContext.retry
          }
          continue
        }

        throw e
      }
    }
  }

  private extractModel(url: string): string | null {
    return url.match(/models\/([^/:]+)/)?.[1] || null
  }

  private prepareSdkRequest(
    body: any,
    model: string,
    auth: KiroAuthDetails,
    think: boolean,
    budget: number,
    showToast?: (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void
  ): SdkPreparedRequest {
    return transformToSdkRequest(body, model, auth, think, budget, showToast, {
      effort: this.config.effort,
      autoEffortMapping: this.config.auto_effort_mapping
    })
  }

  private handleSuccessfulRequest(acc: ManagedAccount): void {
    if (acc.failCount && acc.failCount > 0) {
      if (!isPermanentError(acc.unhealthyReason)) {
        acc.failCount = 0
        acc.isHealthy = true
        delete acc.unhealthyReason
        delete acc.recoveryTime
        this.repository.save(acc).catch(() => {})
      }
    }
  }

  private logSdkRequest(prep: SdkPreparedRequest, acc: ManagedAccount, timestamp: string): void {
    // Mirrors what the sdk-client middleware injects, so logs reflect the wire body.
    const additionalModelRequestFields = prep.effort
      ? { output_config: { effort: prep.effort } }
      : undefined

    logger.logApiRequest(
      {
        url: `https://q.${prep.region}.amazonaws.com/generateAssistantResponse`,
        method: 'POST',
        headers: { 'x-amzn-kiro-agent-mode': 'vibe' },
        body: {
          conversationState: {
            chatTriggerType: prep.conversationState.chatTriggerType,
            conversationId: prep.conversationState.conversationId,
            historyLength: (prep.conversationState as any).history?.length || 0,
            currentMessage: prep.conversationState.currentMessage
          },
          profileArn: prep.profileArn,
          ...(additionalModelRequestFields ? { additionalModelRequestFields } : {})
        },
        conversationId: prep.conversationId,
        model: prep.effectiveModel,
        email: acc.email
      },
      timestamp
    )
  }

  private logSdkResponse(prep: SdkPreparedRequest, timestamp: string): void {
    logger.logApiResponse(
      {
        status: 200,
        statusText: 'OK',
        headers: {},
        conversationId: prep.conversationId,
        model: prep.effectiveModel
      },
      timestamp
    )
  }

  private logSdkError(
    prep: SdkPreparedRequest,
    error: any,
    acc: ManagedAccount,
    apiTimestamp: string
  ): void {
    const status = error?.$metadata?.httpStatusCode || 0
    const rData = {
      status,
      statusText: error?.name || 'Error',
      headers: {},
      error: `Kiro Error: ${status} - ${error?.message || 'Unknown'}`,
      conversationId: prep.conversationId,
      model: prep.effectiveModel
    }
    if (!this.config.enable_log_api_request) {
      logger.logApiError(
        {
          url: `https://q.${prep.region}.amazonaws.com/generateAssistantResponse`,
          method: 'POST',
          headers: {},
          body: null,
          conversationId: prep.conversationId,
          model: prep.effectiveModel,
          email: acc.email
        },
        rData,
        logger.getTimestamp()
      )
    } else {
      logger.logApiResponse(rData, apiTimestamp)
    }
  }

  private async triggerReauth(showToast: ToastFunction): Promise<boolean> {
    if (!this.client) return false

    const cooldownRemaining = REAUTH_FAILURE_COOLDOWN_MS - (Date.now() - this.lastFailedReauthAt)
    if (cooldownRemaining > 0) {
      showToast(
        'Recent re-authentication failed. Please complete authentication manually.',
        'error'
      )
      return false
    }

    if (this.reauthInFlight) {
      return this.reauthInFlight
    }

    this.reauthInFlight = this.performReauth(showToast)
    const success = await this.reauthInFlight.finally(() => {
      this.reauthInFlight = null
    })
    if (!success) this.lastFailedReauthAt = Date.now()
    return success
  }

  private async performReauth(showToast: ToastFunction): Promise<boolean> {
    try {
      showToast('Session expired. Re-authenticating...', 'warning')
      await this.client.provider.oauth.authorize({
        path: { id: 'kiro' },
        body: { method: 0 }
      })

      await this.client.provider.oauth.callback({
        path: { id: 'kiro' },
        body: { method: 0 }
      })

      this.repository.invalidateCache()
      const accounts = await this.repository.findAll()
      for (const acc of accounts) {
        this.accountManager.addAccount(acc)
      }

      if (!this.hasUsableAccount(accounts)) {
        logger.warn('Re-auth completed but no usable Kiro account was found')
        showToast('Re-authentication completed but no usable Kiro account was found.', 'error')
        return false
      }

      showToast('Re-authentication successful.', 'success')
      return true
    } catch (e) {
      logger.error('Re-auth failed', e instanceof Error ? e : new Error(String(e)))
      return false
    }
  }

  /**
   * Non-interactive recovery attempted before ever opening a browser for
   * device-code auth. A refresh may have already succeeded and persisted
   * fresh credentials (e.g. from a concurrent startup usage refresh, or from
   * Kiro CLI) that the in-memory AccountManager hasn't picked up yet. This
   * reloads the repository, re-syncs Kiro CLI if enabled, reconciles any
   * recovered accounts into memory (without writing them back), and tries a
   * refresh for any account that still looks unhealthy. Returns true if at
   * least one account became usable, so the caller can retry the request
   * loop instead of falling through to interactive OAuth.
   */
  private async attemptNonInteractiveRecovery(): Promise<boolean> {
    if (this.config.auto_sync_kiro_cli) {
      try {
        await syncFromKiroCli()
      } catch (e) {
        logger.warn('Non-interactive recovery: Kiro CLI sync failed', {
          message: e instanceof Error ? e.message : String(e)
        })
      }
    }

    this.repository.invalidateCache()
    let persisted: ManagedAccount[]
    try {
      persisted = await this.repository.findAll()
    } catch (e) {
      logger.warn('Non-interactive recovery: repository reload failed', {
        message: e instanceof Error ? e.message : String(e)
      })
      return false
    }

    for (const acc of persisted) {
      this.accountManager.reconcileAccount(acc)
    }

    let recovered = false
    const now = Date.now()
    for (const acc of this.accountManager.getAccounts()) {
      const isUsable =
        acc.isHealthy && acc.expiresAt > now && !isPermanentError(acc.unhealthyReason)
      if (isUsable) {
        recovered = true
        continue
      }
      if (isPermanentError(acc.unhealthyReason)) {
        // Give a permanently-unhealthy account one more chance: it may have
        // been marked so by a losing refresh in a rotating-token race while a
        // sibling call already rotated it successfully (handled above via
        // reconcileAccount), or a fresh refresh token may already be sitting
        // in the DB/Kiro CLI. forceRefresh() checks both before attempting a
        // network refresh, and TokenRefresher's per-account lock keeps this
        // from racing a concurrent refresh for the same account.
        try {
          const result = await this.tokenRefresher.forceRefresh(
            acc,
            this.accountManager.toAuthDetails(acc)
          )
          if (result.success) {
            recovered = true
          }
        } catch (e) {
          logger.warn('Non-interactive recovery: force refresh failed', {
            email: acc.email,
            message: e instanceof Error ? e.message : String(e)
          })
        }
      }
    }

    return recovered
  }

  private hasUsableAccount(accounts: ManagedAccount[]): boolean {
    const now = Date.now()
    return accounts.some(
      (acc) => acc.isHealthy && acc.expiresAt > now && !isPermanentError(acc.unhealthyReason)
    )
  }

  private allAccountsPermanentlyUnhealthy(): boolean {
    const accounts = this.accountManager.getAccounts()
    if (accounts.length === 0) {
      return false
    }
    return accounts.every((acc) => !acc.isHealthy && isPermanentError(acc.unhealthyReason))
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
