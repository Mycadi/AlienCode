import { get3PModelCapabilityOverride } from './modelSupportOverrides.js'
import { resolveOverriddenModel } from './modelStrings.js'

export function modelSupportsVision(model: string): boolean {
  const override = get3PModelCapabilityOverride(model, 'vision')
  if (override !== undefined) {
    return override
  }

  const normalized = resolveOverriddenModel(model).toLowerCase()
  return normalized.includes('claude-')
}
