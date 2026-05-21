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
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const

type ApiKeyEnvKey = (typeof APIKEY_ENV_KEYS)[number]

export type ApiKeyProfile = Partial<Record<ApiKeyEnvKey, string>>

export type ApiKeyConfig = {
  current?: string
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
  const names = Object.keys(config.profiles)
  const name = config.current ?? names[0]
  if (!name) {
    return { ok: false, path, error: 'No apikey profiles found' }
  }

  const profile = config.profiles[name]
  if (!profile) {
    return { ok: false, path, error: `Api key profile '${name}' not found` }
  }

  return { ok: true, name, profile, config, path }
}

export function setCurrentApiKeyProfile(name: string): CurrentApiKeyProfileResult {
  const result = readApiKeyConfig()
  if (!result.ok) return result

  if (!result.config.profiles[name]) {
    return { ok: false, path: result.path, error: `Api key profile '${name}' not found` }
  }

  const config = { ...result.config, current: name }
  writeFileSyncAndFlush_DEPRECATED(
    result.path,
    `${jsonStringify(config, null, 2)}\n`,
    { encoding: 'utf8' },
  )

  return {
    ok: true,
    name,
    profile: config.profiles[name],
    config,
    path: result.path,
  }
}

export function applyApiKeyProfileToEnv(profile: ApiKeyProfile): void {
  for (const key of APIKEY_ENV_KEYS) {
    const value = profile[key]
    if (value !== undefined) {
      process.env[key] = value
    }
  }
}

export function applyCurrentApiKeyProfileToEnv(): void {
  const result = getCurrentApiKeyProfile()
  if (result.ok) {
    applyApiKeyProfileToEnv(result.profile)
  }
}
