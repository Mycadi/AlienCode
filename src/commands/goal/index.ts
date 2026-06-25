import type { Command } from '../../commands.js'

const goal = {
  type: 'local',
  name: 'goal',
  description:
    'Set a goal for Claude to work toward with optional limits (turns/minutes)',
  argumentHint: '<goal>[, or stop after <N> turns|minutes]',
  supportsNonInteractive: true,
  load: () => import('./goal.js'),
} satisfies Command

export default goal
