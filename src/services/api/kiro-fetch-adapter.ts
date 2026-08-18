/**
 * Kiro Fetch Adapter
 *
 * Intercepts fetch calls from the Anthropic SDK and routes them to Kiro's
 * AWS CodeWhisperer backend, translating between the Anthropic Messages API and
 * CodeWhisperer's generateAssistantResponse format (request + streaming
 * response).
 *
 * Kiro exposes both Claude and GPT models through the same endpoint; the model
 * name is passed through as CodeWhisperer's `modelId` verbatim.
 *
 * Response framing note: CodeWhisperer replies with an AWS event-stream (binary
 * framed). Rather than fully decode the frames we scan the decoded text for the
 * embedded JSON events (`{"content":...}`, `{"name":...}`, `{"input":...}`,
 * `{"stop":...}`), matching the approach used by the open-source Kiro gateways.
 *
 * Endpoint: https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse
 */

import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  KIRO_CODEWHISPERER_URL,
  KIRO_IDE_USER_AGENT,
  KIRO_PROFILE_ARN,
} from '../../constants/kiro-oauth.js'
import { getKiroOAuthTokens, saveKiroOAuthTokens } from '../../utils/auth.js'
import { refreshKiroToken } from '../oauth/kiro-client.js'
import { getCwd } from '../../utils/cwd.js'
import { logError } from '../../utils/log.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'

// ── Available Kiro models ───────────────────────────────────────────
export const KIRO_MODELS = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', description: 'Kiro · 1.30x credits' },
  { id: 'claude-opus-4.8', label: 'Claude Opus 4.8', description: 'Kiro · 2.20x credits' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', description: 'Kiro · 2.20x credits' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Kiro · 2.40x credits' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Kiro · 1.20x credits' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'Kiro · 0.60x credits' },
] as const

export const DEFAULT_KIRO_MODEL = 'claude-sonnet-5'
const DEFAULT_KIRO_STREAM_IDLE_TIMEOUT_MS = 60_000
const KIRO_OPUS_5_LARGE_TOOL_INPUT_GUARD =
  'IMPORTANT Kiro tool-call reliability rule: Every Write or Edit call MUST have a complete serialized JSON input of at most 3000 characters. Inputs above this limit can be truncated and fail. NEVER put more than 1800 characters in content or new_string. For larger files, MUST use one small Write followed by multiple sequential small Edit calls. NEVER place a large file in one Write call.'

export function isKiroModel(model: string): boolean {
  return KIRO_MODELS.some((m) => m.id === model)
}

/**
 * Maps a requested Claude/GPT model name to a Kiro modelId. Kiro's runtime uses
 * the dotted model name directly, so a known Kiro id passes through; anything
 * else falls back by family keyword.
 */
export function mapClaudeModelToKiro(claudeModel: string | null): string {
  if (!claudeModel) return DEFAULT_KIRO_MODEL
  if (isKiroModel(claudeModel)) return claudeModel
  const lower = claudeModel.toLowerCase()
  if (lower.includes('opus')) return 'claude-opus-4.8'
  if (lower.includes('sonnet')) return 'claude-sonnet-5'
  return DEFAULT_KIRO_MODEL
}

/**
 * Reads the project's AGENTS.md so Kiro (CodeWhisperer) always receives the
 * project rules. Kiro has no dedicated system field, so the content is folded
 * into the synthesized system turn. Returns '' when absent or unreadable.
 */
function readProjectAgentsMd(): string {
  try {
    return readFileSync(join(getCwd(), 'AGENTS.md'), 'utf8').trim()
  } catch {
    return ''
  }
}

// ── Anthropic request types (subset) ────────────────────────────────
type AnthropicContentBlock = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  source?: { type?: string; media_type?: string; data?: string }
}

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

type AnthropicTool = {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

// ── Request translation (Anthropic → CodeWhisperer) ─────────────────

function extractText(content: string | AnthropicContentBlock[] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

function extractImages(
  content: string | AnthropicContentBlock[] | undefined,
): Array<{ format: string; source: { bytes: string } }> {
  if (!Array.isArray(content)) return []
  const out: Array<{ format: string; source: { bytes: string } }> = []
  for (const b of content) {
    if (b.type === 'image' && b.source?.data) {
      const mediaType = b.source.media_type ?? 'image/jpeg'
      out.push({
        format: mediaType.split('/').pop() ?? 'jpeg',
        source: { bytes: b.source.data },
      })
    }
  }
  return out
}

const KIRO_TOOL_USE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

/**
 * CodeWhisperer rejects tool ids that do not match ^[a-zA-Z0-9_-]+$ with a 400
 * TOOL_SCHEMA_INVALID. History replayed from other providers can carry ids like
 * `Bash:209`, so illegal ids are rewritten. The mapping is shared across one
 * request so a tool_use and its tool_result keep pointing at the same id.
 */
function sanitizeToolUseId(id: string, mapping: Map<string, string>): string {
  if (KIRO_TOOL_USE_ID_PATTERN.test(id)) return id
  const existing = mapping.get(id)
  if (existing) return existing
  let sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '_') || 'tool'
  if (new Set(mapping.values()).has(sanitized)) {
    sanitized = `${sanitized}_${mapping.size}`
  }
  mapping.set(id, sanitized)
  return sanitized
}

function extractToolResults(
  content: string | AnthropicContentBlock[] | undefined,
  toolIdMapping: Map<string, string>,
): Array<{ toolUseId: string; content: Array<{ text: string }>; status: string }> {
  if (!Array.isArray(content)) return []
  const out: Array<{ toolUseId: string; content: Array<{ text: string }>; status: string }> = []
  for (const b of content) {
    if (b.type === 'tool_result' && b.tool_use_id) {
      const text =
        typeof b.content === 'string'
          ? b.content
          : extractText(b.content as AnthropicContentBlock[]) || '(empty result)'
      out.push({
        toolUseId: sanitizeToolUseId(b.tool_use_id, toolIdMapping),
        content: [{ text }],
        status: 'success',
      })
    }
  }
  return out
}

function extractToolUses(
  content: string | AnthropicContentBlock[] | undefined,
  toolIdMapping: Map<string, string>,
): Array<{ toolUseId: string; name: string; input: unknown }> {
  if (!Array.isArray(content)) return []
  const out: Array<{ toolUseId: string; name: string; input: unknown }> = []
  for (const b of content) {
    if (b.type === 'tool_use' && b.id && b.name) {
      out.push({
        toolUseId: sanitizeToolUseId(b.id, toolIdMapping),
        name: b.name,
        input: b.input ?? {},
      })
    }
  }
  return out
}

function convertTools(
  tools: AnthropicTool[] | undefined,
  guardLargeToolInput = false,
) {
  if (!tools?.length) return undefined
  return tools.map((t) => {
    const inputSchema = t.input_schema ?? {}
    const limits = guardLargeToolInput
      ? t.name === 'Write'
        ? { content: 1800 }
        : t.name === 'Edit'
          ? { old_string: 800, new_string: 1800 }
          : undefined
      : undefined
    const properties = inputSchema.properties
    const limitedProperties =
      limits && properties && typeof properties === 'object' && !Array.isArray(properties)
        ? Object.fromEntries(
            Object.entries(properties).map(([name, schema]) => [
              name,
              name in limits && schema && typeof schema === 'object' && !Array.isArray(schema)
                ? { ...schema, maxLength: limits[name as keyof typeof limits] }
                : schema,
            ]),
          )
        : undefined

    return {
      toolSpecification: {
        name: t.name,
        description: t.description?.trim() || `Tool: ${t.name}`,
        inputSchema: {
          json: limitedProperties
            ? { ...inputSchema, properties: limitedProperties }
            : inputSchema,
        },
      },
    }
  })
}

type KiroPayload = {
  conversationState: {
    chatTriggerType: string
    conversationId: string
    currentMessage: { userInputMessage: Record<string, unknown> }
    history?: Array<Record<string, unknown>>
  }
  profileArn?: string
}

function estimateAnthropicInputTokens(
  anthropicBody: Record<string, unknown>,
): number {
  const countableInput = {
    system: anthropicBody.system,
    messages: anthropicBody.messages,
    tools: anthropicBody.tools,
  }
  return roughTokenCountEstimation(JSON.stringify(countableInput))
}

function translateToKiroBody(anthropicBody: Record<string, unknown>): {
  payload: KiroPayload
  modelId: string
} {
  const modelId = mapClaudeModelToKiro((anthropicBody.model as string) ?? null)
  // Shared across this request so tool_use ids and their tool_result references
  // are rewritten consistently.
  const toolIdMapping = new Map<string, string>()
  const messages = (anthropicBody.messages as AnthropicMessage[]) ?? []
  const tools = (anthropicBody.tools as AnthropicTool[] | undefined) ?? []
  const toolNames = new Set(tools.map(tool => tool.name))
  const shouldGuardLargeToolInput =
    modelId === 'claude-opus-5' &&
    toolNames.has('Write') &&
    toolNames.has('Edit')
  const systemText =
    typeof anthropicBody.system === 'string'
      ? anthropicBody.system
      : Array.isArray(anthropicBody.system)
        ? extractText(anthropicBody.system as AnthropicContentBlock[])
        : ''

  // Inject the project's AGENTS.md at the front of the system turn. Guard
  // against duplication in case the main loop already folded it into `system`.
  const agentsMd = readProjectAgentsMd()
  const systemWithAgents =
    agentsMd && !systemText.includes(agentsMd)
      ? `${agentsMd}\n\n${systemText}`.trim()
      : systemText
  const systemWithGuard =
    shouldGuardLargeToolInput &&
    !systemWithAgents.includes(KIRO_OPUS_5_LARGE_TOOL_INPUT_GUARD)
      ? `${systemWithAgents}\n\n${KIRO_OPUS_5_LARGE_TOOL_INPUT_GUARD}`.trim()
      : systemWithAgents

  // The last message is the "current" one; the rest becomes history.
  const current = messages[messages.length - 1]
  const historyMessages = messages.slice(0, -1)

  const history: Array<Record<string, unknown>> = []
  // Prepend the system prompt as the first user turn (CodeWhisperer has no
  // dedicated system field).
  if (systemWithGuard) {
    history.push({
      userInputMessage: {
        content: systemWithGuard,
        modelId,
        origin: 'AI_EDITOR',
      },
    })
    history.push({
      assistantResponseMessage: { content: 'Understood.' },
    })
  }

  for (const msg of historyMessages) {
    if (msg.role === 'user') {
      const userInput: Record<string, unknown> = {
        content: extractText(msg.content) || '(empty placeholder)',
        modelId,
        origin: 'AI_EDITOR',
      }
      const images = extractImages(msg.content)
      if (images.length) userInput.images = images
      const toolResults = extractToolResults(msg.content, toolIdMapping)
      if (toolResults.length) {
        userInput.userInputMessageContext = { toolResults }
      }
      history.push({ userInputMessage: userInput })
    } else {
      const assistant: Record<string, unknown> = {
        content: extractText(msg.content) || '(empty placeholder)',
      }
      const toolUses = extractToolUses(msg.content, toolIdMapping)
      if (toolUses.length) assistant.toolUses = toolUses
      history.push({ assistantResponseMessage: assistant })
    }
  }

  // Build the current userInputMessage.
  const currentContext: Record<string, unknown> = {}
  const kiroTools = convertTools(tools, shouldGuardLargeToolInput)
  if (kiroTools) currentContext.tools = kiroTools
  const currentToolResults = extractToolResults(current?.content, toolIdMapping)
  if (currentToolResults.length) currentContext.toolResults = currentToolResults

  const userInputMessage: Record<string, unknown> = {
    content: extractText(current?.content) || '(empty placeholder)',
    modelId,
    origin: 'AI_EDITOR',
  }
  const currentImages = extractImages(current?.content)
  if (currentImages.length) userInputMessage.images = currentImages
  if (Object.keys(currentContext).length) {
    userInputMessage.userInputMessageContext = currentContext
  }

  const payload: KiroPayload = {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: randomUUID(),
      currentMessage: { userInputMessage },
    },
    // Enterprise (IdC) accounts require their own profileArn; fall back to the
    // Social default only when the stored token carries none.
    profileArn: getKiroOAuthTokens()?.profileArn || KIRO_PROFILE_ARN,
  }
  if (history.length) payload.conversationState.history = history

  return { payload, modelId }
}

// ── CodeWhisperer event-stream scanning ─────────────────────────────

/** Finds the index just past the JSON object that starts at `start`. */
function findMatchingBrace(buffer: string, start: number): number {
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < buffer.length; i++) {
    const ch = buffer[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// CodeWhisperer embeds newline-delimited JSON events inside an AWS
// event-stream frame. We locate each embedded object by its opening prefix,
// then classify it by its *fields* (not its prefix): GPT models emit tool
// events shaped like {"input":"..fragment..","name":"X","toolUseId":"Y"},
// where `input` leads even though the event carries name/id.
const EVENT_PREFIXES = [
  '{"content":',
  '{"name":',
  '{"input":',
  '{"stop":',
  '{"followupPrompt":',
]

type KiroEvent =
  | { type: 'content'; data: string }
  | {
      type: 'tool'
      id: string
      name: string
      // Present when this event carried an `input` field. Strings are streamed
      // fragments to append; objects are complete snapshots to replace with.
      input?: { value: string; isSnapshot: boolean }
    }
  | { type: 'tool_stop'; id: string }

function toToolInput(input: unknown): { value: string; isSnapshot: boolean } {
  if (typeof input === 'object' && input !== null) {
    return {
      value: Object.keys(input).length ? JSON.stringify(input) : '',
      isSnapshot: true,
    }
  }
  // Strings are raw JSON fragments (e.g. `{\"skill\": \"i`, `mpeccable`, `\"}`)
  // that must be concatenated verbatim — never deduplicated, or short repeated
  // tokens like `":` would be dropped and corrupt the final JSON.
  return { value: typeof input === 'string' ? input : '', isSnapshot: false }
}

/** Stateful scanner turning a raw CodeWhisperer byte stream into Kiro events. */
class KiroStreamScanner {
  private buffer = ''
  private lastContent: string | null = null
  private currentToolId: string | null = null
  private currentToolName = ''

  feed(chunk: string): KiroEvent[] {
    this.buffer += chunk
    const events: KiroEvent[] = []

    for (;;) {
      let earliestPos = -1
      for (const prefix of EVENT_PREFIXES) {
        const pos = this.buffer.indexOf(prefix)
        if (pos !== -1 && (earliestPos === -1 || pos < earliestPos)) {
          earliestPos = pos
        }
      }
      if (earliestPos === -1) break

      const end = findMatchingBrace(this.buffer, earliestPos)
      if (end === -1) break // incomplete JSON, wait for more

      const jsonStr = this.buffer.slice(earliestPos, end + 1)
      this.buffer = this.buffer.slice(end + 1)

      let data: Record<string, unknown>
      try {
        data = JSON.parse(jsonStr)
      } catch {
        continue
      }

      const ev = this.classify(data)
      if (ev) events.push(ev)
    }
    return events
  }

  private classify(data: Record<string, unknown>): KiroEvent | null {
    // A tool event is anything carrying a tool name or a toolUseId. GPT streams
    // input fragments as {"input":"..","name":"X","toolUseId":"Y"}; the leading
    // `input` field must not fool us into treating it as anonymous text.
    const hasName = typeof data.name === 'string'
    const hasToolId = typeof data.toolUseId === 'string'
    if (hasName || hasToolId) {
      const id = hasToolId
        ? (data.toolUseId as string)
        : this.currentToolId ?? randomUUID()
      if (data.stop === true) {
        if (id === this.currentToolId) {
          this.currentToolId = null
          this.currentToolName = ''
        }
        return { type: 'tool_stop', id }
      }
      const name = hasName ? (data.name as string) : this.currentToolName
      this.currentToolId = id
      if (name) this.currentToolName = name
      const ev: KiroEvent = { type: 'tool', id, name }
      if ('input' in data) ev.input = toToolInput(data.input)
      return ev
    }

    // Some CodeWhisper variants omit name/id on continuation fragments.
    if ('input' in data && this.currentToolId) {
      return {
        type: 'tool',
        id: this.currentToolId,
        name: this.currentToolName,
        input: toToolInput(data.input),
      }
    }

    // followupPrompt events are trailing suggestions, not assistant output.
    if (data.followupPrompt) return null

    if (typeof data.content === 'string') {
      const content = data.content
      if (content === this.lastContent) return null
      this.lastContent = content
      if (!content) return null
      return { type: 'content', data: content }
    }

    return null
  }
}

type KiroStreamDiagnostic = {
  chunkCount: number
  byteCount: number
  unrecognizedChunkCount: number
  recentChunks: Array<{ bytes: number; events: string[] }>
  lastActivityAt: number
}

function summarizeKiroStreamDiagnostic(
  model: string,
  diagnostic: KiroStreamDiagnostic,
): string {
  const idleMs = Date.now() - diagnostic.lastActivityAt
  return [
    `model=${model}`,
    `chunks=${diagnostic.chunkCount}`,
    `bytes=${diagnostic.byteCount}`,
    `unrecognizedChunks=${diagnostic.unrecognizedChunkCount}`,
    `idleMs=${idleMs}`,
    `recent=${JSON.stringify(diagnostic.recentChunks)}`,
  ].join(' ')
}

// ── Anthropic SSE emission ──────────────────────────────────────────

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Translates the CodeWhisperer response stream into an Anthropic Messages SSE
 * stream. Handles text and tool_use content blocks.
 */
function kiroStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  inputTokens: number,
  idleTimeoutMs: number,
): ReadableStream<Uint8Array> {
  const scanner = new KiroStreamScanner()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const messageId = `msg_${randomUUID().replace(/-/g, '')}`

  let started = false
  let blockOpen = false
  let blockIndex = 0
  let blockKind: 'text' | 'tool' | null = null
  let toolInput = ''
  let outputContent = ''
  let sawToolUse = false
  let currentToolId: string | null = null
  const seenToolIds = new Set<string>()
  const diagnostic: KiroStreamDiagnostic = {
    chunkCount: 0,
    byteCount: 0,
    unrecognizedChunkCount: 0,
    recentChunks: [],
    lastActivityAt: Date.now(),
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (s: string) => controller.enqueue(encoder.encode(s))

      const ensureStart = () => {
        if (started) return
        started = true
        emit(
          sse('message_start', {
            type: 'message_start',
            message: {
              id: messageId,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: inputTokens, output_tokens: 0 },
            },
          }),
        )
      }

      const closeBlock = () => {
        if (!blockOpen) return
        if (blockKind === 'tool') {
          const finalToolInput = toolInput || '{}'
          emit(
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: finalToolInput,
              },
            }),
          )
          outputContent += finalToolInput
          toolInput = ''
        }
        emit(sse('content_block_stop', { type: 'content_block_stop', index: blockIndex }))
        blockOpen = false
        blockKind = null
        blockIndex++
      }

      const openText = () => {
        if (blockOpen && blockKind === 'text') return
        closeBlock()
        emit(
          sse('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
          }),
        )
        blockOpen = true
        blockKind = 'text'
      }

      const openTool = (id: string, name: string) => {
        closeBlock()
        emit(
          sse('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id, name, input: {} },
          }),
        )
        blockOpen = true
        blockKind = 'tool'
        toolInput = ''
        outputContent += name
        sawToolUse = true
        currentToolId = id
        seenToolIds.add(id)
      }

      try {
        ensureStart()
        const reader = upstream.getReader()
        let timedOut = false
        for (;;) {
          let timeoutId: ReturnType<typeof setTimeout> | undefined
          const idleTimeout = new Promise<null>(resolve => {
            timeoutId = setTimeout(() => resolve(null), idleTimeoutMs)
          })
          const result = await Promise.race([reader.read(), idleTimeout])
          if (timeoutId) clearTimeout(timeoutId)
          if (result === null) {
            timedOut = true
            logError(
              new Error(
                `Kiro response stream idle timeout: ${summarizeKiroStreamDiagnostic(model, diagnostic)}`,
              ),
            )
            await reader.cancel('Kiro response stream idle timeout').catch(() => {})
            break
          }
          const { done, value } = result
          if (done) break
          diagnostic.chunkCount++
          diagnostic.byteCount += value.byteLength
          diagnostic.lastActivityAt = Date.now()
          const events = scanner.feed(decoder.decode(value, { stream: true }))
          const eventTypes = events.map(event => event.type)
          if (!eventTypes.length) diagnostic.unrecognizedChunkCount++
          diagnostic.recentChunks.push({ bytes: value.byteLength, events: eventTypes })
          if (diagnostic.recentChunks.length > 8) diagnostic.recentChunks.shift()
          for (const ev of events) {
            if (ev.type === 'content') {
              openText()
              outputContent += ev.data
              emit(
                sse('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'text_delta', text: ev.data },
                }),
              )
            } else if (ev.type === 'tool') {
              // GPT streams a tool as an initial {name,id} start, then a run of
              // {input,name,id} fragments, then a {name,stop,id}. Kiro sometimes
              // replays an empty start for the same id after the real call, so
              // opening a block must be idempotent per id -- never open a second,
              // empty tool block that would surface as invalid parameters.
              const isCurrent =
                blockOpen && blockKind === 'tool' && ev.id === currentToolId
              if (!isCurrent && !seenToolIds.has(ev.id)) {
                openTool(ev.id, ev.name)
              }
              if (blockOpen && blockKind === 'tool' && ev.id === currentToolId) {
                if (ev.input) {
                  toolInput = ev.input.isSnapshot
                    ? ev.input.value
                    : toolInput + ev.input.value
                }
              }
            } else if (ev.type === 'tool_stop') {
              if (blockOpen && blockKind === 'tool' && ev.id === currentToolId) {
                closeBlock()
              }
            }
          }
        }
        if (timedOut && blockOpen && blockKind === 'tool') {
          try {
            JSON.parse(toolInput || '{}')
          } catch {
            throw new Error('Kiro response stream timed out with incomplete tool input')
          }
        }
        closeBlock()
        const stopReason = sawToolUse ? 'tool_use' : 'end_turn'
        const outputTokens = outputContent
          ? Math.max(1, roughTokenCountEstimation(outputContent))
          : 0
        emit(
          sse('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: outputTokens },
          }),
        )
        emit(sse('message_stop', { type: 'message_stop' }))
        controller.close()
      } catch (err) {
        const cause = err instanceof Error
          ? `${err.name}: ${err.message}`
          : 'Unknown stream error'
        logError(
          new Error(
            `Kiro response stream failed (${cause}): ${summarizeKiroStreamDiagnostic(model, diagnostic)}`,
          ),
        )
        controller.error(err)
      }
    },
  })
}

// ── Main fetch interceptor ──────────────────────────────────────────

async function callCodeWhisperer(
  payload: KiroPayload,
  accessToken: string,
  modelId: string,
): Promise<Response> {
  try {
    return await globalThis.fetch(KIRO_CODEWHISPERER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${accessToken}`,
        // Must be the real User-Agent (not x-amz-user-agent) and contain
        // `KiroIDE`, or Enterprise accounts get "subscription does not support
        // this application".
        'User-Agent': KIRO_IDE_USER_AGENT,
      },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    const cause = err instanceof Error
      ? `${err.name}: ${err.message}`
      : 'Unknown transport error'
    const diagnostic = new Error(
      `Kiro transport request failed (modelId=${modelId}): ${cause}`,
    )
    logError(diagnostic)
    throw diagnostic
  }
}

/**
 * Creates a fetch function that intercepts Anthropic API calls and routes them
 * to Kiro's CodeWhisperer backend.
 * @param accessToken - The Kiro access token for authentication
 */
export function createKiroFetch(
  accessToken: string,
  options?: { streamIdleTimeoutMs?: number },
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const streamIdleTimeoutMs =
    options?.streamIdleTimeoutMs ?? DEFAULT_KIRO_STREAM_IDLE_TIMEOUT_MS

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    // Only intercept Anthropic API message calls
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

    const { payload, modelId } = translateToKiroBody(anthropicBody)
    const requestedModel = (anthropicBody.model as string) ?? DEFAULT_KIRO_MODEL

    // Use the freshest token (may have been refreshed elsewhere).
    let currentToken = getKiroOAuthTokens()?.accessToken || accessToken
    let response = await callCodeWhisperer(payload, currentToken, modelId)

    // On auth failure, refresh via the stored refresh token and retry once.
    if (response.status === 401 || response.status === 403) {
      const stored = getKiroOAuthTokens()
      if (stored) {
        try {
          const refreshed = await refreshKiroToken(stored)
          saveKiroOAuthTokens(refreshed)
          currentToken = refreshed.accessToken
          response = await callCodeWhisperer(payload, currentToken, modelId)
        } catch (err) {
          logError(err as Error)
        }
      }
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      const errorBody = {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Kiro request failed (${response.status}): ${text.slice(0, 500)}`,
        },
      }
      return new Response(JSON.stringify(errorBody), {
        status: response.ok ? 500 : response.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const inputTokens = estimateAnthropicInputTokens(anthropicBody)
    const anthropicStream = kiroStreamToAnthropic(
      response.body,
      requestedModel,
      inputTokens,
      streamIdleTimeoutMs,
    )
    return new Response(anthropicStream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
}
