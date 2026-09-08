/**
 * Answering "can this configuration actually serve a request?" for the
 * configuration surface's 连接验证 action.
 *
 * The DeepSeek endpoint is OpenAI-compatible, so the probe is the shared hello
 * completion: one user message and an output cap of one token. It costs the
 * provider a single token and answers what nothing else can — that the
 * endpoint, the credential, AND the model id all work together.
 *
 * The draft carries whatever the surface is still editing; everything it leaves
 * out is resolved from the same per-request options a real call would use, so
 * what is probed is what a conversation would send rather than a second,
 * drifting resolution.
 *
 * @module dsh-llm-deepseek/connection-check
 */

import { LlmError, probeOpenAiChatCompletion } from '@deepseek-ai/dsh-llm'
import type { LlmConnectionCheckOperation, LlmConnectionCheckResult } from '@deepseek-ai/dsh-llm'
import type { DeepSeekConnectionOptions } from './adapter.ts'

/**
 * Probe one draft DeepSeek configuration.
 * @param request - the draft endpoint, model, and one-shot credential.
 * @param options - the resolved connection facts a request would use.
 * @param storedApiKey - the credential those facts resolve, asked for only
 *   when the draft carries none: a configuration surface edits a redacted
 *   descriptor and never holds a stored secret, so without this an
 *   already-configured route would be probed unauthenticated and answer 401.
 * @returns the endpoint and model that answered.
 * @throws LlmError when no model can be named, or the endpoint refuses or
 *   fails the request.
 */
export async function checkConnection(
  request: LlmConnectionCheckOperation,
  options: DeepSeekConnectionOptions,
  storedApiKey: () => Promise<string | undefined>,
): Promise<LlmConnectionCheckResult> {
  const baseURL = request.baseURL ?? options.baseURL
  const model = request.model ?? options.models[0]?.id
  if (model === undefined) {
    throw new LlmError(
      'llm-deepseek: no model to probe; the configured catalog is empty, so add a model to this provider first',
      'CONNECTION_CHECK_FAILED',
    )
  }
  // A key typed into the form wins: it is the one the user is testing, and it
  // may be the replacement for exactly the stored key that is failing.
  const apiKey = request.apiKey ?? await storedApiKey()
  return await probeOpenAiChatCompletion({
    baseURL,
    model,
    ...apiKey === undefined ? {} : { apiKey },
    ...request.signal === undefined ? {} : { signal: request.signal },
  })
}
