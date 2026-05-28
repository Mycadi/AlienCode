import chalk from 'chalk'
import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import {
  applyApiKeyProfileToEnv,
  readApiKeyConfig,
  setCurrentApiKeyProfile,
  type ApiKeyProfile,
} from '../../utils/apikey.js'

function describeProfile(profile: ApiKeyProfile): string {
  const parts = []
  if (profile.ANTHROPIC_MODEL) parts.push(`model: ${profile.ANTHROPIC_MODEL}`)
  if (profile.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    parts.push(`haiku: ${profile.ANTHROPIC_DEFAULT_HAIKU_MODEL}`)
  }
  if (profile.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    parts.push(`sonnet: ${profile.ANTHROPIC_DEFAULT_SONNET_MODEL}`)
  }
  if (profile.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    parts.push(`opus: ${profile.ANTHROPIC_DEFAULT_OPUS_MODEL}`)
  }
  if (profile.CLAUDE_CODE_SUBAGENT_MODEL) {
    parts.push(`subagent: ${profile.CLAUDE_CODE_SUBAGENT_MODEL}`)
  }
  if (profile.ANTHROPIC_BASE_URL) parts.push(profile.ANTHROPIC_BASE_URL)
  return parts.join(' · ')
}

function formatSuccess(name: string, profile: ApiKeyProfile): string {
  const details = describeProfile(profile)
  return details
    ? `Set API key profile to ${chalk.bold(name)} (${details})`
    : `Set API key profile to ${chalk.bold(name)}`
}

function useApplyProfile(onDone: LocalJSXCommandOnDone): (name: string) => void {
  const setAppState = useSetAppState()

  return React.useCallback(
    (name: string) => {
      const result = setCurrentApiKeyProfile(name)
      if (!result.ok) {
        onDone(result.error, { display: 'system' })
        return
      }

      applyApiKeyProfileToEnv(result.profile)
      if (result.profile.ANTHROPIC_MODEL) {
        setAppState(prev => ({
          ...prev,
          mainLoopModel: result.profile.ANTHROPIC_MODEL ?? null,
          mainLoopModelForSession: null,
        }))
      }

      onDone(formatSuccess(result.name, result.profile))
    },
    [onDone, setAppState],
  )
}

function NotifyAndClose({
  message,
  onDone,
}: {
  message: string
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  React.useEffect(() => {
    onDone(message, { display: 'system' })
  }, [message, onDone])
  return null
}

function ApiKeyPicker({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const result = readApiKeyConfig()
  const applyProfile = useApplyProfile(onDone)

  if (!result.ok) {
    const message = result.missing
      ? `Create ${result.path} with API key profiles first.`
      : result.error
    return <NotifyAndClose message={message} onDone={onDone} />
  }

  const names = Object.keys(result.config.profiles)
  if (names.length === 0) {
    return (
      <NotifyAndClose
        message="No API key profiles found in apikey.json."
        onDone={onDone}
      />
    )
  }

  return (
    <Select
      options={names.map(name => ({
        label: name,
        value: name,
        description: describeProfile(result.config.profiles[name]),
      }))}
      defaultValue={result.config.current}
      onChange={applyProfile}
      onCancel={() => onDone('Kept current API key profile', { display: 'system' })}
    />
  )
}

function SetApiKeyAndClose({
  args,
  onDone,
}: {
  args: string
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const applyProfile = useApplyProfile(onDone)
  React.useEffect(() => {
    applyProfile(args.trim())
  }, [applyProfile, args])
  return null
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const profile = args.trim()
  if (profile) {
    return <SetApiKeyAndClose args={profile} onDone={onDone} />
  }
  return <ApiKeyPicker onDone={onDone} />
}
