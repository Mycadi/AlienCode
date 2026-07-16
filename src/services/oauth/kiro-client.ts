/**
 * Self-contained Kiro (AWS CodeWhisperer) auth client.
 *
 * Unlike the Anthropic and Codex OAuth clients, we do NOT run a browser OAuth
 * flow for Kiro (its client_id is not public). Instead we reuse the refresh
 * token that a logged-in Kiro IDE/CLI already stored on disk, exchange it for a
 * short-lived access token, and persist both.
 *
 * Two auth methods are supported, matching Kiro's own two login paths:
 * - Social: kiro.dev refresh endpoint, body { refreshToken }
 * - IdC:    AWS SSO OIDC refresh endpoint, needs clientId + clientSecret
 *
 * Token source resolution order:
 * 1. ~/.aws/sso/cache/*.json written by Kiro IDE/CLI (auto-detected)
 * 2. A refresh token pasted by the user (manual fallback)
 */
import { readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import {
  KIRO_AUTH_IDC,
  KIRO_AUTH_SOCIAL,
  KIRO_IDC_REFRESH_URL,
  KIRO_IDC_USER_AGENT,
  KIRO_SOCIAL_REFRESH_URL,
  type KiroAuthMethod,
} from '../../constants/kiro-oauth.js'
import { logError } from '../../utils/log.js'

// ── Types ────────────────────────────────────────────────────────────────────

export type KiroTokens = {
  /** CodeWhisperer bearer access token */
  accessToken: string
  /** Long-lived refresh token */
  refreshToken: string
  /** Absolute epoch timestamp (ms) when the access token expires */
  expiresAt: number
  /** Which refresh endpoint to use */
  authMethod: KiroAuthMethod
  /** IdC only: OAuth client credentials required to refresh */
  clientId?: string
  clientSecret?: string
  /** CodeWhisperer profile ARN (from the IDE cache, when present) */
  profileArn?: string
}

/** Raw shape of a ~/.aws/sso/cache/*.json entry we care about. */
type SsoCacheEntry = {
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  clientIdHash?: string
  profileArn?: string
  expiresAt?: string | number
  authMethod?: string
}

// ── SSO cache reading ─────────────────────────────────────────────────────────

/** Absolute path to the AWS SSO cache directory Kiro IDE/CLI writes to. */
function ssoCacheDir(): string {
  return join(homedir(), '.aws', 'sso', 'cache')
}

/**
 * Reads the Enterprise profileArn from Kiro IDE's globalStorage profile.json.
 *
 * Enterprise (IdC) accounts have an account-specific profileArn that is NOT
 * present in the ~/.aws/sso/cache files — it lives in the Kiro IDE data dir.
 * Without the correct profileArn, CodeWhisperer rejects requests with
 * "bearer token invalid". Returns undefined when the file is absent/unreadable.
 */
async function readKiroIdeProfileArn(): Promise<string | undefined> {
  const rel = join('Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'profile.json')
  const candidates =
    process.platform === 'win32'
      ? [join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), rel)]
      : process.platform === 'darwin'
        ? [join(homedir(), 'Library', 'Application Support', rel)]
        : [join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), rel)]

  for (const path of candidates) {
    try {
      const raw = await readFile(path, 'utf-8')
      const parsed = JSON.parse(raw) as { arn?: string }
      if (parsed.arn) return parsed.arn
    } catch {
      // Missing or malformed — try the next candidate.
    }
  }
  return undefined
}

/**
 * Scans ~/.aws/sso/cache for a Kiro credential file and returns the first entry
 * that carries a refresh token. Returns null when nothing usable is found.
 */
export async function readKiroSsoCache(): Promise<KiroTokens | null> {
  let files: string[]
  try {
    files = await readdir(ssoCacheDir())
  } catch {
    return null
  }
  // Prefer the Kiro IDE token file, then any other json cache entry.
  const ordered = files
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => {
      const aKiro = a.includes('kiro') ? 0 : 1
      const bKiro = b.includes('kiro') ? 0 : 1
      return aKiro - bKiro
    })

  for (const file of ordered) {
    try {
      const raw = await readFile(join(ssoCacheDir(), file), 'utf-8')
      const entry = JSON.parse(raw) as SsoCacheEntry
      if (!entry.refreshToken) continue

      // Determine auth method: prefer the explicit field, fall back to heuristic
      let clientId = entry.clientId
      let clientSecret = entry.clientSecret

      // IdC tokens may store credentials in a separate file referenced by clientIdHash
      if (entry.clientIdHash && (!clientId || !clientSecret)) {
        try {
          const clientRaw = await readFile(
            join(ssoCacheDir(), `${entry.clientIdHash}.json`),
            'utf-8',
          )
          const clientEntry = JSON.parse(clientRaw) as SsoCacheEntry
          clientId = clientId || clientEntry.clientId
          clientSecret = clientSecret || clientEntry.clientSecret
        } catch {
          // Client credential file missing or unreadable — continue with what we have.
        }
      }

      const isIdc =
        entry.authMethod === 'IdC' || Boolean(clientId && clientSecret)

      const expiresAt =
        typeof entry.expiresAt === 'number'
          ? entry.expiresAt
          : entry.expiresAt
            ? Date.parse(entry.expiresAt)
            : 0

      // profileArn priority: SSO cache entry → Kiro IDE profile.json (Enterprise).
      const profileArn =
        entry.profileArn || (isIdc ? await readKiroIdeProfileArn() : undefined)

      return {
        accessToken: entry.accessToken ?? '',
        refreshToken: entry.refreshToken,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
        authMethod: isIdc ? KIRO_AUTH_IDC : KIRO_AUTH_SOCIAL,
        clientId,
        clientSecret,
        profileArn,
      }
    } catch {
      // Ignore malformed cache files and keep scanning.
    }
  }
  return null
}

// ── Token refresh ─────────────────────────────────────────────────────────────

type RefreshOk = { accessToken: string; refreshToken?: string; expiresAt: number }

async function refreshSocial(refreshToken: string): Promise<RefreshOk> {
  const response = await fetch(KIRO_SOCIAL_REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`[kiro-auth] social refresh ${response.status}: ${text}`)
  }
  const json = (await response.json()) as {
    accessToken?: string
    refreshToken?: string
    expiresIn?: number
    expiresAt?: string | number
  }
  if (!json.accessToken) {
    throw new Error('[kiro-auth] social refresh response missing accessToken')
  }
  const expiresAt =
    typeof json.expiresAt === 'number'
      ? json.expiresAt
      : json.expiresAt
        ? Date.parse(json.expiresAt)
        : Date.now() + (json.expiresIn ?? 3600) * 1000
  return { accessToken: json.accessToken, refreshToken: json.refreshToken, expiresAt }
}

async function refreshIdC(tokens: KiroTokens): Promise<RefreshOk> {
  if (!tokens.clientId || !tokens.clientSecret) {
    throw new Error('[kiro-auth] IdC refresh requires clientId and clientSecret')
  }
  const response = await fetch(KIRO_IDC_REFRESH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-amz-user-agent': KIRO_IDC_USER_AGENT,
    },
    body: JSON.stringify({
      clientId: tokens.clientId,
      clientSecret: tokens.clientSecret,
      grantType: 'refresh_token',
      refreshToken: tokens.refreshToken,
    }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`[kiro-auth] IdC refresh ${response.status}: ${text}`)
  }
  const json = (await response.json()) as {
    accessToken?: string
    refreshToken?: string
    expiresIn?: number
  }
  if (!json.accessToken) {
    throw new Error('[kiro-auth] IdC refresh response missing accessToken')
  }
  return {
    accessToken: json.accessToken,
    refreshToken: json.refreshToken,
    expiresAt: Date.now() + (json.expiresIn ?? 3600) * 1000,
  }
}

/**
 * Refreshes the Kiro access token using the stored refresh token, dispatching
 * on the auth method. Returns a full KiroTokens with the new access token.
 */
export async function refreshKiroToken(tokens: KiroTokens): Promise<KiroTokens> {
  const result =
    tokens.authMethod === KIRO_AUTH_IDC
      ? await refreshIdC(tokens)
      : await refreshSocial(tokens.refreshToken)
  return {
    ...tokens,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken ?? tokens.refreshToken,
    expiresAt: result.expiresAt,
  }
}

// ── Full login flow ───────────────────────────────────────────────────────────

/**
 * Runs the Kiro login flow:
 * 1. Try to read a refresh token from ~/.aws/sso/cache (Kiro IDE/CLI).
 * 2. If none is found, ask the caller for a pasted refresh token (Social).
 * 3. Refresh to obtain a fresh access token.
 *
 * @param onNeedManualToken - Called when no cached token exists; should resolve
 *   with a refresh token pasted by the user (or reject/throw to cancel).
 */
export async function runKiroOAuthFlow(
  onNeedManualToken?: () => Promise<string>,
): Promise<KiroTokens> {
  logEvent('tengu_oauth_kiro_flow_start', {})
  try {
    let tokens = await readKiroSsoCache()

    if (!tokens) {
      if (!onNeedManualToken) {
        throw new Error(
          'No Kiro credentials found in ~/.aws/sso/cache. Log in with Kiro IDE/CLI first.',
        )
      }
      const pasted = (await onNeedManualToken()).trim()
      if (!pasted) {
        throw new Error('No Kiro refresh token provided.')
      }
      tokens = {
        accessToken: '',
        refreshToken: pasted,
        expiresAt: 0,
        authMethod: KIRO_AUTH_SOCIAL,
      }
    }

    const refreshed = await refreshKiroToken(tokens)
    logEvent('tengu_oauth_kiro_success', {})
    return refreshed
  } catch (err) {
    logError(err as Error)
    throw err
  }
}
