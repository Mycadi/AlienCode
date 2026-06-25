// Goal evaluator — uses sideQuery (Haiku) to verify if a goal has been met.

import type { GoalState } from './goalState.js'
import { sideQuery } from '../../utils/sideQuery.js'
import { getSmallFastModel } from '../../utils/model/model.js'
import type { Message } from '../../types/message.js'

const GOAL_EVALUATOR_TOOL = {
  name: 'evaluate_goal',
  description: 'Evaluate whether a goal has been achieved',
  input_schema: {
    type: 'object' as const,
    properties: {
      completed: {
        type: 'boolean',
        description:
          'Whether the goal has been fully achieved based on the conversation evidence',
      },
      reasoning: {
        type: 'string',
        description:
          'Brief reasoning for the completion judgment (1-2 sentences)',
      },
    },
    required: ['completed', 'reasoning'],
  },
}

const EVALUATOR_SYSTEM_PROMPT =
  'You are a goal completion evaluator. Given a goal and recent conversation history, ' +
  'determine whether the goal has been fully achieved.\n\n' +
  'Be strict: the goal must be demonstrably met, not just attempted. ' +
  'If the assistant said it finished but there is evidence of errors or incomplete work, ' +
  'mark as not completed.\n\n' +
  'If the goal is ambiguous about the completion criteria, lean toward "completed" ' +
  'if the assistant made a reasonable good-faith effort and produced visible results.'

/**
 * Extract a compact summary of recent messages for the evaluator.
 * Only includes the last few assistant + user messages to keep token usage low.
 */
function buildTranscriptSummary(messages: Message[]): string {
  const recent = messages.slice(-10)
  const lines: string[] = []
  for (const msg of recent) {
    if (msg.role === 'assistant' || msg.role === 'user') {
      const textParts: string[] = []
      if (typeof msg.content === 'string') {
        textParts.push(msg.content)
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'tool_result') {
            // Summarize tool results briefly
            if (typeof block.content === 'string') {
              textParts.push(`[tool result: ${block.content.slice(0, 200)}]`)
            }
          } else if (block.type === 'tool_use') {
            textParts.push(`[tool call: ${block.name}]`)
          }
        }
      }
      const text = textParts.join('\n').slice(0, 500)
      if (text) {
        lines.push(`${msg.role}: ${text}`)
      }
    }
  }
  return lines.join('\n\n')
}

export async function evaluateGoalCompletion(
  goal: GoalState,
  messages: Message[],
  signal?: AbortSignal,
): Promise<{ completed: boolean; reasoning: string }> {
  const transcript = buildTranscriptSummary(messages)
  const model = getSmallFastModel()

  const response = await sideQuery({
    model,
    system: EVALUATOR_SYSTEM_PROMPT,
    skipSystemPromptPrefix: true,
    temperature: 0,
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content:
          `Goal: ${goal.goalText}\n\n` +
          `Turns elapsed: ${goal.turnsElapsed}\n\n` +
          `Recent conversation:\n${transcript}\n\n` +
          `Has the goal been fully achieved?`,
      },
    ],
    tools: [GOAL_EVALUATOR_TOOL],
    tool_choice: { type: 'tool', name: 'evaluate_goal' },
    signal,
    querySource: 'goal_evaluator' as const,
  })

  const toolUseBlock = response.content.find(c => c.type === 'tool_use')
  if (toolUseBlock && toolUseBlock.type === 'tool_use') {
    const input = toolUseBlock.input as {
      completed?: boolean
      reasoning?: string
    }
    return {
      completed: input.completed === true,
      reasoning: input.reasoning ?? 'No reasoning provided',
    }
  }

  // Fallback: if no tool_use block, assume not completed
  return { completed: false, reasoning: 'Evaluator did not produce a result' }
}
