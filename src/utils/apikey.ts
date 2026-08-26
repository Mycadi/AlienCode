import { dirname, join } from 'path'
import { readFileSync } from './fileRead.js'
import { writeFileSyncAndFlush_DEPRECATED } from './file.js'
import { isENOENT } from './errors.js'
import { safeParseJSON } from './json.js'
import { logError } from './log.js'
import { jsonStringify } from './slowOperations.js'
import { getSettingsFilePathForSource } from './settings/settings.js'

const APIKEY_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const

type ApiKeyEnvKey = (typeof APIKEY_ENV_KEYS)[number]

export type ApiKeyProfile = Partial<Record<ApiKeyEnvKey, string>>

export type ApiKeyConfig = {
  // `null`/absent means no profile is active — credentials come from /login.
  current?: string | null
  profiles: Record<string, ApiKeyProfile>
}

export type ApiKeyConfigResult =
  | { ok: true; config: ApiKeyConfig; path: string }
  | { ok: false; path: string; error: string; missing?: boolean }

export type CurrentApiKeyProfileResult =
  | { ok: true; name: string; profile: ApiKeyProfile; config: ApiKeyConfig; path: string }
  | { ok: false; path: string; error: string; missing?: boolean }

export function getApiKeyFilePath(): string {
  const settingsPath = getSettingsFilePathForSource('userSettings')
  return join(dirname(settingsPath ?? ''), 'apikey.json')
}

/**
 * Models declared in apikey.json are addressed as `apikey:<profile>/<model>`
 * so they stay distinct from identically named models served by a /login
 * account (Kiro exposes `claude-opus-5` and `gpt-5.6-sol` too). The prefix is
 * stripped again in normalizeModelStringForAPI() before the request is sent.
 */
export const APIKEY_MODEL_PREFIX = 'apikey:'

export function formatApiKeyModelRef(
  profileName: string,
  model: string,
): string {
  return `${APIKEY_MODEL_PREFIX}${profileName}/${model}`
}

/**
 * Pure text split of an `apikey:<profile>/<model>` ref — no config lookup, so
 * it is safe to call from hot paths and from model display helpers.
 */
export function splitApiKeyModelRef(
  value: string | null | undefined,
): { profileName: string; model: string } | null {
  if (!value?.startsWith(APIKEY_MODEL_PREFIX)) return null
  const separator = value.indexOf('/', APIKEY_MODEL_PREFIX.length)
  if (separator === -1) return null
  const profileName = value.slice(APIKEY_MODEL_PREFIX.length, separator)
  const model = value.slice(separator + 1)
  if (!profileName || !model) return null
  return { profileName, model }
}

export function stripApiKeyModelRef(model: string): string {
  return splitApiKeyModelRef(model)?.model ?? model
}

/**
 * Resolve an `apikey:<profile>/<model>` ref against apikey.json. Profile names
 * are matched case-insensitively because model settings are lowercased by
 * parseUserSpecifiedModel().
 */
export function resolveApiKeyModelRef(
  value: string | null | undefined,
): { profileName: string; profile: ApiKeyProfile; model: string } | null {
  const ref = splitApiKeyModelRef(value)
  if (!ref) return null

  const result = readApiKeyConfig()
  if (!result.ok) return null

  const target = ref.profileName.toLowerCase()
  const entry = Object.entries(result.config.profiles).find(
    ([name]) => name.toLowerCase() === target,
  )
  if (!entry) return null

  return { profileName: entry[0], profile: entry[1], model: ref.model }
}

const APIKEY_MODEL_ROLES: ReadonlyArray<readonly [ApiKeyEnvKey, string]> = [
  ['ANTHROPIC_MODEL', 'default'],
  ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'opus'],
  ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'sonnet'],
  ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'haiku'],
  ['CLAUDE_CODE_SUBAGENT_MODEL', 'subagent'],
]

export type ApiKeyProfileModel = {
  profileName: string
  model: string
  role: string
}

/**
 * Every model declared across all apikey.json profiles, so /model can list
 * them alongside the models of the currently logged-in account.
 */
export function listApiKeyProfileModels(): ApiKeyProfileModel[] {
  const result = readApiKeyConfig()
  if (!result.ok) return []

  const models: ApiKeyProfileModel[] = []
  const seen = new Set<string>()
  for (const [profileName, profile] of Object.entries(result.config.profiles)) {
    for (const [key, role] of APIKEY_MODEL_ROLES) {
      const model = profile[key]
      if (!model) continue
      const dedupeKey = `${profileName}/${model}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      models.push({ profileName, model, role })
    }
  }
  return models
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseProfile(value: unknown): ApiKeyProfile | null {
  if (!isStringRecord(value)) return null

  const profile: ApiKeyProfile = {}
  for (const key of APIKEY_ENV_KEYS) {
    const envValue = value[key]
    if (typeof envValue === 'string') {
      profile[key] = envValue
    }
  }
  return profile
}

function parseApiKeyConfig(value: unknown): ApiKeyConfig | null {
  if (!isStringRecord(value)) return null
  if (!isStringRecord(value.profiles)) return null

  const profiles: Record<string, ApiKeyProfile> = {}
  for (const [name, rawProfile] of Object.entries(value.profiles)) {
    const profile = parseProfile(rawProfile)
    if (profile) profiles[name] = profile
  }

  return {
    current: typeof value.current === 'string' ? value.current : undefined,
    profiles,
  }
}

export function readApiKeyConfig(): ApiKeyConfigResult {
  const path = getApiKeyFilePath()
  try {
    const content = readFileSync(path)
    const parsed = safeParseJSON(content, false)
    const config = parseApiKeyConfig(parsed)
    if (!config) {
      return { ok: false, path, error: 'Invalid apikey.json format' }
    }
    return { ok: true, config, path }
  } catch (error) {
    if (isENOENT(error)) {
      return { ok: false, path, error: 'apikey.json not found', missing: true }
    }
    logError(error)
    return { ok: false, path, error: 'Failed to read apikey.json' }
  }
}

export function getCurrentApiKeyProfile(): CurrentApiKeyProfileResult {
  const result = readApiKeyConfig()
  if (!result.ok) return result

  const { config, path } = result
  const name = config.current
  if (!name) {
    return { ok: false, path, error: 'No apikey profile is selected' }
  }

  return getApiKeyProfileFromConfig(name, config, path)
}

export function getApiKeyProfile(name: string): CurrentApiKeyProfileResult {
  const result = readApiKeyConfig()
  if (!result.ok) return result

  return getApiKeyProfileFromConfig(name, result.config, result.path)
}

function getApiKeyProfileFromConfig(
  name: string,
  config: ApiKeyConfig,
  path: string,
): CurrentApiKeyProfileResult {
  const profile = config.profiles[name]
  if (!profile) {
    return { ok: false, path, error: `Api key profile '${name}' not found` }
  }

  return { ok: true, name, profile, config, path }
}

export function setCurrentApiKeyProfile(
  name: string | null,
): CurrentApiKeyProfileResult {
  const result = readApiKeyConfig()
  if (!result.ok) return result

  if (name !== null && !result.config.profiles[name]) {
    return { ok: false, path: result.path, error: `Api key profile '${name}' not found` }
  }

  const config: ApiKeyConfig = { ...result.config, current: name }
  writeFileSyncAndFlush_DEPRECATED(
    result.path,
    `${jsonStringify(config, null, 2)}\n`,
    { encoding: 'utf8' },
  )

  return {
    ok: true,
    name: name ?? '',
    profile: name === null ? {} : config.profiles[name],
    config,
    path: result.path,
  }
}

// Name of the profile whose values are currently applied to process.env, or
// null when credentials come from /login instead.
let activeProfileName: string | null = null

export function getActiveApiKeyProfileName(): string | null {
  return activeProfileName
}

export function applyApiKeyProfileToEnv(
  profile: ApiKeyProfile,
  name: string | null,
): void {
  // Clear all apikey-related env vars first, then set new profile values.
  // This prevents stale values from a previous profile leaking into the
  // model picker and other subsystems when the new profile omits a key.
  for (const key of APIKEY_ENV_KEYS) {
    delete process.env[key]
  }
  for (const key of APIKEY_ENV_KEYS) {
    const value = profile[key]
    if (value !== undefined) {
      process.env[key] = value
    }
  }
  activeProfileName = name
}

export function applyCurrentApiKeyProfileToEnv(): void {
  const result = getCurrentApiKeyProfile()
  if (result.ok) {
    applyApiKeyProfileToEnv(result.profile, result.name)
  }
}

/**
 * The env-level model default (ANTHROPIC_MODEL), expressed as an
 * `apikey:<profile>/<model>` ref when it came from an active /apikey profile so
 * a concurrent Kiro/Codex login cannot hijack a colliding model id.
 */
export function getApiKeyEnvModelSetting(): string | undefined {
  const envModel = process.env.ANTHROPIC_MODEL
  if (!envModel) return undefined
  if (!activeProfileName || splitApiKeyModelRef(envModel)) return envModel
  return formatApiKeyModelRef(activeProfileName, envModel)
}
