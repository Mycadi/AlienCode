import type {
  ContentBlockParam,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Tools } from '../../Tool.js'
import { getApiKeyProfile } from '../../utils/apikey.js'
import { getContentText } from '../../utils/messages.js'
import { getDefaultSonnetModel, getMainLoopModel } from '../../utils/model/model.js'
import { resolveVisionConfigForModel } from '../../utils/model/visionConfig.js'
import { modelSupportsVision } from '../../utils/model/vision.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { queryWithModel } from './claude.js'

export type VisionProxyOptions = {
  querySource?: QuerySource
  mcpTools?: Tools
  signal?: AbortSignal
  mainModel?: string
}

const DEFAULT_VISION_PROMPT =
  '请详细描述这张图片，包含可见文字、界面结构、关键对象、位置关系和可能与用户问题相关的信息。不要回答用户问题，只描述图片内容。'

export function shouldProxyImagesThroughVision(model = getMainLoopModel()): boolean {
  const vision = resolveVisionConfigForModel(model)
  if (!vision.enabled) return false
  if (vision.proxyMode === 'never') return false
  if (vision.proxyMode === 'always') return true

  return !modelSupportsVision(model)
}

export async function describeImagesForTextModel({
  images,
  userText,
  options = {},
}: {
  images: ImageBlockParam[]
  userText?: string | null
  options?: VisionProxyOptions
}): Promise<ContentBlockParam[]> {
  if (images.length === 0) return []

  const vision = resolveVisionConfigForModel(options.mainModel ?? getMainLoopModel())
  const profileResult = vision.apiKeyProfile
    ? getApiKeyProfile(vision.apiKeyProfile)
    : undefined
  if (profileResult && !profileResult.ok) {
    return images.map((_, index) => ({
      type: 'text',
      text: formatVisionDescription(index + 1, `图片解析失败：${profileResult.error}`),
    }))
  }

  const apiKeyProfile = profileResult?.ok ? profileResult.profile : undefined
  const model =
    vision.visionModel || apiKeyProfile?.ANTHROPIC_MODEL || getDefaultSonnetModel()
  const prompt = vision.prompt || DEFAULT_VISION_PROMPT
  const signal = options.signal ?? new AbortController().signal

  const descriptions = await Promise.all(
    images.map(async (image, index) => {
      try {
        const result = await queryWithModel({
          systemPrompt: asSystemPrompt([prompt]),
          userPrompt: buildVisionPrompt(image, userText),
          signal,
          options: {
            model,
            querySource: options.querySource ?? 'sdk',
            agents: [],
            isNonInteractiveSession: true,
            hasAppendSystemPrompt: false,
            mcpTools: options.mcpTools ?? [],
            apiKeyProfile,
            maxOutputTokensOverride: 1500,
          },
        })
        const text = getContentText(result.message.content)?.trim()
        return formatVisionDescription(index + 1, text || '视觉模型未返回图片描述。')
      } catch (error) {
        if (signal.aborted) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        return formatVisionDescription(
          index + 1,
          `图片解析失败：${message.slice(0, 500)}`,
        )
      }
    }),
  )

  return descriptions.map(text => ({ type: 'text', text }))
}

function buildVisionPrompt(
  image: ImageBlockParam,
  userText?: string | null,
): ContentBlockParam[] {
  const text = userText?.trim()
    ? `用户原始问题：\n${userText}\n\n请结合用户问题描述这张图片。`
    : '请描述这张图片。'
  return [{ type: 'text', text }, image]
}

function formatVisionDescription(index: number, text: string): string {
  return `[Vision analysis for image ${index}]\n${text}\n[/Vision analysis for image ${index}]`
}
