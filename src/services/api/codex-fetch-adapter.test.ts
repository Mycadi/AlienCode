import { describe, expect, test } from 'bun:test'
import {
  prepareCodexRequest,
  prepareCodexRequestBody,
} from './codex-fetch-adapter.ts'

describe('Codex request preparation', () => {
  test('confines intermediate request objects behind a serialized boundary', () => {
    const prepared = prepareCodexRequestBody(
      JSON.stringify({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      true,
    )

    expect(prepared.codexModel).toBe('gpt-test')
    expect(typeof prepared.body).toBe('string')
    expect(JSON.parse(prepared.body)).toMatchObject({
      model: 'gpt-test',
      input: [{ role: 'user', content: 'hello' }],
    })
  })

  test('reads and converts the incoming body before the network request frame', async () => {
    const prepared = await prepareCodexRequest(
      JSON.stringify({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      true,
    )

    expect(prepared.codexModel).toBe('gpt-test')
    expect(JSON.parse(prepared.body).input).toEqual([
      { role: 'user', content: 'hello' },
    ])
  })
})
