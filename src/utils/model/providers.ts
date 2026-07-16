import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { getGlobalConfig } from '../config.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'openai' | 'kiro'

/**
 * Providers that have per-model string tables (ALL_MODEL_CONFIGS, retirement
 * dates, etc.). Kiro is excluded: it reuses first-party model IDs and picks its
 * real models via the ModelPicker + kiro-fetch-adapter, not these tables.
 */
export type ModelTableProvider = Exclude<APIProvider, 'kiro'>

/** Like getAPIProvider() but collapses Kiro to firstParty for model-table lookups. */
export function getModelTableProvider(): ModelTableProvider {
  const provider = getAPIProvider()
  return provider === 'kiro' ? 'firstParty' : provider
}

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) || hasCodexTokens()
          ? 'openai'
          : hasKiroTokens()
            ? 'kiro'
            : 'firstParty'
}

/**
 * Check if valid Codex OAuth tokens are stored in GlobalConfig.
 * Used to auto-detect the OpenAI provider without requiring the env var.
 */
function hasCodexTokens(): boolean {
  try {
    const stored = getGlobalConfig().codexOAuth
    return !!stored?.accessToken && !!stored?.refreshToken
  } catch {
    // Config not yet initialized during early startup
    return false
  }
}

/**
 * Check if valid Kiro OAuth tokens are stored in GlobalConfig.
 * Used to auto-detect the Kiro (CodeWhisperer) provider.
 */
function hasKiroTokens(): boolean {
  try {
    const stored = getGlobalConfig().kiroOAuth
    return !!stored?.accessToken && !!stored?.refreshToken
  } catch {
    // Config not yet initialized during early startup
    return false
  }
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
