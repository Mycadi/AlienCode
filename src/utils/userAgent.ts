/**
 * User-Agent string helpers.
 *
 * Kept dependency-free so SDK-bundled code (bridge, cli/transports) can
 * import without pulling in auth.ts and its transitive dependency tree.
 */

/**
 * Version reported to the API (User-Agent, billing header, fingerprint).
 * The server gates newer models by client version, so this must be >= the
 * minimum it requires. Independent from MACRO.VERSION (update checks, UI).
 */
export const WIRE_VERSION = '2.1.280'

export function getClaudeCodeUserAgent(): string {
  return `claude-code/${WIRE_VERSION}`
}
