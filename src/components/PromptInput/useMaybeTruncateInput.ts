import type { PastedContent } from 'src/utils/config.js'

type Props = {
  input: string
  pastedContents: Record<number, PastedContent>
  onInputChange: (input: string) => void
  setCursorOffset: (offset: number) => void
  setPastedContents: (contents: Record<number, PastedContent>) => void
}

export function useMaybeTruncateInput({
  input: _input,
  pastedContents: _pastedContents,
  onInputChange: _onInputChange,
  setCursorOffset: _setCursorOffset,
  setPastedContents: _setPastedContents,
}: Props) {
  // Truncation disabled — LLMs support 1M+ context tokens; silently
  // dropping middle content at 10k characters causes data loss that the
  // user cannot recover.  The pasted-text folding path
  // (onTextPaste → [Pasted text #N]) already keeps long pastes
  // manageable in the input box without destroying content.
}
