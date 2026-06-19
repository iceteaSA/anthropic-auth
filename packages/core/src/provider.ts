/**
 * Duck-typed error contract for provider HTTP errors.
 *
 * Shared-core extraction of anthropic-auth and openai-auth is mechanical
 * when all error classification uses this contract instead of instanceof
 * or message-regex matching on provider-specific error classes.
 */
export type ProviderHttpError = {
  /** HTTP status code. */
  status?: number
  /** Parsed Retry-After header value in seconds, if the server provided one. */
  retryAfter?: number
}
