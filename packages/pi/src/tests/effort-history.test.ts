import { describe, expect, test } from 'bun:test'
import {
  buildContextEntries,
  collectPiEffortHistory,
  resolveSessionLeafId,
} from '../effort-history.ts'

const entry = (
  id: string,
  type: string,
  extra: Record<string, unknown> = {},
) => ({ id, type, ...extra })

describe('Pi Fable 5.1 effort history', () => {
  test('maps thinking-level changes to assistant boundaries', () => {
    const branch = [
      entry('t0', 'thinking_level_change', { thinkingLevel: 'minimal' }),
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('a1', 'message', { message: { role: 'assistant' } }),
      entry('t1', 'thinking_level_change', { thinkingLevel: 'high' }),
      entry('u2', 'message', { message: { role: 'user' } }),
      entry('a2', 'message', { message: { role: 'assistant' } }),
      entry('t2', 'thinking_level_change', { thinkingLevel: 'xhigh' }),
      entry('tool', 'message', { message: { role: 'toolResult' } }),
    ]
    expect(collectPiEffortHistory(branch, branch)).toEqual([
      { afterAssistantMessages: 0, effort: 'low' },
      { afterAssistantMessages: 1, effort: 'high' },
      { afterAssistantMessages: 2, effort: 'xhigh' },
    ])
  })

  test('folds pre-compaction effort into the new prefix and tracks later changes', () => {
    const fullBranch = [
      entry('t0', 'thinking_level_change', { thinkingLevel: 'low' }),
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('a1', 'message', { message: { role: 'assistant' } }),
      entry('t1', 'thinking_level_change', { thinkingLevel: 'high' }),
      entry('u2', 'message', { message: { role: 'user' } }),
      entry('a2', 'message', { message: { role: 'assistant' } }),
      entry('compact', 'compaction'),
      entry('t2', 'thinking_level_change', { thinkingLevel: 'xhigh' }),
      entry('u3', 'message', { message: { role: 'user' } }),
    ]
    const contextEntries = [
      fullBranch[6]!,
      fullBranch[3]!,
      fullBranch[4]!,
      fullBranch[5]!,
      fullBranch[7]!,
      fullBranch[8]!,
    ]
    expect(collectPiEffortHistory(contextEntries, fullBranch)).toEqual([
      { afterAssistantMessages: 0, effort: 'high' },
      { afterAssistantMessages: 1, effort: 'xhigh' },
    ])
  })
})

describe('buildContextEntries', () => {
  const contextEntry = (
    id: string,
    parentId: string | null,
    type = 'message',
    extra: Record<string, unknown> = {},
  ) => ({ id, parentId, type, ...extra })

  test('uses the latest entry when the host has no leaf method', () => {
    const entries = [contextEntry('a', null), contextEntry('b', 'a')]
    expect(
      buildContextEntries(entries, undefined).map((entry) => entry.id),
    ).toEqual(['a', 'b'])
  })

  test('preserves an absent host leaf method as undefined', () => {
    const host = { getEntries: () => [] }
    expect(resolveSessionLeafId(host)).toBeUndefined()
    expect(
      buildContextEntries(
        [contextEntry('a', null), contextEntry('b', 'a')],
        resolveSessionLeafId(host),
      ).map((entry) => entry.id),
    ).toEqual(['a', 'b'])
  })

  test('preserves an explicit null host leaf', () => {
    const host = { getLeafId: () => null }
    expect(resolveSessionLeafId(host)).toBeNull()
  })

  test('returns no entries for an explicit null leaf', () => {
    const entries = [contextEntry('a', null)]
    expect(buildContextEntries(entries, null)).toEqual([])
  })

  test('follows a leaf path from the root', () => {
    const entries = [
      contextEntry('a', null),
      contextEntry('b', 'a'),
      contextEntry('c', 'b'),
      contextEntry('other', 'a'),
    ]
    expect(buildContextEntries(entries, 'c').map((entry) => entry.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  test('keeps a compaction and entries starting at firstKeptEntryId', () => {
    const entries = [
      contextEntry('a', null),
      contextEntry('kept', 'a'),
      contextEntry('drop', 'kept'),
      contextEntry('compact', 'drop', 'compaction', {
        firstKeptEntryId: 'kept',
      }),
      contextEntry('after', 'compact'),
    ]
    expect(
      buildContextEntries(entries, 'after').map((entry) => entry.id),
    ).toEqual(['compact', 'kept', 'drop', 'after'])
  })

  test('returns the full path when there is no compaction', () => {
    const entries = [contextEntry('a', null), contextEntry('b', 'a')]
    expect(buildContextEntries(entries, 'b').map((entry) => entry.id)).toEqual([
      'a',
      'b',
    ])
  })

  test('uses only the latest compaction on the path', () => {
    const entries = [
      contextEntry('a', null),
      contextEntry('kept1', 'a'),
      contextEntry('compact1', 'kept1', 'compaction', {
        firstKeptEntryId: 'kept1',
      }),
      contextEntry('kept2', 'compact1'),
      contextEntry('compact2', 'kept2', 'compaction', {
        firstKeptEntryId: 'kept2',
      }),
      contextEntry('after', 'compact2'),
    ]
    expect(
      buildContextEntries(entries, 'after').map((entry) => entry.id),
    ).toEqual(['compact2', 'kept2', 'after'])
  })

  test('passes branch summaries through unchanged', () => {
    const summary = contextEntry('summary', 'a', 'branch_summary', {
      summary: 'branch',
    })
    const entries = [contextEntry('a', null), summary]
    expect(buildContextEntries(entries, 'summary')).toEqual(entries)
  })
})
