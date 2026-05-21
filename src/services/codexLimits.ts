export type CodexLimitWindow = {
  remainingPercent: number
  resetAt?: number
}

export type CodexLimitsSnapshot = {
  fiveHour?: CodexLimitWindow
  weekly?: CodexLimitWindow
  updatedAt: number
}

type WhamUsageWindow = {
  used_percent?: number
  limit_window_seconds?: number
  reset_after_seconds?: number
  reset_at?: number
}

type WhamUsageResponse = {
  rate_limit?: {
    primary_window?: WhamUsageWindow
    secondary_window?: WhamUsageWindow
  }
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const REFRESH_TTL_MS = 60 * 1000
const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

let cachedLimits: CodexLimitsSnapshot | undefined
let lastRefreshAttempt = 0
let refreshPromise: Promise<CodexLimitsSnapshot | undefined> | undefined

const HEADER_CANDIDATES = {
  fiveHour: {
    remaining: [
      'x-ratelimit-remaining-5h',
      'x-ratelimit-remaining-five-hour',
      'x-ratelimit-remaining-five_hour',
      'x-codex-ratelimit-remaining-5h',
      'x-codex-ratelimit-remaining-five-hour',
    ],
    limit: [
      'x-ratelimit-limit-5h',
      'x-ratelimit-limit-five-hour',
      'x-ratelimit-limit-five_hour',
      'x-codex-ratelimit-limit-5h',
      'x-codex-ratelimit-limit-five-hour',
    ],
    reset: [
      'x-ratelimit-reset-5h',
      'x-ratelimit-reset-five-hour',
      'x-ratelimit-reset-five_hour',
      'x-codex-ratelimit-reset-5h',
      'x-codex-ratelimit-reset-five-hour',
    ],
  },
  weekly: {
    remaining: [
      'x-ratelimit-remaining-weekly',
      'x-ratelimit-remaining-7d',
      'x-ratelimit-remaining-seven-day',
      'x-ratelimit-remaining-seven_day',
      'x-codex-ratelimit-remaining-weekly',
      'x-codex-ratelimit-remaining-7d',
    ],
    limit: [
      'x-ratelimit-limit-weekly',
      'x-ratelimit-limit-7d',
      'x-ratelimit-limit-seven-day',
      'x-ratelimit-limit-seven_day',
      'x-codex-ratelimit-limit-weekly',
      'x-codex-ratelimit-limit-7d',
    ],
    reset: [
      'x-ratelimit-reset-weekly',
      'x-ratelimit-reset-7d',
      'x-ratelimit-reset-seven-day',
      'x-ratelimit-reset-seven_day',
      'x-codex-ratelimit-reset-weekly',
      'x-codex-ratelimit-reset-7d',
    ],
  },
} as const

export function updateCodexLimitsFromHeaders(headers: globalThis.Headers): void {
  const fiveHour = extractWindow(headers, HEADER_CANDIDATES.fiveHour)
  const weekly = extractWindow(headers, HEADER_CANDIDATES.weekly)

  if (!fiveHour && !weekly) {
    return
  }

  cachedLimits = {
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    updatedAt: Date.now(),
  }
}

export function getCodexLimitsDisplayText(): string {
  const limits = getFreshCodexLimits()
  if (!limits) {
    return 'codex 限额数据暂无'
  }

  const parts = [
    formatWindow('5小时使用限额', limits.fiveHour),
    formatWindow('每周使用限额', limits.weekly),
  ].filter((part): part is string => Boolean(part))

  if (parts.length === 0) {
    return 'codex 限额数据暂无'
  }

  return `codex ${parts.join(' ')}`
}

export function getFreshCodexLimits(): CodexLimitsSnapshot | undefined {
  if (!cachedLimits) {
    return undefined
  }
  if (Date.now() - cachedLimits.updatedAt > CACHE_TTL_MS) {
    return undefined
  }
  return cachedLimits
}

export async function refreshCodexLimitsFromAnalytics(
  accessToken: string,
  accountId: string,
): Promise<CodexLimitsSnapshot | undefined> {
  const now = Date.now()
  const fresh = getFreshCodexLimits()
  if (fresh && now - lastRefreshAttempt < REFRESH_TTL_MS) {
    return fresh
  }

  if (refreshPromise) {
    return refreshPromise
  }

  lastRefreshAttempt = now
  refreshPromise = fetchWhamUsage(accessToken, accountId)
    .then(usage => {
      const snapshot = extractLimitsFromWhamUsage(usage)
      if (snapshot) {
        cachedLimits = snapshot
      }
      return getFreshCodexLimits()
    })
    .catch(() => getFreshCodexLimits())
    .finally(() => {
      refreshPromise = undefined
    })

  return refreshPromise
}

type HeaderCandidateSet = {
  remaining: readonly string[]
  limit: readonly string[]
  reset: readonly string[]
}

async function fetchWhamUsage(
  accessToken: string,
  accountId: string,
): Promise<WhamUsageResponse> {
  const response = await globalThis.fetch(WHAM_USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': accountId,
      Accept: 'application/json',
      originator: 'vscode',
    },
  })

  if (!response.ok) {
    throw new Error(`Codex analytics request failed: ${response.status}`)
  }

  return (await response.json()) as WhamUsageResponse
}

function extractLimitsFromWhamUsage(
  usage: WhamUsageResponse,
): CodexLimitsSnapshot | undefined {
  const windows = [
    usage.rate_limit?.primary_window,
    usage.rate_limit?.secondary_window,
  ]
  const fiveHour = windows.find(window => window?.limit_window_seconds === 18000)
  const weekly = windows.find(window => window?.limit_window_seconds === 604800)

  if (!fiveHour && !weekly) {
    return undefined
  }

  return {
    ...(fiveHour ? { fiveHour: extractWhamWindow(fiveHour) } : {}),
    ...(weekly ? { weekly: extractWhamWindow(weekly) } : {}),
    updatedAt: Date.now(),
  }
}

function extractWhamWindow(window: WhamUsageWindow): CodexLimitWindow {
  const usedPercent = Number(window.used_percent)
  const remainingPercent = Number.isFinite(usedPercent)
    ? Math.max(0, Math.min(100, Math.round(100 - usedPercent)))
    : 0
  const resetAt = parseResetValue(window.reset_at)

  return {
    remainingPercent,
    ...(resetAt !== undefined ? { resetAt } : {}),
  }
}

function extractWindow(
  headers: globalThis.Headers,
  candidates: HeaderCandidateSet,
): CodexLimitWindow | undefined {
  const remaining = getNumericHeader(headers, candidates.remaining)
  const limit = getNumericHeader(headers, candidates.limit)

  if (remaining === undefined || limit === undefined || limit <= 0) {
    return undefined
  }

  const resetAt = parseResetHeader(getHeader(headers, candidates.reset))
  const remainingPercent = Math.max(
    0,
    Math.min(100, Math.round((remaining / limit) * 100)),
  )

  return {
    remainingPercent,
    ...(resetAt !== undefined ? { resetAt } : {}),
  }
}

function getHeader(
  headers: globalThis.Headers,
  candidateNames: readonly string[],
): string | undefined {
  for (const name of candidateNames) {
    const value = headers.get(name)
    if (value !== null && value.trim() !== '') {
      return value
    }
  }
  return undefined
}

function getNumericHeader(
  headers: globalThis.Headers,
  candidateNames: readonly string[],
): number | undefined {
  const value = getHeader(headers, candidateNames)
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseResetHeader(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    return parseResetValue(numeric)
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined
}

function parseResetValue(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined
  }
  return value > 10_000_000_000 ? Math.floor(value / 1000) : value
}

function formatWindow(label: string, window: CodexLimitWindow | undefined) {
  if (!window) {
    return undefined
  }

  const resetText = window.resetAt
    ? `重置时间: ${formatResetTime(window.resetAt)}`
    : '重置时间: 暂无'

  return `${label}${window.remainingPercent}%剩余(${resetText})`
}

function formatResetTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString()
}
