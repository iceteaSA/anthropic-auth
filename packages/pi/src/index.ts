import {
  authorize,
  CLIENT_ID,
  exchange,
  TOKEN_URL,
} from '@cortexkit/anthropic-auth-core'
import type { OAuthCredentials, OAuthLoginCallbacks } from '@mariozechner/pi-ai'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'

import { registerCommands } from './commands.ts'
import { streamCortexKitAnthropic } from './stream.ts'

async function loginAnthropic(
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const auth = await authorize('max')
  callbacks.onAuth({ url: auth.url })
  const callback = await callbacks.onPrompt({
    message: 'Paste the Claude OAuth callback URL or code:',
  })
  const result = await exchange(
    callback,
    auth.verifier,
    auth.redirectUri,
    auth.state,
  )
  if (result.type !== 'success') {
    throw new Error('Anthropic OAuth exchange failed')
  }
  return {
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
  }
}

async function refreshAnthropicToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'axios/1.13.6',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: credentials.refresh,
    }),
  })

  if (!response.ok) {
    throw new Error(`Anthropic OAuth refresh failed: ${await response.text()}`)
  }

  const json = (await response.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }

  return {
    refresh: json.refresh_token ?? credentials.refresh,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

export default function cortexKitPiAnthropicAuth(pi: ExtensionAPI) {
  registerCommands(pi)

  pi.registerProvider('anthropic', {
    name: 'Anthropic (CortexKit OAuth)',
    baseUrl: 'https://api.anthropic.com',
    api: 'cortexkit-anthropic-messages',
    models: [
      {
        id: 'claude-opus-4-5',
        name: 'Claude Opus 4.5',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
      {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    ],
    oauth: {
      name: 'Anthropic Claude Pro/Max (CortexKit)',
      login: loginAnthropic,
      refreshToken: refreshAnthropicToken,
      getApiKey: (credentials) => credentials.access,
    },
    streamSimple: streamCortexKitAnthropic,
  })
}
