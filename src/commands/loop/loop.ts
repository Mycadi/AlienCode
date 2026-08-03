import type { LocalCommandResult } from '../../types/command.js'
import { getSessionId } from '../../bootstrap/state.js'
import { saveLoop, clearSavedLoop } from '../../utils/sessionStorage.js'
import { setLoop, getLoop, clearLoop, markLoopStopped } from './loopState.js'
import type { UUID } from 'crypto'

/**
 * Parse loop arguments.
 *
 * Supports formats:
 *   "refactor auth module every 5 minutes"
 *   "check build status every 2 minutes"
 *   "refactor auth module"  (default: 5 minutes)
 *   "off" / "stop" / "clear"  (cancel active loop)
 */
export function parseLoopArgs(args: string): {
  taskText: string
  intervalMinutes: number
} | null {
  const trimmed = args.trim()
  if (!trimmed) return null

  // Match "every <N> minutes" at the end
  const intervalPattern = /[,，]?\s*every\s+(\d+)\s+minutes?\s*$/i
  const match = trimmed.match(intervalPattern)

  if (match) {
    const interval = parseInt(match[1]!, 10)
    const taskText = trimmed.slice(0, match.index!).trim()
    return { taskText, intervalMinutes: Math.max(1, interval) }
  }

  // Default interval: 5 minutes
  return { taskText: trimmed, intervalMinutes: 5 }
}

export async function call(args: string): Promise<LocalCommandResult> {
  const trimmed = args.trim().toLowerCase()

  // Cancel active loop
  if (
    trimmed === 'off' ||
    trimmed === 'stop' ||
    trimmed === 'clear' ||
    trimmed === 'cancel'
  ) {
    const existing = getLoop()
    if (existing) {
      markLoopStopped('user_stopped')
      clearLoop()
      clearSavedLoop(getSessionId() as UUID)
      return { type: 'text', value: 'Loop stopped.' }
    }
    return { type: 'text', value: 'No active loop.' }
  }

  // Show current loop
  if (!args.trim()) {
    const existing = getLoop()
    if (existing) {
      const elapsed = Math.round((Date.now() - existing.startTime) / 60_000)
      return {
        type: 'text',
        value: `Active loop: ${existing.taskText}\nInterval: every ${existing.intervalMinutes} min | Iterations: ${existing.iterationsCompleted} | Running for ${elapsed} min`,
      }
    }
    return {
      type: 'text',
      value:
        'No active loop. Usage: /loop <task description>[, every <N> minutes]',
    }
  }

  // Parse and set new loop
  const parsed = parseLoopArgs(args)
  if (!parsed) {
    return {
      type: 'text',
      value:
        'Could not parse loop. Usage: /loop <task description>[, every <N> minutes]',
    }
  }

  setLoop(parsed.taskText, parsed.intervalMinutes)

  saveLoop(
    getSessionId() as UUID,
    parsed.taskText,
    parsed.intervalMinutes,
  )

  return {
    type: 'autostart',
    value: `Loop started: ${parsed.taskText} (every ${parsed.intervalMinutes} min)`,
    promptText: parsed.taskText,
  }
}
