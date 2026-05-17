import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  authorize,
  CLIENT_ID,
  ClaudeOAuthRefreshError,
  CODE_CALLBACK_URL,
  exchange,
  OAUTH_SCOPES,
  refreshClaudeOAuthToken,
} from '@cortexkit/anthropic-auth-core'

afterEach(() => {
  mock.restore()
})

describe('authorize', () => {
  test('returns the hosted callback URL for max mode', async () => {
    const result = await authorize('max')

    expect(result.url).toBeString()
    expect(result.redirectUri).toBe(CODE_CALLBACK_URL)
    expect(result.verifier).toBeString()

    const url = new URL(result.url)
    expect(url.origin).toBe('https://claude.ai')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
  })

  test('returns the hosted callback URL for console mode', async () => {
    const result = await authorize('console')

    const url = new URL(result.url)
    expect(url.origin).toBe('https://platform.claude.com')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
  })

  test('sets required OAuth query params', async () => {
    const result = await authorize('max')
    const url = new URL(result.url)

    expect(url.searchParams.get('code')).toBe('true')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPES.join(' '))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(result.state)
  })

  test('does not use localhost', async () => {
    const result = await authorize('max')
    expect(result.redirectUri).not.toContain('localhost')
    expect(result.url).not.toContain('localhost')
  })
})

describe('exchange', () => {
  test('accepts code#state format', async () => {
    let capturedBody: string | undefined

    spyOn(globalThis, 'fetch').mockImplementation(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as string
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'r',
            access_token: 'a',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch)

    const result = await exchange(
      'mycode#mystate',
      'myverifier',
      CODE_CALLBACK_URL,
      'mystate',
    )

    expect(result.type).toBe('success')
    const body = JSON.parse(capturedBody!)
    expect(body.code).toBe('mycode')
    expect(body.state).toBe('mystate')
    expect(body.redirect_uri).toBe(CODE_CALLBACK_URL)
  })

  test('accepts a full callback URL', async () => {
    let capturedBody: string | undefined

    spyOn(globalThis, 'fetch').mockImplementation(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as string
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'r',
            access_token: 'a',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch)

    await exchange(
      'https://platform.claude.com/oauth/code/callback?code=mycode&state=mystate',
      'myverifier',
      CODE_CALLBACK_URL,
      'mystate',
    )

    const body = JSON.parse(capturedBody!)
    expect(body.code).toBe('mycode')
    expect(body.state).toBe('mystate')
  })

  test('returns failed on invalid callback input', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    const result = await exchange(
      'not-a-callback',
      'verifier',
      CODE_CALLBACK_URL,
    )
    expect(result.type).toBe('failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('returns failed on state mismatch', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    const result = await exchange(
      'code#wrong',
      'verifier',
      CODE_CALLBACK_URL,
      'expected',
    )
    expect(result.type).toBe('failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('ClaudeOAuthRefreshError', () => {
  test('exposes status and body', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited')
    expect(error.status).toBe(429)
    expect(error.body).toBe('rate limited')
    expect(error.message).toContain('429')
    expect(error.name).toBe('ClaudeOAuthRefreshError')
  })

  test('accepts optional retryAfter seconds', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited', 120)
    expect(error.status).toBe(429)
    expect(error.body).toBe('rate limited')
    expect(error.retryAfter).toBe(120)
  })

  test('retryAfter is undefined when not provided', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited')
    expect(error.retryAfter).toBeUndefined()
  })

  test('parses Retry-After header in seconds format', async () => {
    let thrownError: ClaudeOAuthRefreshError | null = null
    spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(
        new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '300' },
        }),
      )) as unknown as typeof fetch)

    try {
      await refreshClaudeOAuthToken({ refreshToken: 'test' })
    } catch (e) {
      if (e instanceof ClaudeOAuthRefreshError) thrownError = e
    }

    expect(thrownError?.status).toBe(429)
    expect(thrownError?.body).toBe('rate limited')
    expect(thrownError?.retryAfter).toBe(300)
  })

  test('parses Retry-After header in HTTP-date format', async () => {
    const now = Date.parse('2026-05-17T14:25:00.000Z')
    const futureDate = new Date(now + 600_000).toUTCString()
    spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(
        new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': futureDate },
        }),
      )) as unknown as typeof fetch)

    let thrownError: ClaudeOAuthRefreshError | null = null
    try {
      await refreshClaudeOAuthToken({ refreshToken: 'test', now: () => now })
    } catch (e) {
      if (e instanceof ClaudeOAuthRefreshError) thrownError = e
    }

    expect(thrownError?.status).toBe(429)
    expect(thrownError?.retryAfter).toBe(600)
  })

  test('retryAfter is undefined for invalid Retry-After header', async () => {
    spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(
        new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': 'not-a-number' },
        }),
      )) as unknown as typeof fetch)

    let thrownError: ClaudeOAuthRefreshError | null = null
    try {
      await refreshClaudeOAuthToken({ refreshToken: 'test' })
    } catch (e) {
      if (e instanceof ClaudeOAuthRefreshError) thrownError = e
    }

    expect(thrownError?.status).toBe(429)
    expect(thrownError?.retryAfter).toBeUndefined()
  })
})

describe('refreshClaudeOAuthToken', () => {
  test('uses Anthropic platform JSON refresh path and preserves omitted refresh rotations', async () => {
    let capturedUrl: string | undefined
    let capturedBody: string | undefined
    let capturedHeaders: Headers | undefined

    const result = await refreshClaudeOAuthToken({
      refreshToken: 'old-refresh',
      now: () => 1_000,
      fetchImpl: mock((input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input)
        capturedBody = String(init?.body)
        capturedHeaders = new Headers(init?.headers)
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: 'new-access', expires_in: 3600 }),
            { status: 200 },
          ),
        )
      }) as unknown as typeof fetch,
    })

    expect(capturedUrl).toBe('https://platform.claude.com/v1/oauth/token')
    expect(capturedHeaders?.get('content-type')).toBe('application/json')
    const body = JSON.parse(capturedBody ?? '{}')
    expect(body.grant_type).toBe('refresh_token')
    expect(body.refresh_token).toBe('old-refresh')
    expect(body.client_id).toBe(CLIENT_ID)
    expect(result).toEqual({
      access: 'new-access',
      refresh: 'old-refresh',
      expires: 3_601_000,
      expiresIn: 3600,
    })
  })

  test('does not retry 429 — throws immediately with retryAfter', async () => {
    let callCount = 0
    spyOn(globalThis, 'fetch').mockImplementation((() => {
      callCount++
      return Promise.resolve(
        new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '120' },
        }),
      )
    }) as unknown as typeof fetch)

    await expect(
      refreshClaudeOAuthToken({ refreshToken: 'test' }),
    ).rejects.toThrow('Claude OAuth refresh failed: 429')

    expect(callCount).toBe(1)
  })
})
