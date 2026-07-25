import { afterEach, describe, expect, test } from 'bun:test'
import { createKiroFetch } from './kiro-fetch-adapter.ts'
const originalFetch = globalThis.fetch
function upstreamResponse(events: unknown[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(JSON.stringify(event)))
        }
        controller.close()
      },
    }),
    { status: 200 },
  )
}
async function translate(events: unknown[]): Promise<string> {
  globalThis.fetch = async () => upstreamResponse(events)
  const fetch = createKiroFetch('test-token')
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'Inspect the project' }],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path'],
          },
        },
      ],
    }),
  })
  return response.text()
}
function sseData(stream: string): Array<Record<string, any>> {
  return stream
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)))
}
function toolBlocks(stream: string): Array<{ name: string; input: unknown }> {
  const events = sseData(stream)
  const starts = events.filter(
    event =>
      event.type === 'content_block_start' &&
      event.content_block?.type === 'tool_use',
  )
  return starts.map(start => {
    const input = events
      .filter(
        event =>
          event.type === 'content_block_delta' &&
          event.index === start.index,
      )
      .map(event => event.delta?.partial_json ?? '')
      .join('')
    return { name: start.content_block.name, input: JSON.parse(input) }
  })
}
function usage(stream: string): { inputTokens: number; outputTokens: number } {
  const events = sseData(stream)
  const messageStart = events.find(event => event.type === 'message_start')
  const messageDelta = events.find(event => event.type === 'message_delta')
  return {
    inputTokens: messageStart?.message?.usage?.input_tokens ?? 0,
    outputTokens: messageDelta?.usage?.output_tokens ?? 0,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Kiro tool-call stream translation', () => {
  test('reports estimated usage for a text response', async () => {
    const stream = await translate([{ content: 'Here is my answer.' }])
    const estimatedUsage = usage(stream)
    expect(estimatedUsage.inputTokens).toBeGreaterThan(0)
    expect(estimatedUsage.outputTokens).toBeGreaterThan(0)
  })
  test('reports estimated output usage for a tool response', async () => {
    const stream = await translate([
      { name: 'Read', toolUseId: 'call-1' },
      { input: '{"file_path":"a.ts"}', name: 'Read', toolUseId: 'call-1' },
      { name: 'Read', stop: true, toolUseId: 'call-1' },
    ])
    expect(usage(stream).outputTokens).toBeGreaterThan(0)
  })
  test('assembles GPT string fragments carrying name and toolUseId', async () => {
    const stream = await translate([
      { name: 'Read', toolUseId: 'call-1' },
      { input: '{"file_', name: 'Read', toolUseId: 'call-1' },
      { input: 'path":"D:/code', name: 'Read', toolUseId: 'call-1' },
      { input: '/AlienCode"}', name: 'Read', toolUseId: 'call-1' },
      { name: 'Read', stop: true, toolUseId: 'call-1' },
    ])
    expect(toolBlocks(stream)).toEqual([
      { name: 'Read', input: { file_path: 'D:/code/AlienCode' } },
    ])
  })
  test('assigns anonymous continuation fragments to the current tool', async () => {
    const stream = await translate([
      { name: 'Read', toolUseId: 'call-1' },
      { input: '{"file_' },
      { input: 'path":"a.ts"}' },
      { name: 'Read', stop: true, toolUseId: 'call-1' },
    ])
    expect(toolBlocks(stream)).toEqual([
      { name: 'Read', input: { file_path: 'a.ts' } },
    ])
  })
  test('preserves repeated short fragment tokens', async () => {
    const stream = await translate([
      { name: 'Skill', toolUseId: 'call-1' },
      { input: '{"skill', name: 'Skill', toolUseId: 'call-1' },
      { input: '":', name: 'Skill', toolUseId: 'call-1' },
      { input: ' "', name: 'Skill', toolUseId: 'call-1' },
      { input: 'three"}', name: 'Skill', toolUseId: 'call-1' },
      { name: 'Skill', stop: true, toolUseId: 'call-1' },
    ])
    expect(toolBlocks(stream)).toEqual([
      { name: 'Skill', input: { skill: 'three' } },
    ])
  })
  test('accepts an object snapshot used by Claude framing', async () => {
    const stream = await translate([
      {
        name: 'Read',
        toolUseId: 'call-1',
        input: { file_path: 'D:/code/AlienCode' },
      },
      { name: 'Read', stop: true, toolUseId: 'call-1' },
    ])
    expect(toolBlocks(stream)).toEqual([
      { name: 'Read', input: { file_path: 'D:/code/AlienCode' } },
    ])
  })
  test('ignores a replayed empty start with the same toolUseId', async () => {
    const stream = await translate([
      { name: 'Read', toolUseId: 'call-1' },
      { input: '{"file_path":"a.ts"}', name: 'Read', toolUseId: 'call-1' },
      { name: 'Read', stop: true, toolUseId: 'call-1' },
      { name: 'Read', toolUseId: 'call-1' },
      { name: 'Read', stop: true, toolUseId: 'call-1' },
    ])
    expect(toolBlocks(stream)).toEqual([
      { name: 'Read', input: { file_path: 'a.ts' } },
    ])
  })
  test('keeps consecutive tool inputs separate', async () => {
    const stream = await translate([
      { name: 'Read', toolUseId: 'call-1' },
      { input: '{"file_path":"pkg.json"}', name: 'Read', toolUseId: 'call-1' },
      { name: 'Read', stop: true, toolUseId: 'call-1' },
      { name: 'Glob', toolUseId: 'call-2' },
      { input: '{"pattern":"src/**/*.ts"}', name: 'Glob', toolUseId: 'call-2' },
      { name: 'Glob', stop: true, toolUseId: 'call-2' },
    ])
    expect(toolBlocks(stream)).toEqual([
      { name: 'Read', input: { file_path: 'pkg.json' } },
      { name: 'Glob', input: { pattern: 'src/**/*.ts' } },
    ])
  })
  test('ends a tool response with tool_use', async () => {
    const stream = await translate([
      { name: 'Read', toolUseId: 'call-1' },
      { input: '{"file_path":"a.ts"}', name: 'Read', toolUseId: 'call-1' },
      { name: 'Read', stop: true, toolUseId: 'call-1' },
    ])
    const messageDelta = sseData(stream).find(
      event => event.type === 'message_delta',
    )
    expect(messageDelta?.delta?.stop_reason).toBe('tool_use')
  })
  test('ends a plain-text response with end_turn', async () => {
    const stream = await translate([{ content: 'Here is my answer.' }])
    const messageDelta = sseData(stream).find(
      event => event.type === 'message_delta',
    )
    expect(messageDelta?.delta?.stop_reason).toBe('end_turn')
  })
})
