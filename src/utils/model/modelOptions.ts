// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getInitialMainLoopModel } from '../../bootstrap/state.js'
import {
  getAuthTokenSource,
  hasAnthropicApiKeyAuth,
  isClaudeAISubscriber,
  isCodexSubscriber,
  isKiroSubscriber,
  isMaxSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import { getModelStrings } from './modelStrings.js'
import {
  COST_TIER_3_15,
  COST_HAIKU_45,
  formatModelPricing,
} from '../modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'
import { getAPIProvider } from './providers.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCanonicalName,
  getDefaultSonnetModel,
  getDefaultOpusModel,
  getDefaultHaikuModel,
  getMarketingNameForModel,
  getUserSpecifiedModelSetting,
  isOpus1mMergeEnabled,
  getOpus48PricingSuffix,
  type ModelSetting,
} from './model.js'
import { getGlobalConfig } from '../config.js'
import { KIRO_MODELS } from '../../services/api/kiro-fetch-adapter.js'
import {
  formatApiKeyModelRef,
  getActiveApiKeyProfileName,
  isInactiveApiKeyModelRef,
  listApiKeyProfileModels,
} from '../apikey.js'

// @[MODEL LAUNCH]: Update all the available and default model option strings below.

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
}

// @[MODEL LAUNCH]: Update or add model option functions (getSonnetXXOption, getOpusXXOption, etc.)
// with the new model's label and description. These appear in the /model picker.
function getSonnet46Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().sonnet48 : 'sonnet',
    label: 'Sonnet',
    description: `Sonnet 4.8 · Best for everyday tasks${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      'Sonnet 4.8 - best for everyday tasks. Generally recommended for most coding tasks',
  }
}

function getOpus46Option(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus48 : 'opus',
    label: 'Opus',
    description: `Opus 4.8 · Most capable for complex work${getOpus48PricingSuffix(fastMode)}`,
    descriptionForModel: 'Opus 4.8 - most capable for complex work',
  }
}

export function getSonnet46_1MOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().sonnet48 + '[1m]' : 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 4.8 for long sessions${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
    descriptionForModel:
      'Sonnet 4.8 with 1M context window - for long sessions with large codebases',
  }
}

export function getOpus46_1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus48 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.8 for long sessions${getOpus48PricingSuffix(fastMode)}`,
    descriptionForModel:
      'Opus 4.8 with 1M context window - for long sessions with large codebases',
  }
}

function getHaiku45Option(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: 'haiku',
    label: 'Haiku',
    description: `Haiku 4.5 · Fastest for quick answers${is3P ? '' : ` · ${formatModelPricing(COST_HAIKU_45)}`}`,
    descriptionForModel:
      'Haiku 4.5 - fastest for quick answers. Lower cost but less capable than Sonnet 4.6.',
  }
}

// OpenAI Codex model options
function getGpt55Option(): ModelOption {
  return {
    value: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'GPT-5.5 · Advanced reasoning and code generation',
    descriptionForModel: 'GPT-5.5 - advanced reasoning and code generation capabilities',
  }
}

function getGpt54Option(): ModelOption {
  return {
    value: 'gpt-5.4',
    label: 'GPT-5.4',
    description: 'GPT-5.4 · Advanced reasoning and code generation',
    descriptionForModel: 'GPT-5.4 - advanced reasoning and code generation capabilities',
  }
}

function getGpt53CodexOption(): ModelOption {
  return {
    value: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    description: 'GPT-5.3 Codex · Optimized for code generation and understanding',
    descriptionForModel: 'GPT-5.3 Codex - specialized for code generation and understanding',
  }
}

function getGpt54MiniOption(): ModelOption {
  return {
    value: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    description: 'GPT-5.4 Mini · Fast and efficient for simple tasks',
    descriptionForModel: 'GPT-5.4 Mini - fast and efficient for simple coding tasks',
  }
}

// Kiro (AWS CodeWhisperer) model options
function getKiroModelOptions(): ModelOption[] {
  return KIRO_MODELS.map(model => ({
    value: model.id,
    label: model.label,
    description: `${model.label} · ${model.description}`,
    descriptionForModel: `${model.label} - ${model.description}`,
  }))
}

function getAnthropicEnvModelOption(): ModelOption | undefined {  const envModel = process.env.ANTHROPIC_MODEL
  if (!envModel) return undefined

  const knownOption = getKnownModelOption(envModel)
  return {
    value: envModel,
    label: knownOption?.label ?? envModel,
    description: process.env.ANTHROPIC_BASE_URL
      ? `From ANTHROPIC_MODEL · uses ANTHROPIC_BASE_URL`
      : `From ANTHROPIC_MODEL`,
    descriptionForModel: knownOption?.descriptionForModel ?? knownOption?.description,
  }
}

function getMaxOpusOption(fastMode = false): ModelOption {
  return {
    value: 'opus',
    label: 'Opus',
    description: `Opus 4.8 · Most capable for complex work${fastMode ? getOpus48PricingSuffix(true) : ''}`,
  }
}

export function getMaxSonnet46_1MOption(): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'sonnet[1m]',
    label: 'Sonnet (1M context)',
    description: `Sonnet 4.8 with 1M context${billingInfo}${is3P ? '' : ` · ${formatModelPricing(COST_TIER_3_15)}`}`,
  }
}

export function getMaxOpus46_1MOption(fastMode = false): ModelOption {
  const billingInfo = isClaudeAISubscriber() ? ' · Billed as extra usage' : ''
  return {
    value: 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.8 with 1M context${billingInfo}${getOpus48PricingSuffix(fastMode)}`,
  }
}

function getMergedOpus1MOption(fastMode = false): ModelOption {
  const is3P = getAPIProvider() !== 'firstParty'
  return {
    value: is3P ? getModelStrings().opus48 + '[1m]' : 'opus[1m]',
    label: 'Opus (1M context)',
    description: `Opus 4.8 with 1M context · Most capable for complex work${!is3P && fastMode ? getOpus48PricingSuffix(fastMode) : ''}`,
    descriptionForModel:
      'Opus 4.8 with 1M context - most capable for complex work',
  }
}

const MaxSonnet46Option: ModelOption = {
  value: 'sonnet',
  label: 'Sonnet',
  description: 'Sonnet 4.8 · Best for everyday tasks',
}

const MaxHaiku45Option: ModelOption = {
  value: 'haiku',
  label: 'Haiku',
  description: 'Haiku 4.5 · Fastest for quick answers',
}

function getOpusPlanOption(): ModelOption {
  return {
    value: 'opusplan',
    label: 'Opus Plan Mode',
    description: 'Use Opus 4.8 in plan mode, Sonnet 4.8 otherwise',
  }
}

// @[MODEL LAUNCH]: Update the model picker lists below to include/reorder options for the new model.
// Each user tier (ant, Max/Team Premium, Pro/Team Standard/Enterprise, PAYG 1P, PAYG 3P) has its own list.
function getModelOptionsBase(fastMode = false): ModelOption[] {
  if (process.env.USER_TYPE === 'ant') {
    // Build options from antModels config
    const antModelOptions: ModelOption[] = getAntModels().map(m => ({
      value: m.alias,
      label: m.label,
      description: m.description ?? `[ANT-ONLY] ${m.label} (${m.model})`,
    }))

    return [
      ...antModelOptions,
      getMergedOpus1MOption(fastMode),
      getSonnet46Option(),
      getSonnet46_1MOption(),
      getHaiku45Option(),
    ]
  }

  // Codex subscribers get OpenAI model options
  if (isCodexSubscriber()) {
    return [
      getGpt55Option(),
      getGpt54Option(),
      getGpt53CodexOption(),
      getGpt54MiniOption(),
    ]
  }

  // Kiro subscribers get Kiro (Claude/GPT via CodeWhisperer) model options
  if (isKiroSubscriber()) {
    return getKiroModelOptions()
  }

  if (isClaudeAISubscriber()) {
    if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
      // Max and Team Premium users: Opus first, Sonnet as alternative
      const premiumOptions = isOpus1mMergeEnabled()
        ? [getMergedOpus1MOption(fastMode)]
        : [getMaxOpusOption(fastMode)]
      if (!isOpus1mMergeEnabled() && checkOpus1mAccess()) {
        premiumOptions.push(getMaxOpus46_1MOption(fastMode))
      }

      premiumOptions.push(MaxSonnet46Option)
      if (checkSonnet1mAccess()) {
        premiumOptions.push(getMaxSonnet46_1MOption())
      }

      premiumOptions.push(MaxHaiku45Option)
      return premiumOptions
    }

    // Pro/Team Standard/Enterprise users: Sonnet first, Opus as alternative
    const standardOptions = [MaxSonnet46Option]
    if (checkSonnet1mAccess()) {
      standardOptions.push(getMaxSonnet46_1MOption())
    }

    if (isOpus1mMergeEnabled()) {
      standardOptions.push(getMergedOpus1MOption(fastMode))
    } else {
      standardOptions.push(getMaxOpusOption(fastMode))
      if (checkOpus1mAccess()) {
        standardOptions.push(getMaxOpus46_1MOption(fastMode))
      }
    }

    standardOptions.push(MaxHaiku45Option)
    return standardOptions
  }

  // No account, no API key, no apikey.json profile: nothing to run on, so
  // offer no models at all.
  if (!hasUsableCredential()) {
    return []
  }

  // API key / 3P provider users: list the concrete models directly.
  // getModelOptions() will still append apikey/env/custom model options below.
  return [getSonnet46Option(), getOpus46Option(fastMode), getHaiku45Option()]
}

/**
 * Whether any credential is available for the default model to run on:
 * a 3P/OAuth provider, an apikey.json profile, an API key, or an auth token.
 */
function hasUsableCredential(): boolean {
  if (getAPIProvider() !== 'firstParty') return true
  if (getActiveApiKeyProfileName()) return true
  if (hasAnthropicApiKeyAuth()) return true
  return getAuthTokenSource().hasToken
}

// @[MODEL LAUNCH]: Add the new model ID to the appropriate family pattern below
// so the "newer version available" hint works correctly.
/**
 * Map a full model name to its family alias and the marketing name of the
 * version the alias currently resolves to. Used to detect when a user has
 * a specific older version pinned and a newer one is available.
 */
function getModelFamilyInfo(
  model: string,
): { alias: string; currentVersionName: string } | null {
  const canonical = getCanonicalName(model)

  // Sonnet family
  if (
    canonical.includes('claude-sonnet-4-8') ||
    canonical.includes('claude-sonnet-4-7') ||
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-sonnet-4-') ||
    canonical.includes('claude-3-7-sonnet') ||
    canonical.includes('claude-3-5-sonnet')
  ) {
    const currentName = getMarketingNameForModel(getDefaultSonnetModel())
    if (currentName) {
      return { alias: 'Sonnet', currentVersionName: currentName }
    }
  }

  // Opus family
  if (canonical.includes('claude-opus-4')) {
    const currentName = getMarketingNameForModel(getDefaultOpusModel())
    if (currentName) {
      return { alias: 'Opus', currentVersionName: currentName }
    }
  }

  // Haiku family
  if (
    canonical.includes('claude-haiku') ||
    canonical.includes('claude-3-5-haiku')
  ) {
    const currentName = getMarketingNameForModel(getDefaultHaikuModel())
    if (currentName) {
      return { alias: 'Haiku', currentVersionName: currentName }
    }
  }

  return null
}

/**
 * Returns a ModelOption for a known Anthropic model with a human-readable
 * label, and an upgrade hint if a newer version is available via the alias.
 * Returns null if the model is not recognized.
 */
function getKnownModelOption(model: string): ModelOption | null {
  const marketingName = getMarketingNameForModel(model)
  if (!marketingName) return null

  const familyInfo = getModelFamilyInfo(model)
  if (!familyInfo) {
    return {
      value: model,
      label: marketingName,
      description: model,
    }
  }

  // Check if the alias currently resolves to a different (newer) version
  if (marketingName !== familyInfo.currentVersionName) {
    return {
      value: model,
      label: marketingName,
      description: `Newer version available · select ${familyInfo.alias} for ${familyInfo.currentVersionName}`,
    }
  }

  // Same version as the alias — just show the friendly name
  return {
    value: model,
    label: marketingName,
    description: model,
  }
}

export function getModelOptions(fastMode = false): ModelOption[] {
  const options = getModelOptionsBase(fastMode)

  // Models declared in apikey.json, addressed as `apikey:<profile>/<model>` so
  // they coexist with identically named models served by the logged-in account
  // (Kiro also offers claude-opus-5 and gpt-5.6-sol).
  for (const { profileName, model, role } of listApiKeyProfileModels()) {
    const value = formatApiKeyModelRef(profileName, model)
    if (options.some(existing => existing.value === value)) continue
    options.push({
      value,
      label: `${model} (${profileName})`,
      description: `apikey.json · ${profileName} · ${role}`,
      descriptionForModel: `${model} via apikey profile ${profileName}`,
    })
  }

  // ANTHROPIC_MODEL set outside apikey.json (shell env or settings.env);
  // apikey profile models are already listed above.
  const anthropicEnvModel = getActiveApiKeyProfileName()
    ? undefined
    : getAnthropicEnvModelOption()
  if (
    anthropicEnvModel !== undefined &&
    !options.some(existing => existing.value === anthropicEnvModel.value)
  ) {
    options.push(anthropicEnvModel)
  }

  // Add the custom model from the ANTHROPIC_CUSTOM_MODEL_OPTION env var
  const envCustomModel = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  if (
    envCustomModel &&
    !options.some(existing => existing.value === envCustomModel)
  ) {
    options.push({
      value: envCustomModel,
      label: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME ?? envCustomModel,
      description:
        process.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION ??
        `Custom model (${envCustomModel})`,
    })
  }

  // Append additional model options fetched during bootstrap
  for (const opt of getGlobalConfig().additionalModelOptionsCache ?? []) {
    if (!options.some(existing => existing.value === opt.value)) {
      options.push(opt)
    }
  }

  // Add custom model from either the current model value or the initial one
  // if it is not already in the options. An `apikey:` ref left over from a
  // profile that /apikey has since switched away from is dropped instead.
  let customModel: ModelSetting = null
  const currentMainLoopModel = getUserSpecifiedModelSetting()
  const initialMainLoopModel = getInitialMainLoopModel()
  if (currentMainLoopModel !== undefined && currentMainLoopModel !== null) {
    customModel = currentMainLoopModel
  } else if (initialMainLoopModel !== null) {
    customModel = initialMainLoopModel
  }
  if (
    customModel === null ||
    isInactiveApiKeyModelRef(customModel) ||
    options.some(opt => opt.value === customModel)
  ) {
    return filterModelOptionsByAllowlist(options)
  } else if (customModel === 'opusplan') {
    return filterModelOptionsByAllowlist([...options, getOpusPlanOption()])
  } else if (customModel === 'opus' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMaxOpusOption(fastMode),
    ])
  } else if (customModel === 'opus[1m]' && getAPIProvider() === 'firstParty') {
    return filterModelOptionsByAllowlist([
      ...options,
      getMergedOpus1MOption(fastMode),
    ])
  } else {
    // Try to show a human-readable label for known Anthropic models, with an
    // upgrade hint if the alias now resolves to a newer version.
    const knownOption = getKnownModelOption(customModel)
    if (knownOption) {
      options.push(knownOption)
    } else {
      options.push({
        value: customModel,
        label: customModel,
        description: 'Custom model',
      })
    }
    return filterModelOptionsByAllowlist(options)
  }
}

/**
 * Filter model options by the availableModels allowlist.
 * Always preserves the "Default" option (value: null).
 */
function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  return settings.availableModels
    ? options.filter(
        opt =>
          opt.value === null || (opt.value !== null && isModelAllowed(opt.value)),
      )
    : options
}
