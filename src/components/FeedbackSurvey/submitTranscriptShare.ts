/**
 * Transcript sharing is intentionally removed in this build.
 *
 * This file preserves the public API used by the feedback survey hooks while
 * ensuring no transcript data is uploaded. The survey UI continues to work;
 * selecting "share" simply reports failure without any network activity.
 */

import type { Message } from '../../types/message.js'

type TranscriptShareResult = {
  success: boolean
  transcriptId?: string
}

export type TranscriptShareTrigger =
  | 'bad_feedback_survey'
  | 'good_feedback_survey'
  | 'frustration'
  | 'memory_survey'

export async function submitTranscriptShare(
  _messages: Message[],
  _trigger: TranscriptShareTrigger,
  _appearanceId: string,
): Promise<TranscriptShareResult> {
  return { success: false }
}
