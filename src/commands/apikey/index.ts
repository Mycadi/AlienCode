import type { Command } from '../../commands.js'
import { getCurrentApiKeyProfile } from '../../utils/apikey.js'

export default {
  type: 'local-jsx',
  name: 'apikey',
  get description() {
    const current = getCurrentApiKeyProfile()
    return current.ok
      ? `Switch Anthropic API key profile (currently ${current.name})`
      : 'Switch Anthropic API key profile'
  },
  argumentHint: '[profile]',
  isSensitive: true,
  load: () => import('./apikey.js'),
} satisfies Command
