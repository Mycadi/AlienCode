// Loop state management — module-level singleton (same pattern as goalState.ts)

export interface LoopState {
  taskText: string
  intervalMinutes: number // interval between iterations
  iterationsCompleted: number
  startTime: number // Date.now()
  isStopped: boolean
  stopReason?: 'user_stopped' | 'work_done'
}

let currentLoop: LoopState | null = null
// Timer handle for the interval wait between iterations
let intervalTimer: ReturnType<typeof setTimeout> | null = null
// Callback to trigger the next iteration (set by REPL)
let nextIterationCallback: (() => void) | null = null

export function setLoop(taskText: string, intervalMinutes: number): LoopState {
  clearIntervalTimer()
  currentLoop = {
    taskText,
    intervalMinutes,
    iterationsCompleted: 0,
    startTime: Date.now(),
    isStopped: false,
  }
  return currentLoop
}

export function getLoop(): LoopState | null {
  return currentLoop
}

export function clearLoop(): void {
  clearIntervalTimer()
  currentLoop = null
  nextIterationCallback = null
}

export function incrementIteration(): LoopState {
  if (!currentLoop) throw new Error('No active loop')
  currentLoop = {
    ...currentLoop,
    iterationsCompleted: currentLoop.iterationsCompleted + 1,
  }
  return currentLoop
}

export function markLoopStopped(
  reason: 'user_stopped' | 'work_done',
): LoopState {
  if (!currentLoop) throw new Error('No active loop')
  clearIntervalTimer()
  currentLoop = { ...currentLoop, isStopped: true, stopReason: reason }
  return currentLoop
}

/**
 * Schedule the next iteration after the configured interval.
 * Calls the registered callback when the interval elapses.
 */
export function scheduleNextIteration(callback: () => void): void {
  if (!currentLoop || currentLoop.isStopped) return
  clearIntervalTimer()
  nextIterationCallback = callback
  intervalTimer = setTimeout(() => {
    intervalTimer = null
    if (currentLoop && !currentLoop.isStopped && nextIterationCallback) {
      nextIterationCallback()
    }
  }, currentLoop.intervalMinutes * 60_000)
}

export function clearIntervalTimer(): void {
  if (intervalTimer !== null) {
    clearTimeout(intervalTimer)
    intervalTimer = null
  }
}

/**
 * Restore a loop from session log (on resume). Resets iterationsCompleted and startTime.
 */
export function restoreLoop(
  taskText: string,
  intervalMinutes: number,
): LoopState {
  return setLoop(taskText, intervalMinutes)
}

export function _resetForTesting(): void {
  clearLoop()
}
