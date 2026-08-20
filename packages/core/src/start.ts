export const CLAUDE_START_COMMAND_NAME = 'claude-start'

const START_STATUS_TITLE = '## Claude Lane Start Status'
const START_QUEUED_TITLE = '## Claude Lane Start Queued'
const START_AUTOMATIC_TITLE = '## Claude Lane Start Unavailable'
const START_OFF_TITLE = '## Claude Lane Start Disabled'
const START_USAGE_TITLE = '## Claude Lane Start Usage'
const START_USAGE =
  'Usage: `/claude-start`, `/claude-start automatic`, or `/claude-start off`.'

export type LaneStartCommandAction =
  | { type: 'fire' }
  | { type: 'automatic' }
  | { type: 'off' }
  | { type: 'usage' }

export function parseLaneStartCommandAction(
  input: string,
): LaneStartCommandAction {
  const normalized = input.trim().split(/\s+/).filter(Boolean)
  if (normalized.length === 0) return { type: 'fire' }
  if (normalized.length === 1 && normalized[0] === 'automatic') {
    return { type: 'automatic' }
  }
  if (normalized.length === 1 && normalized[0] === 'off') return { type: 'off' }
  return { type: 'usage' }
}

export function buildLaneStartStatusSummary(input: {
  automaticEnabled: boolean
}): string {
  return [
    START_STATUS_TITLE,
    '',
    `- Enabled: ${input.automaticEnabled ? 'enabled' : 'disabled'}`,
    '- Persisted: ~/.config/opencode/anthropic-auth.json',
    '- Scope: queues one-token OAuth lane-start requests',
    '- Note: automatic lane starts are not yet wired; explicit-only mode is active',
  ].join('\n')
}

export function executeLaneStartCommand(input: {
  argumentsText: string
  automaticEnabled: boolean
}): { action: LaneStartCommandAction; text: string } {
  const action = parseLaneStartCommandAction(input.argumentsText)
  if (action.type === 'fire') {
    return {
      action,
      text: [
        START_QUEUED_TITLE,
        '',
        '- Queued an explicit lane-start request.',
      ].join('\n'),
    }
  }
  if (action.type === 'automatic') {
    return {
      action,
      text: [
        START_AUTOMATIC_TITLE,
        '',
        '- Automatic lane starts are not yet wired.',
        '- No setting was changed or persisted.',
      ].join('\n'),
    }
  }
  if (action.type === 'off') {
    return {
      action,
      text: [
        START_OFF_TITLE,
        '',
        '- Automatic lane starts are disabled.',
        '- Persisted: ~/.config/opencode/anthropic-auth.json',
        '',
        buildLaneStartStatusSummary({ automaticEnabled: false }),
      ].join('\n'),
    }
  }
  return {
    action,
    text: [
      START_USAGE_TITLE,
      '',
      START_USAGE,
      '',
      buildLaneStartStatusSummary(input),
    ].join('\n'),
  }
}
