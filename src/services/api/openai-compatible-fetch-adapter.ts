import type { ClientOptions } from '@anthropic-ai/sdk'

type AnthropicContentBlock = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: { type?: string; media_type?: string; data?: string }
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
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | Array<Record<string, unknown>> | null
  tool_calls?: Array<Record<string, unknown>>
  tool_call_id?: string
}

const CHAT_COMPLETIONS_SUFFIX = '/v1/chat/completions'

export function isOpenAICompatibleChatCompletionsUrl(url?: string): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.pathname.endsWith('/chat/completions')
  } catch {
    return url.includes('/chat/completions')
  }
}

function resolveChatCompletionsUrl(url: string): string {
  if (isOpenAICompatibleChatCompletionsUrl(url)) return url
  return `${url.replace(/\/+$/, '')}${CHAT_COMPLETIONS_SUFFIX}`
}

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content
  return JSON.stringify(content ?? {})
}

function translateSystemPrompt(systemPrompt: unknown): string | undefined {
  if (typeof systemPrompt === 'string') return systemPrompt
  if (!Array.isArray(systemPrompt)) return undefined

  const text = systemPrompt
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map(block => block.text)
    .join('\n')

  return text || undefined
}

function translateUserContent(
  content: string | AnthropicContentBlock[],
): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content

  const result: Array<Record<string, unknown>> = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      result.push({ type: 'text', text: block.text })
    } else if (
      block.type === 'image' &&
      block.source?.type === 'base64' &&
      block.source.media_type &&
      block.source.data
    ) {
      result.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      })
    } else if (block.type === 'tool_result') {
      result.push({ type: 'text', text: stringifyContent(block.content) })
    }
  }

  if (result.length === 1 && result[0].type === 'text') {
    return String(result[0].text ?? '')
  }
  return result
}

function translateMessages(anthropicMessages: AnthropicMessage[]): OpenAIMessage[] {
  const messages: OpenAIMessage[] = []

  for (const message of anthropicMessages) {
    if (message.role === 'user') {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'tool_result') {
            messages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id || '',
              content: stringifyContent(block.content),
            })
          }
        }
      }

      const userContent = translateUserContent(message.content)
      if (Array.isArray(userContent) ? userContent.length > 0 : userContent) {
        messages.push({ role: 'user', content: userContent })
      }
      continue
    }

    if (message.role === 'assistant') {
      if (typeof message.content === 'string') {
        messages.push({ role: 'assistant', content: message.content })
        continue
      }

      const textParts: string[] = []
      const toolCalls: Array<Record<string, unknown>> = []
      for (const block of message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || `call_${toolCalls.length}`,
            type: 'function',
            function: {
              name: block.name || '',
              arguments: JSON.stringify(block.input || {}),
            },
          })
        }
      }

      messages.push({
        role: 'assistant',
        content: textParts.join('\n') || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    }
  }

  return messages
}

function translateTools(tools: AnthropicTool[]): Array<Record<string, unknown>> {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

function translateToOpenAIBody(
  anthropicBody: Record<string, unknown>,
  fallbackModel?: string,
): { body: Record<string, unknown>; model: string } {
  const model = String(anthropicBody.model || fallbackModel || process.env.ANTHROPIC_MODEL || '')
  const messages = translateMessages((anthropicBody.messages || []) as AnthropicMessage[])
  const system = translateSystemPrompt(anthropicBody.system)
  if (system) messages.unshift({ role: 'system', content: system })

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  }

  const maxTokens = anthropicBody.max_tokens
  if (typeof maxTokens === 'number') body.max_tokens = maxTokens

  const temperature = anthropicBody.temperature
  if (typeof temperature === 'number') body.temperature = temperature

  const tools = (anthropicBody.tools || []) as AnthropicTool[]
  if (tools.length > 0) {
    body.tools = translateTools(tools)
    body.tool_choice = 'auto'
  }

  return { body, model }
}

async function readRequestBody(init?: RequestInit): Promise<Record<string, unknown>> {
  try {
    const bodyText =
      init?.body instanceof ReadableStream
        ? await new Response(init.body).text()
        : typeof init?.body === 'string'
          ? init.body
          : '{}'
    return JSON.parse(bodyText)
  } catch {
    return {}
  }
}

function emitSSE(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  event: string,
  data: Record<string, unknown>,
): void {
  controller.enqueue(encoder.encode(formatSSE(event, JSON.stringify(data))))
}

function translateOpenAIStreamToAnthropic(
  openAIResponse: Response,
  model: string,
): Response {
  const messageId = `msg_openai_${Date.now()}`
  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let contentBlockIndex = 0
      let textBlockStarted = false
      let outputTokens = 0
      const toolCallIndexes = new Map<number, number>()
      const toolCallStates = new Map<number, { id: string; name: string; args: string }>()
      let hadToolCalls = false

      emitSSE(controller, encoder, 'message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
      emitSSE(controller, encoder, 'ping', { type: 'ping' })

      const closeTextBlock = () => {
        if (!textBlockStarted) return
        emitSSE(controller, encoder, 'content_block_stop', {
          type: 'content_block_stop',
          index: contentBlockIndex,
        })
        contentBlockIndex += 1
        textBlockStarted = false
      }

      const closeToolBlocks = () => {
        for (const index of toolCallIndexes.values()) {
          emitSSE(controller, encoder, 'content_block_stop', {
            type: 'content_block_stop',
            index,
          })
        }
        toolCallIndexes.clear()
        toolCallStates.clear()
      }

      try {
        const reader = openAIResponse.body?.getReader()
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

            let chunk: Record<string, any>
            try {
              chunk = JSON.parse(data)
            } catch {
              continue
            }

            const choice = chunk.choices?.[0]
            const delta = choice?.delta
            if (!delta) continue

            if (typeof delta.content === 'string' && delta.content.length > 0) {
              if (!textBlockStarted) {
                closeToolBlocks()
                emitSSE(controller, encoder, 'content_block_start', {
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: { type: 'text', text: '' },
                })
                textBlockStarted = true
              }
              emitSSE(controller, encoder, 'content_block_delta', {
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: delta.content },
              })
              outputTokens += 1
            }

            if (Array.isArray(delta.tool_calls)) {
              closeTextBlock()
              hadToolCalls = true
              for (const toolCall of delta.tool_calls) {
                const callIndex = Number(toolCall.index ?? 0)
                let blockIndex = toolCallIndexes.get(callIndex)
                let state = toolCallStates.get(callIndex)
                if (blockIndex === undefined || !state) {
                  blockIndex = contentBlockIndex++
                  state = {
                    id: toolCall.id || `toolu_${Date.now()}_${callIndex}`,
                    name: toolCall.function?.name || '',
                    args: '',
                  }
                  toolCallIndexes.set(callIndex, blockIndex)
                  toolCallStates.set(callIndex, state)
                  emitSSE(controller, encoder, 'content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: {
                      type: 'tool_use',
                      id: state.id,
                      name: state.name,
                      input: {},
                    },
                  })
                }

                if (typeof toolCall.function?.name === 'string') {
                  state.name = toolCall.function.name
                }
                if (typeof toolCall.function?.arguments === 'string') {
                  state.args += toolCall.function.arguments
                  emitSSE(controller, encoder, 'content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: {
                      type: 'input_json_delta',
                      partial_json: toolCall.function.arguments,
                    },
                  })
                }
              }
            }
          }
        }
      } catch (error) {
        if (!textBlockStarted) {
          closeToolBlocks()
          emitSSE(controller, encoder, 'content_block_start', {
            type: 'content_block_start',
            index: contentBlockIndex,
            content_block: { type: 'text', text: '' },
          })
          textBlockStarted = true
        }
        emitSSE(controller, encoder, 'content_block_delta', {
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'text_delta', text: `\n\n[Error: ${String(error)}]` },
        })
      }

      closeTextBlock()
      closeToolBlocks()

      emitSSE(controller, encoder, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: hadToolCalls ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens },
      })
      emitSSE(controller, encoder, 'message_stop', {
        type: 'message_stop',
        usage: { input_tokens: 0, output_tokens: outputTokens },
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

export function createOpenAICompatibleFetch({
  apiKey,
  endpoint,
  model,
}: {
  apiKey: string
  endpoint: string
  model?: string
}): NonNullable<ClientOptions['fetch']> {
  const chatCompletionsUrl = resolveChatCompletionsUrl(endpoint)

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/v1/messages')) {
      return globalThis.fetch(input, init)
    }

    const anthropicBody = await readRequestBody(init)
    const { body, model: resolvedModel } = translateToOpenAIBody(anthropicBody, model)
    const response = await globalThis.fetch(chatCompletionsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: `OpenAI compatible API error (${response.status}): ${errorText}`,
          },
        }),
        {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    return translateOpenAIStreamToAnthropic(response, resolvedModel)
  }
}
