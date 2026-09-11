import { logger } from './logger.ts'

export const ANTHROPIC_CUSTOM_HEADERS_ENV = 'ANTHROPIC_CUSTOM_HEADERS'

type HeaderEntries = Array<[string, string]>

const parsedHeadersByRawValue = new Map<string, HeaderEntries | null>()
const warnedMalformedRawValues = new Set<string>()

export function parseCustomHeaders(raw: string | undefined): Headers {
  if (!raw?.trim()) return new Headers()

  const cached = parsedHeadersByRawValue.get(raw)
  if (cached !== undefined || parsedHeadersByRawValue.has(raw)) {
    return new Headers(cached ?? [])
  }

  try {
    const headers = new Headers()
    const trimmed = raw.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      for (const entry of trimmed
        .split(/\r?\n|,(?=[^,\s:]+:)/)
        .map((value) => value.trim())
        .filter(Boolean)) {
        const separator = entry.indexOf(':')
        if (separator <= 0) {
          throw new TypeError(
            `${ANTHROPIC_CUSTOM_HEADERS_ENV} entries must be "name: value"`,
          )
        }
        headers.set(
          entry.slice(0, separator).trim(),
          entry.slice(separator + 1).trim(),
        )
      }
    } else {
      const parsed = JSON.parse(trimmed) as unknown
      if (
        parsed == null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        throw new TypeError(
          `${ANTHROPIC_CUSTOM_HEADERS_ENV} must be a JSON object`,
        )
      }

      for (const [key, value] of Object.entries(parsed)) {
        if (value == null) continue
        if (Array.isArray(value)) {
          headers.set(key, value.map(String).join(', '))
        } else {
          headers.set(key, String(value))
        }
      }
    }

    const entries = [...headers.entries()] as HeaderEntries
    parsedHeadersByRawValue.set(raw, entries)
    return new Headers(entries)
  } catch (error) {
    parsedHeadersByRawValue.set(raw, null)
    if (!warnedMalformedRawValues.has(raw)) {
      warnedMalformedRawValues.add(raw)
      logger.warn(
        'custom-headers',
        'ignoring malformed ANTHROPIC_CUSTOM_HEADERS',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      )
    }
    return new Headers()
  }
}

export function applyCustomHeaders(
  headers: Headers,
  raw = process.env[ANTHROPIC_CUSTOM_HEADERS_ENV],
): Headers {
  const customHeaders = parseCustomHeaders(raw)
  customHeaders.forEach((value, key) => {
    headers.set(key, value)
  })
  return headers
}
