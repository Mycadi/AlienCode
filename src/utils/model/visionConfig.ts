import { join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { isENOENT } from '../errors.js'
import { readFileSync } from '../fileRead.js'
import { safeParseJSON } from '../json.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'

export type VisionProxyMode = 'auto' | 'always' | 'never'

export type VisionRule = {
  match: string | string[]
  proxyMode?: VisionProxyMode
  visionModel?: string
  apiKeyProfile?: string
  prompt?: string
}

export type VisionConfig = {
  enabled?: boolean
  defaultVisionModel?: string
  apiKeyProfile?: string
  defaultPrompt?: string
  proxyMode?: VisionProxyMode
  rules?: VisionRule[]
}

export type ResolvedVisionConfig = {
  enabled: boolean
  proxyMode: VisionProxyMode
  visionModel?: string
  apiKeyProfile?: string
  prompt?: string
}

export function resolveVisionConfigForModel(model: string): ResolvedVisionConfig {
  const config = getVisionConfig()
  const rule = config.rules?.find(r => matchesRule(model, r))

  return {
    enabled: config.enabled !== false,
    proxyMode: rule?.proxyMode ?? config.proxyMode ?? 'never',
    visionModel: rule?.visionModel ?? config.defaultVisionModel,
    apiKeyProfile: rule?.apiKeyProfile ?? config.apiKeyProfile,
    prompt: rule?.prompt ?? config.defaultPrompt,
  }
}

function getVisionConfig(): VisionConfig {
  const settingsVision = getSettingsVisionConfig()
  const userVision = readVisionConfig(join(getClaudeConfigHomeDir(), 'vision.json'))
  const projectVision = readVisionConfig(
    join(getOriginalCwd(), '.claude', 'vision.json'),
  )

  return mergeVisionConfigs(settingsVision, userVision, projectVision)
}

function getSettingsVisionConfig(): VisionConfig {
  const vision = getSettings_DEPRECATED().vision
  if (!vision) return {}
  return {
    enabled: vision.enabled,
    defaultVisionModel: vision.model,
    apiKeyProfile: vision.apiKeyProfile,
    defaultPrompt: vision.prompt,
    proxyMode: vision.proxyMode,
  }
}

function readVisionConfig(path: string): VisionConfig {
  try {
    return normalizeVisionConfig(safeParseJSON(readFileSync(path), false))
  } catch (error) {
    if (isENOENT(error)) return {}
    return {}
  }
}

function mergeVisionConfigs(...configs: VisionConfig[]): VisionConfig {
  const [settingsVision, userVision, projectVision] = configs
  return {
    enabled:
      projectVision.enabled ?? userVision.enabled ?? settingsVision.enabled,
    defaultVisionModel:
      projectVision.defaultVisionModel ??
      userVision.defaultVisionModel ??
      settingsVision.defaultVisionModel,
    apiKeyProfile:
      projectVision.apiKeyProfile ??
      userVision.apiKeyProfile ??
      settingsVision.apiKeyProfile,
    defaultPrompt:
      projectVision.defaultPrompt ??
      userVision.defaultPrompt ??
      settingsVision.defaultPrompt,
    proxyMode:
      projectVision.proxyMode ?? userVision.proxyMode ?? settingsVision.proxyMode,
    rules: [
      ...(projectVision.rules ?? []),
      ...(userVision.rules ?? []),
      ...(settingsVision.rules ?? []),
    ],
  }
}

function normalizeVisionConfig(value: unknown): VisionConfig {
  if (!isRecord(value)) return {}
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    defaultVisionModel:
      typeof value.defaultVisionModel === 'string'
        ? value.defaultVisionModel
        : typeof value.model === 'string'
          ? value.model
          : undefined,
    apiKeyProfile:
      typeof value.apiKeyProfile === 'string' ? value.apiKeyProfile : undefined,
    defaultPrompt:
      typeof value.defaultPrompt === 'string'
        ? value.defaultPrompt
        : typeof value.prompt === 'string'
          ? value.prompt
          : undefined,
    proxyMode: normalizeProxyMode(value.proxyMode),
    rules: Array.isArray(value.rules)
      ? value.rules.map(normalizeVisionRule).filter(isVisionRule)
      : undefined,
  }
}

function normalizeVisionRule(value: unknown): VisionRule | null {
  if (!isRecord(value)) return null
  const match = normalizeMatch(value.match)
  if (!match) return null
  return {
    match,
    proxyMode: normalizeProxyMode(value.proxyMode),
    visionModel:
      typeof value.visionModel === 'string'
        ? value.visionModel
        : typeof value.model === 'string'
          ? value.model
          : undefined,
    apiKeyProfile:
      typeof value.apiKeyProfile === 'string' ? value.apiKeyProfile : undefined,
    prompt: typeof value.prompt === 'string' ? value.prompt : undefined,
  }
}

function normalizeMatch(value: unknown): string | string[] | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const matches = value.filter((item): item is string => typeof item === 'string')
    return matches.length > 0 ? matches : null
  }
  return null
}

function normalizeProxyMode(value: unknown): VisionProxyMode | undefined {
  return value === 'auto' || value === 'always' || value === 'never'
    ? value
    : undefined
}

function matchesRule(model: string, rule: VisionRule): boolean {
  const patterns = Array.isArray(rule.match) ? rule.match : [rule.match]
  return patterns.some(pattern => wildcardMatch(model, pattern))
}

function wildcardMatch(value: string, pattern: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')}$`,
    'i',
  )
  return regex.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isVisionRule(rule: VisionRule | null): rule is VisionRule {
  return rule !== null
}
