import { describe, expect, test } from 'bun:test'
import { resolveAdapterModel } from './client.ts'

describe('OpenAI-compatible model resolution', () => {
  test('prefers the explicitly selected model over the profile default', () => {
    expect(resolveAdapterModel('glm5.2', 'claude-opus-4.8')).toBe('glm5.2')
  })

  test('falls back to the profile model when no model is selected', () => {
    expect(resolveAdapterModel(undefined, 'claude-opus-4.8')).toBe(
      'claude-opus-4.8',
    )
  })
})
