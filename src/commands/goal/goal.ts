import type { LocalCommandResult } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'
import { saveGoal, clearSavedGoal } from '../../utils/sessionStorage.js'
import { setGoal, getGoal, clearGoal } from './goalState.js'
import type { UUID } from 'crypto'

/**
 * Parse goal text and optional limit constraints.
 *
 * Supports formats:
 *   "fix checkout tests, or stop after 10 turns"
 *   "complete the migration, or stop after 30 minutes"
 *   "fix checkout tests"  (no limit)
 *   "off" / "clear"       (cancel active goal)
 */
export function parseGoalArgs(args: string): {
  goalText: string
  maxTurns?: number
  maxMinutes?: number
} | null {
  const trimmed = args.trim()
  if (!trimmed) return null

  // Match ", or stop after <N> turns|minutes"
  const limitPattern =
    /[,，]\s*(?:or\s+)?stop\s+after\s+(\d+)\s+(turns?|minutes?)\s*$/i
  const match = trimmed.match(limitPattern)

  if (match) {
    const value = parseInt(match[1]!, 10)
    const unit = match[2]!.toLowerCase()
    const goalText = trimmed.slice(0, match.index!).trim()
    if (unit.startsWith('turn')) {
      return { goalText, maxTurns: value }
    }
    return { goalText, maxMinutes: value }
  }

  return { goalText: trimmed }
}

function formatLimits(maxTurns?: number, maxMinutes?: number): string {
  const parts: string[] = []
  if (maxTurns !== undefined) parts.push(`${maxTurns} turns`)
  if (maxMinutes !== undefined) parts.push(`${maxMinutes} minutes`)
  return parts.length > 0 ? ` (limit: ${parts.join(', ')})` : ''
}

export async function call(args: string): Promise<LocalCommandResult> {
  const trimmed = args.trim().toLowerCase()

  // Cancel active goal
  if (trimmed === 'off' || trimmed === 'stop' || trimmed === 'clear' || trimmed === 'cancel') {
    const existing = getGoal()
    if (existing) {
      clearGoal()
      clearSavedGoal(getSessionId() as UUID)
      return { type: 'text', value: 'Goal cleared.' }
    }
    return { type: 'text', value: 'No active goal.' }
  }

  // Show current goal
  if (!args.trim()) {
    const existing = getGoal()
    if (existing) {
      const limits = formatLimits(existing.maxTurns, existing.maxMinutes)
      const elapsed = `${existing.turnsElapsed} turns elapsed`
      return {
        type: 'text',
        value: `Active goal: ${existing.goalText}${limits}\n${elapsed}`,
      }
    }
    return {
      type: 'text',
      value: 'No active goal. Usage: /goal <description>[, or stop after <N> turns|minutes]',
    }
  }

  // Parse and set new goal
  const parsed = parseGoalArgs(args)
  if (!parsed) {
    return { type: 'text', value: 'Could not parse goal. Usage: /goal <description>[, or stop after <N> turns|minutes]' }
  }

  setGoal(parsed.goalText, {
    maxTurns: parsed.maxTurns,
    maxMinutes: parsed.maxMinutes,
  })

  saveGoal(
    getSessionId() as UUID,
    parsed.goalText,
    parsed.maxTurns,
    parsed.maxMinutes,
  )

  const limits = formatLimits(parsed.maxTurns, parsed.maxMinutes)
  return {
    type: 'autostart',
    value: `Goal set: ${parsed.goalText}${limits}`,
    promptText: parsed.goalText,
  }
}
