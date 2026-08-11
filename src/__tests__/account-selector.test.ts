import { describe, expect, test } from 'bun:test'
import { AccountSelector } from '../core/account/account-selector.js'

function makeAccountManager(overrides: any = {}) {
  return {
    getAccountCount: () => 1,
    getCurrentOrNext: () => null,
    getMinWaitTime: () => 0,
    shouldShowToast: () => true,
    shouldShowUsageToast: () => true,
    ...overrides
  }
}

const noopRepo: any = { invalidateCache: () => {}, findAll: async () => [] }
const noopSync = async () => {}
const config = { auto_sync_kiro_cli: false, account_selection_strategy: 'sticky' as const }

describe('AccountSelector rate-limit vs reauth', () => {
  test('a long rate-limit wait (over 30s) is still treated as rate-limited, not reauth', async () => {
    const accountManager = makeAccountManager({ getMinWaitTime: () => 45_000 })
    const selector: any = new AccountSelector(accountManager as any, config, noopSync, noopRepo)
    // Avoid actually sleeping 30s in the test.
    selector.sleep = async () => {}

    const result = await selector.selectHealthyAccount(() => {})
    expect(result).toBeNull()
  })

  test('no rate-limit wait and no account throws reauth required', async () => {
    const accountManager = makeAccountManager({ getMinWaitTime: () => 0 })
    const selector = new AccountSelector(accountManager as any, config, noopSync, noopRepo)

    await expect(selector.selectHealthyAccount(() => {})).rejects.toThrow('reauth required')
  })
})
