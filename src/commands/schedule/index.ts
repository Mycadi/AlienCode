import type { Command } from '../../commands.js'

const schedule = {
  type: 'local',
  name: 'schedule',
  description:
    'Create, list, or delete persistent scheduled tasks (cron)',
  argumentHint: '"<cron>" <prompt> | list | delete <id>',
  load: () => import('./schedule.js'),
} satisfies Command

export default schedule
