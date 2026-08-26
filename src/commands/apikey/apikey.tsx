import chalk from 'chalk'
import * as React from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import {
  applyApiKeyProfileToEnv,
  formatApiKeyModelRef,
  readApiKeyConfig,
  setCurrentApiKeyProfile,
  type ApiKeyProfile,
} from '../../utils/apikey.js'

// Sentinel for the "no profile" entry. Not a valid JSON object key collision
// risk since profile names come from apikey.json's `profiles` map.
const NONE_VALUE = '\u0000none'

function isNoneArg(value: string): boolean {
  const normalized = value.toLowerCase()
  return normalized === 'none' || normalized === 'off' || normalized === 'null'
}

function describeProfile(profile: ApiKeyProfile): string {
  const models = [
    profile.ANTHROPIC_MODEL,
    profile.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    profile.ANTHROPIC_DEFAULT_SONNET_MODEL,
    profile.ANTHROPIC_DEFAULT_OPUS_MODEL,
    profile.CLAUDE_CODE_SUBAGENT_MODEL,
  ].filter(Boolean)
  return models.length > 0 ? `model: ${models.join('、')}` : ''
}

function formatSuccess(name: string, profile: ApiKeyProfile): string {
  const details = describeProfile(profile)
  return details
    ? `Set API key profile to ${chalk.bold(name)} (${details})`
    : `Set API key profile to ${chalk.bold(name)}`
}

function useApplyProfile(
  onDone: LocalJSXCommandOnDone,
): (name: string | null) => void {
  const setAppState = useSetAppState()

  return React.useCallback(
    (name: string | null) => {
      const result = setCurrentApiKeyProfile(name)
      if (!result.ok) {
        onDone(result.error, { display: 'system' })
        return
      }

      applyApiKeyProfileToEnv(result.profile, name)
      const profileModel = result.profile.ANTHROPIC_MODEL
      setAppState(prev => ({
        ...prev,
        // Pin the profile's model as an apikey ref so a logged-in Kiro/Codex
        // account can't take over a colliding model id.
        mainLoopModel:
          name && profileModel ? formatApiKeyModelRef(name, profileModel) : null,
        mainLoopModelForSession: null,
      }))

      onDone(
        name === null
          ? 'Cleared API key profile (using /login account)'
          : formatSuccess(result.name, result.profile),
      )
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
      visibleOptionCount={10}
      options={[
        {
          label: 'None',
          value: NONE_VALUE,
          description: 'Use the account from /login',
        },
        ...names.map(name => ({
          label: name,
          value: name,
          description: describeProfile(result.config.profiles[name]),
        })),
      ]}
      defaultValue={result.config.current ?? NONE_VALUE}
      onChange={value => applyProfile(value === NONE_VALUE ? null : value)}
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
    const name = args.trim()
    applyProfile(isNoneArg(name) ? null : name)
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
