import type { LocalCommandResult } from '../../types/command.js'
import { setScheduledTasksEnabled } from '../../bootstrap/state.js'
import { parseCronExpression, cronToHuman } from '../../utils/cron.js'
import {
  addCronTask,
  listAllCronTasks,
  nextCronRunMs,
  removeCronTasks,
} from '../../utils/cronTasks.js'
import { truncate } from '../../utils/truncate.js'

const HELP_TEXT = `Usage:
  /schedule "<cron>" <prompt>          — Create a recurring scheduled task
  /schedule once "<cron>" <prompt>     — Create a one-shot scheduled task
  /schedule list                       — List all scheduled tasks
  /schedule delete <id>                — Delete a scheduled task by ID

Examples:
  /schedule "0 2 * * *" run full test suite
  /schedule "0 9 * * 1-5" review open issues
  /schedule "0 0 * * 0" scan for dead code
  /schedule once "30 14 25 6 *" remind me to deploy

Cron format: minute hour day-of-month month day-of-week (local time)
Tasks persist to .claude/scheduled_tasks.json and survive restarts.`

/**
 * Parse a cron expression wrapped in quotes from the args string.
 * Returns the cron expression and the remaining text (prompt).
 *
 * Supports: "0 2 * * *" run tests
 */
function parseCronAndPrompt(args: string): {
  cron: string
  prompt: string
} | null {
  const trimmed = args.trim()

  // Match quoted cron expression (double or single quotes)
  const match = trimmed.match(/^(["'])(.+?)\1\s+(.+)$/s)
  if (!match) return null

  const cron = match[2]!.trim()
  const prompt = match[3]!.trim()
  if (!cron || !prompt) return null

  return { cron, prompt }
}

export async function call(args: string): Promise<LocalCommandResult> {
  const trimmed = args.trim()

  // No args → help
  if (!trimmed) {
    return { type: 'text', value: HELP_TEXT }
  }

  // /schedule list
  if (trimmed.toLowerCase() === 'list') {
    const tasks = await listAllCronTasks()
    if (tasks.length === 0) {
      return { type: 'text', value: 'No scheduled tasks.' }
    }
    const lines = tasks.map(t => {
      const schedule = cronToHuman(t.cron)
      const type = t.recurring ? 'recurring' : 'one-shot'
      const durability =
        t.durable === false ? ' [session-only]' : ''
      const promptPreview = truncate(t.prompt, 60, true)
      return `  ${t.id}  ${schedule} (${type})${durability}\n         ${promptPreview}`
    })
    return {
      type: 'text',
      value: `Scheduled tasks (${tasks.length}):\n\n${lines.join('\n\n')}`,
    }
  }

  // /schedule delete <id>
  if (trimmed.toLowerCase().startsWith('delete ')) {
    const id = trimmed.slice('delete '.length).trim()
    if (!id) {
      return { type: 'text', value: 'Usage: /schedule delete <id>' }
    }
    const tasks = await listAllCronTasks()
    const task = tasks.find(t => t.id === id)
    if (!task) {
      return {
        type: 'text',
        value: `No scheduled task with id '${id}'.`,
      }
    }
    await removeCronTasks([id])
    return {
      type: 'text',
      value: `Deleted task ${id} (${cronToHuman(task.cron)}).`,
    }
  }

  // /schedule once "<cron>" <prompt>
  let recurring = true
  let createArgs = trimmed
  if (trimmed.toLowerCase().startsWith('once ')) {
    recurring = false
    createArgs = trimmed.slice('once '.length).trim()
  }

  // /schedule "<cron>" <prompt>
  const parsed = parseCronAndPrompt(createArgs)
  if (!parsed) {
    return {
      type: 'text',
      value:
        'Could not parse. Usage: /schedule "<cron>" <prompt>\n\n' + HELP_TEXT,
    }
  }

  // Validate cron expression
  if (!parseCronExpression(parsed.cron)) {
    return {
      type: 'text',
      value: `Invalid cron expression '${parsed.cron}'.\nExpected 5 fields: minute hour day-of-month month day-of-week`,
    }
  }

  // Check next fire time
  const nextFire = nextCronRunMs(parsed.cron, Date.now())
  if (nextFire === null) {
    return {
      type: 'text',
      value: `Cron '${parsed.cron}' does not match any date in the next year.`,
    }
  }

  // Create the task (always durable)
  const id = await addCronTask(parsed.cron, parsed.prompt, recurring, true)
  setScheduledTasksEnabled(true)

  const type = recurring ? 'Recurring' : 'One-shot'
  const nextDate = new Date(nextFire).toLocaleString()
  return {
    type: 'text',
    value: `${type} task created: ${id}\n  Schedule: ${cronToHuman(parsed.cron)}\n  Next fire: ${nextDate}\n  Prompt: ${parsed.prompt}`,
  }
}
