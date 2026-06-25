import type { Command } from '../../commands.js'

const loop = {
  type: 'local',
  name: 'loop',
  description:
    'Run a task on a repeating interval until stopped or work is done',
  argumentHint: '<task>[, every <N> minutes]',
  supportsNonInteractive: true,
  load: () => import('./loop.js'),
} satisfies Command

export default loop
