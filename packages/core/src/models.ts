export const CLAUDE_FABLE_5_MODEL_ID = 'claude-fable-5'
export const CLAUDE_MYTHOS_5_MODEL_ID = 'claude-mythos-5'

export const CLAUDE_FABLE_MYTHOS_5_MODEL_IDS = [
  CLAUDE_FABLE_5_MODEL_ID,
  CLAUDE_MYTHOS_5_MODEL_ID,
] as const

export type ClaudeFableMythos5ModelId =
  (typeof CLAUDE_FABLE_MYTHOS_5_MODEL_IDS)[number]

export const CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING = {
  type: 'adaptive',
  display: 'summarized',
} as const

export const CLAUDE_FABLE_MYTHOS_5_PRICING = {
  input: 10,
  output: 50,
  cacheRead: 1,
  cacheWrite5m: 12.5,
  cacheWrite1h: 20,
} as const

export const CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW = 1_000_000
export const CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS = 128_000
export const CLAUDE_FABLE_MYTHOS_5_RELEASE_DATE = '2026-06-09'

export const CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS: Record<
  ClaudeFableMythos5ModelId,
  { id: ClaudeFableMythos5ModelId; name: string; limited?: boolean }
> = {
  [CLAUDE_FABLE_5_MODEL_ID]: {
    id: CLAUDE_FABLE_5_MODEL_ID,
    name: 'Claude Fable 5',
  },
  [CLAUDE_MYTHOS_5_MODEL_ID]: {
    id: CLAUDE_MYTHOS_5_MODEL_ID,
    name: 'Claude Mythos 5',
    limited: true,
  },
}

export function isClaudeFableOrMythos5Model(model: unknown) {
  return (
    typeof model === 'string' &&
    CLAUDE_FABLE_MYTHOS_5_MODEL_IDS.some(
      (id) => model === id || model.startsWith(`${id}-`),
    )
  )
}

export function isOpenAIReasoningEncryptedContent(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('gAAAA')
}
