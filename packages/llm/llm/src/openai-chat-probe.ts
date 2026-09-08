/**
 * The one request a connection check sends: the smallest chat completion an
 * OpenAI-compatible endpoint accepts — one user message and an output cap of
 * a single token.
 *
 * This is the wire shape both OpenAI-compatible adapters already speak, and
 * the reason the shape lives here rather than in either of them: a probe is a
 * configuration-time action, so each adapter resolves its own endpoint,
 * credential, and model and then hands the result to this one function instead
 * of carrying a second, drifting copy of the request.
 *
 * The probe costs the provider one token. It buys the only answer a listing
 * request cannot give: that the endpoint, the credential, AND the model id all
 * work together. A `GET /models` skips the model id, and gateways answer it
 * unauthenticated.
 *
 * @module @deepseek-ai/dsh-llm/openai-chat-probe
 */

import { INVALID_CREDENTIAL_CODE, LlmError } from './error.ts'
import { normalizeApiKey } from './api-key.ts'
import { attributionHeaders } from './attribution.ts'
import type { LlmConnectionCheckResult } from './types.ts'

/**
 * Reply bodies larger than this are refused. The endpoint is whatever URL the
 * user typed, so the ceiling holds on the bytes actually read rather than on
 * the length the server claims. One token of output is a few hundred bytes;
 * the ceiling leaves room for a gateway's own envelope without transferring
 * anything a hostile endpoint could use to exhaust memory.
 */
const MAX_RESPONSE_BYTES = 64 * 1024

/** The message a hello probe sends. */
const HELLO = 'hi'

/** The output cap a hello probe asks for: the smallest a completion accepts. */
const MAX_TOKENS = 1

/** What one hello probe addresses. */
export interface OpenAiChatProbe {
  /** Endpoint base, without a trailing slash requirement. */
  baseURL: string
  /** Model the endpoint must accept. */
  model: string
  /** Credential to send; absent probes unauthenticated. */
  apiKey?: string
  /** Caller cancellation. */
  signal?: AbortSignal
}

/**
 * Accept one probe key, or refuse it before the header is built. Without this
 * the `fetch` below would throw a ByteString `TypeError` that this function's
 * catch reports as `could not reach <url>` — blaming the network for a local,
 * deterministic fault.
 * @param raw - the key supplied for this probe alone.
 * @returns the trimmed, usable key.
 */
function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

/**
 * Read a reply body, refusing one that outgrows the ceiling.
 * @param response - the reply to read.
 * @returns the decoded body text.
 */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new LlmError(
      `${response.url} answered with more than ${MAX_RESPONSE_BYTES} bytes`,
      'CONNECTION_CHECK_FAILED',
    )
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        throw new LlmError(
          `${response.url} answered with more than ${MAX_RESPONSE_BYTES} bytes`,
          'CONNECTION_CHECK_FAILED',
        )
      }
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Send one hello completion to an OpenAI-compatible endpoint.
 * @param probe - the endpoint, model, credential, and cancellation to use.
 * @returns the endpoint and model that answered.
 * @throws LlmError when the credential cannot be sent, the endpoint cannot be
 * reached, or it refuses or fails the request.
 */
export async function probeOpenAiChatCompletion(probe: OpenAiChatProbe): Promise<LlmConnectionCheckResult> {
  const url = `${probe.baseURL.replace(/\/+$/, '')}/chat/completions`
  const apiKey = probe.apiKey === undefined ? undefined : usableProbeKey(probe.apiKey)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
        ...attributionHeaders(),
      },
      body: JSON.stringify({
        model: probe.model,
        messages: [{ role: 'user', content: HELLO }],
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
      ...probe.signal === undefined ? {} : { signal: probe.signal },
    })
  } catch (error: unknown) {
    if (probe.signal?.aborted === true) {
      throw new LlmError('connection check aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'CONNECTION_CHECK_FAILED', { cause: error })
  }
  if (!response.ok) {
    const detail = await readBounded(response).catch(() => '')
    const providerMessage = parseProviderMessage(detail)
    throw new LlmError(
      `${url} answered ${response.status}${authHint(response.status)}${providerMessage}`,
      'CONNECTION_CHECK_FAILED',
    )
  }
  return { baseURL: probe.baseURL, model: probe.model }
}

/**
 * The provider's own wording for a refusal, when it sent any worth repeating.
 * @param detail - the raw error body.
 * @returns a suffix carrying it, or the empty string.
 */
function parseProviderMessage(detail: string): string {
  try {
    const message = (JSON.parse(detail) as { error?: { message?: unknown } }).error?.message
    return typeof message === 'string' && message.length > 0 ? `: ${message}` : ''
  } catch {
    // A non-JSON error body leaves the HTTP status as the whole report.
    return ''
  }
}

/**
 * Whether a status is the one a bad credential produces, so the report says
 * what to check instead of only naming the number.
 * @param status - HTTP status the endpoint answered.
 * @returns the hint suffix, or the empty string.
 */
function authHint(status: number): string {
  return status === 401 || status === 403 ? '; check the API key' : ''
}
