// Goal state management — module-level singleton (same pattern as autoModeState.ts)

export interface GoalState {
  goalText: string
  maxTurns?: number
  maxMinutes?: number
  startTime: number // Date.now()
  turnsElapsed: number
  isCompleted: boolean
  completionReason?: 'goal_met' | 'turn_limit' | 'time_limit'
}

let currentGoal: GoalState | null = null

export function setGoal(
  goalText: string,
  limits?: { maxTurns?: number; maxMinutes?: number },
): GoalState {
  currentGoal = {
    goalText,
    maxTurns: limits?.maxTurns,
    maxMinutes: limits?.maxMinutes,
    startTime: Date.now(),
    turnsElapsed: 0,
    isCompleted: false,
  }
  return currentGoal
}

export function getGoal(): GoalState | null {
  return currentGoal
}

export function clearGoal(): void {
  currentGoal = null
}

export function incrementTurn(): GoalState {
  if (!currentGoal) throw new Error('No active goal')
  currentGoal = { ...currentGoal, turnsElapsed: currentGoal.turnsElapsed + 1 }
  return currentGoal
}

export function markGoalComplete(
  reason: 'goal_met' | 'turn_limit' | 'time_limit',
): GoalState {
  if (!currentGoal) throw new Error('No active goal')
  currentGoal = { ...currentGoal, isCompleted: true, completionReason: reason }
  return currentGoal
}

export function isLimitReached(): {
  reached: boolean
  reason: 'turn_limit' | 'time_limit'
} | null {
  if (!currentGoal) return null

  if (
    currentGoal.maxTurns !== undefined &&
    currentGoal.turnsElapsed >= currentGoal.maxTurns
  ) {
    return { reached: true, reason: 'turn_limit' }
  }

  if (currentGoal.maxMinutes !== undefined) {
    const elapsedMinutes = (Date.now() - currentGoal.startTime) / 60_000
    if (elapsedMinutes >= currentGoal.maxMinutes) {
      return { reached: true, reason: 'time_limit' }
    }
  }

  return null
}

/**
 * Restore a goal from session log (on resume). Resets turnsElapsed and startTime.
 */
export function restoreGoal(
  goalText: string,
  limits?: { maxTurns?: number; maxMinutes?: number },
): GoalState {
  return setGoal(goalText, limits)
}

export function _resetForTesting(): void {
  currentGoal = null
}
