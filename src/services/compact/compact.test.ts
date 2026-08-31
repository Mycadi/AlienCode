import { describe, expect, test } from 'bun:test'
import { shouldUseCompactCachePrefix } from './compact.ts'

describe('compact cache prefix', () => {
  test('disables the forked compact path for an active Codex apikey profile', () => {
    expect(shouldUseCompactCachePrefix(true, 'codex', 'profile')).toBe(false)
  })

  test('preserves the feature flag for non-Codex requests', () => {
    expect(shouldUseCompactCachePrefix(true, undefined, null)).toBe(true)
    expect(shouldUseCompactCachePrefix(false, undefined, null)).toBe(false)
  })
})
