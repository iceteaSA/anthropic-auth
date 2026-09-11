export const ANTHROPIC_CUSTOM_HEADERS_ENV = 'ANTHROPIC_CUSTOM_HEADERS'

export function parseCustomHeaders(raw: string | undefined): Headers {
  const headers = new Headers()
  if (!raw?.trim()) return headers

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
    return headers
  }

  const parsed = JSON.parse(trimmed) as unknown
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${ANTHROPIC_CUSTOM_HEADERS_ENV} must be a JSON object`)
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      headers.set(key, value.map(String).join(', '))
    } else {
      headers.set(key, String(value))
    }
  }

  return headers
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
