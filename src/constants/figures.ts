import { env } from '../utils/env.js'

const isNui = !!process.env.CLAUDE_CODE_NUI

// The former is better vertically aligned, but isn't usually supported on Windows/Linux
export const BLACK_CIRCLE = isNui ? '*' : (env.platform === 'darwin' ? '⏺' : '●')
export const BULLET_OPERATOR = '∙'
export const TEARDROP_ASTERISK = isNui ? '*' : '✻'
export const UP_ARROW = '\u2191' // ↑ - used for opus 1m merge notice
export const DOWN_ARROW = '\u2193' // ↓ - used for scroll hint
export const LIGHTNING_BOLT = isNui ? '~' : '↯' // used for fast mode indicator
export const EFFORT_LOW = isNui ? 'o' : '○' // effort level: low
export const EFFORT_MEDIUM = isNui ? 'o' : '◐' // effort level: medium
export const EFFORT_HIGH = isNui ? 'o' : '●' // effort level: high
export const EFFORT_MAX = isNui ? 'o' : '◉' // effort level: max (Opus 4.8 only)

// Media/trigger status indicators
export const PLAY_ICON = isNui ? '>' : '\u25b6' // ▶
export const PAUSE_ICON = isNui ? '||' : '\u23f8' // ⏸

// MCP subscription indicators
export const REFRESH_ARROW = isNui ? '~' : '\u21bb' // ↻ - used for resource update indicator
export const CHANNEL_ARROW = isNui ? '<' : '\u2190' // ← - inbound channel message indicator
export const INJECTED_ARROW = isNui ? '>' : '\u2192' // → - cross-session injected message indicator
export const FORK_GLYPH = isNui ? 'Y' : '\u2442' // ⑂ - fork directive indicator

// Review status indicators (ultrareview diamond states)
export const DIAMOND_OPEN = isNui ? '<>' : '\u25c7' // ◇ - running
export const DIAMOND_FILLED = isNui ? '<>' : '\u25c6' // ◆ - completed/failed
export const REFERENCE_MARK = isNui ? '*' : '\u203b' // ※ - komejirushi, away-summary recap marker

// Issue flag indicator
export const FLAG_ICON = isNui ? '!' : '\u2691' // ⚑ - used for issue flag banner

// Blockquote indicator
export const BLOCKQUOTE_BAR = isNui ? '|' : '\u258e' // ▎ - left one-quarter block, used as blockquote line prefix
export const HEAVY_HORIZONTAL = isNui ? '-' : '\u2501' // ━ - heavy box-drawing horizontal

// Bridge status indicators
export const BRIDGE_SPINNER_FRAMES = isNui
  ? ['.|.', './.',  '.-.',  '.\\.']
  : ['\u00b7|\u00b7', '\u00b7/\u00b7', '\u00b7\u2014\u00b7', '\u00b7\\\u00b7']
export const BRIDGE_READY_INDICATOR = isNui ? '.v.' : '\u00b7\u2714\ufe0e\u00b7'
export const BRIDGE_FAILED_INDICATOR = '\u00d7'
