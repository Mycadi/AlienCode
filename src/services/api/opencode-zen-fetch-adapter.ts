export const DEFAULT_OPENCODE_ZEN_FREE_MODEL = 'minimax-m2.5-free'

export const OPENCODE_ZEN_FREE_MODELS = [
  { id: 'deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free' },
  { id: DEFAULT_OPENCODE_ZEN_FREE_MODEL, label: 'MiniMax M2.5 Free' },
  { id: 'ring-2.6-1t-free', label: 'Ring 2.6 1T Free' },
] as const

export function isOpenCodeZenFreeModel(model: string): boolean {
  return OPENCODE_ZEN_FREE_MODELS.some(m => m.id === model)
}

const OPENCODE_ZEN_CHAT_COMPLETIONS_URL =
  'https://opencode.ai/zen/v1/chat/completions'

type AnthropicContentBlock = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: unknown
}

type AnthropicMessage = {
  role: string
  content: string | AnthropicContentBlock[]
}

type AnthropicTool = {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

type OpenAIMessage = {
  role: string
  content?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

function getOpenCodeZenToken(): string {
  return process.env.OPENCODE_API_KEY || 'public'
}

function systemToText(
  system:
    | string
    | Array<{ type: string; text?: string; cache_control?: unknown }>
    | undefined,
): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function contentToText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text
      }
      if (block.type === 'image') {
        return '[Image attached]'
      }
      if (block.type === 'tool_result') {
        return typeof block.content === 'string'
          ? block.content
          : contentToText(block.content ?? [])
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function translateMessages(
  anthropicMessages: AnthropicMessage[],
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = []
  let toolCallCounter = 0

  for (const message of anthropicMessages) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content })
      continue
    }

    if (!Array.isArray(message.content)) continue

    const text = contentToText(
      message.content.filter(block => block.type !== 'tool_result'),
    )
    const toolCalls = message.content.filter(block => block.type === 'tool_use')
    const toolResults = message.content.filter(block => block.type === 'tool_result')

    if (toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: text || undefined,
        tool_calls: toolCalls.map(block => ({
          id: block.id || `call_${toolCallCounter++}`,
          type: 'function',
          function: {
            name: block.name || '',
            arguments: JSON.stringify(block.input || {}),
          },
        })),
      })
    } else if (text) {
      messages.push({ role: message.role, content: text })
    }

    for (const block of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id || `call_${toolCallCounter++}`,
        content:
          typeof block.content === 'string'
            ? block.content
            : contentToText(block.content ?? []),
      })
    }
  }

  return messages
}

function translateTools(anthropicTools: AnthropicTool[]): Array<Record<string, unknown>> {
  return anthropicTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

function translateToOpenAIChatBody(
  anthropicBody: Record<string, unknown>,
): Record<string, unknown> {
  const systemText = systemToText(
    anthropicBody.system as
      | string
      | Array<{ type: string; text?: string; cache_control?: unknown }>
      | undefined,
  )
  const messages = translateMessages(
    (anthropicBody.messages || []) as AnthropicMessage[],
  )
  if (systemText) {
    messages.unshift({ role: 'system', content: systemText })
  }

  const body: Record<string, unknown> = {
    model: anthropicBody.model,
    messages,
    stream: true,
  }

  if (typeof anthropicBody.max_tokens === 'number') {
    body.max_tokens = anthropicBody.max_tokens
  }
  if (typeof anthropicBody.temperature === 'number') {
    body.temperature = anthropicBody.temperature
  }

  const tools = (anthropicBody.tools || []) as AnthropicTool[]
  if (tools.length > 0) {
    body.tools = translateTools(tools)
    body.tool_choice = 'auto'
  }

  return body
}

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

async function translateOpenAIStreamToAnthropic(response: Response): Promise<Response> {
  const messageId = `msg_opencode_${Date.now()}`
  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let contentBlockIndex = 0
      let textBlockStarted = false
      let outputTokens = 0
      let inputTokens = 0
      const toolBlockIndexes = new Map<number, number>()
      let hadToolCalls = false

      const enqueue = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(formatSSE(event, JSON.stringify(data))))
      }

      enqueue('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'opencode-zen',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
      enqueue('ping', { type: 'ping' })

      const closeTextBlock = () => {
        if (!textBlockStarted) return
        enqueue('content_block_stop', {
          type: 'content_block_stop',
          index: contentBlockIndex,
        })
        contentBlockIndex++
        textBlockStarted = false
      }

      try {
        const reader = response.body?.getReader()
        if (!reader) throw new Error('No response body')

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data: ')) continue
            const data = trimmed.slice(6)
            if (data === '[DONE]') continue

            let event: any
            try {
              event = JSON.parse(data)
            } catch {
              continue
            }

            const usage = event.usage
            if (usage) {
              inputTokens = usage.prompt_tokens || inputTokens
              outputTokens = usage.completion_tokens || outputTokens
            }

            const delta = event.choices?.[0]?.delta
            if (!delta) continue

            if (typeof delta.content === 'string' && delta.content.length > 0) {
              if (!textBlockStarted) {
                enqueue('content_block_start', {
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: { type: 'text', text: '' },
                })
                textBlockStarted = true
              }
              enqueue('content_block_delta', {
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: delta.content },
              })
              outputTokens++
            }

            if (Array.isArray(delta.tool_calls)) {
              closeTextBlock()
              hadToolCalls = true
              for (const toolCall of delta.tool_calls) {
                const toolIndex = toolCall.index ?? 0
                let blockIndex = toolBlockIndexes.get(toolIndex)
                if (blockIndex === undefined) {
                  blockIndex = contentBlockIndex++
                  toolBlockIndexes.set(toolIndex, blockIndex)
                  const id = toolCall.id || `toolu_${Date.now()}_${toolIndex}`
                  const name = toolCall.function?.name || ''
                  enqueue('content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: {
                      type: 'tool_use',
                      id,
                      name,
                      input: {},
                    },
                  })
                }

                const args = toolCall.function?.arguments
                if (typeof args === 'string' && args.length > 0) {
                  enqueue('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'input_json_delta', partial_json: args },
                  })
                }
              }
            }
          }
        }
      } catch (error) {
        if (!textBlockStarted) {
          enqueue('content_block_start', {
            type: 'content_block_start',
            index: contentBlockIndex,
            content_block: { type: 'text', text: '' },
          })
          textBlockStarted = true
        }
        enqueue('content_block_delta', {
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'text_delta', text: `\n\n[Error: ${String(error)}]` },
        })
      }

      closeTextBlock()
      for (const blockIndex of toolBlockIndexes.values()) {
        enqueue('content_block_stop', {
          type: 'content_block_stop',
          index: blockIndex,
        })
      }
      enqueue('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: hadToolCalls ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens },
      })
      enqueue('message_stop', {
        type: 'message_stop',
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      })
      controller.close()
    },
  })

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-request-id': messageId,
    },
  })
}

export function createOpenCodeZenFetch(): (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/v1/messages')) {
      return globalThis.fetch(input, init)
    }

    let anthropicBody: Record<string, unknown>
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(bodyText)
    } catch {
      anthropicBody = {}
    }

    const openAIResponse = await globalThis.fetch(OPENCODE_ZEN_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${getOpenCodeZenToken()}`,
      },
      body: JSON.stringify(translateToOpenAIChatBody(anthropicBody)),
    })

    if (!openAIResponse.ok) {
      const errorText = await openAIResponse.text()
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: `OpenCode Zen API error (${openAIResponse.status}): ${errorText}`,
          },
        }),
        {
          status: openAIResponse.status,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    return translateOpenAIStreamToAnthropic(openAIResponse)
  }
}
