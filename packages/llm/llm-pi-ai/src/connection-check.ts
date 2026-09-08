/**
 * Answering "can this configuration actually serve a request?" for the
 * configuration surface's 连接验证 action.
 *
 * Unlike {@link ./discovery.ts}, this never answers from the installed catalog:
 * a catalog answers *which models exist*, which says nothing about whether the
 * stored credential and the endpoint in front of it work. The probe always
 * reaches the network.
 *
 * Only `openai-completions` is probed. It is the shape a gateway, a
 * self-hosted server, and every vendor endpoint this build can serve agree on;
 * every other protocol is reported as unprobeable so the surface says so
 * rather than sending a request whose response shape it could not read.
 *
 * @module dsh-llm-pi-ai/connection-check
 */

import { LlmError, probeOpenAiChatCompletion } from '@deepseek-ai/dsh-llm'
import type { LlmConnectionCheckOperation, LlmConnectionCheckResult } from '@deepseek-ai/dsh-llm'
import { catalogProvider } from './catalog.ts'
import type { Provider } from '@earendil-works/pi-ai'
import type { ResolvedPiAiProviderProfile } from './config.ts'

/** The one protocol whose chat completions this build probes. */
const PROBEABLE_PROTOCOL = 'openai-completions'

/**
 * What the plugin supplies beyond the draft: the route the draft names, when
 * one exists, and the credential that route already resolves.
 *
 * A configuration surface edits a redacted descriptor and never holds a stored
 * secret, so a route whose key was saved earlier must have it supplied here or
 * the probe would go out unauthenticated and report a 401 the user cannot act
 * on.
 */
export interface ConnectionCheckContext {
  /** The stored profile of the route the draft names, when there is one. */
  profile: ResolvedPiAiProviderProfile | undefined
  /** The credential that route already resolves, asked for only when the draft carries none. */
  storedApiKey: () => Promise<string | undefined>
}

/**
 * The pi-ai provider of one route: the installed catalog's, or the one the
 * resolved profile materialized for a hand-declared route.
 * @param provider - provider route id.
 * @param profile - the stored profile, when the route has one.
 * @returns the provider, or undefined when neither knows this route.
 */
function providerOf(provider: string, profile: ResolvedPiAiProviderProfile | undefined): Provider | undefined {
  return profile?.piProvider ?? (provider.length === 0 ? undefined : catalogProvider(provider))
}

/**
 * Probe one draft pi-ai provider configuration.
 * @param request - the draft endpoint, protocol, model, and one-shot credential.
 * @param context - the stored profile and credential the plugin resolves.
 * @returns the endpoint and model that answered.
 * @throws LlmError when the protocol cannot be probed, nothing names an
 * endpoint or a model, or the endpoint refuses or fails the request.
 */
export async function checkConnection(
  request: LlmConnectionCheckOperation,
  context: ConnectionCheckContext,
): Promise<LlmConnectionCheckResult> {
  const provider = request.provider ?? ''
  // A draft that has not chosen a protocol is probed as OpenAI Chat
  // Completions: it is the shape a gateway is overwhelmingly likely to speak,
  // and the alternative — refusing until the field is filled — would withhold
  // the action from the case it exists for.
  const api = request.api ?? context.profile?.api ?? PROBEABLE_PROTOCOL
  if (api !== PROBEABLE_PROTOCOL) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no chat completion this build can probe; save the provider and check it`
      + ' from a conversation instead',
      'CONNECTION_CHECK_UNSUPPORTED',
    )
  }
  const known = providerOf(provider, context.profile)
  const baseURL = request.baseURL ?? context.profile?.baseURL ?? known?.baseUrl
  if (baseURL === undefined || baseURL.length === 0) {
    throw new LlmError(
      `no endpoint to probe${provider.length === 0 ? '' : ` for provider "${provider}"`};`
      + ' fill in the API address, or pick a provider pi-ai ships',
      'CONNECTION_CHECK_FAILED',
    )
  }
  const model = request.model ?? known?.getModels()[0]?.id
  if (model === undefined || model.length === 0) {
    throw new LlmError(
      `no model to probe${provider.length === 0 ? '' : ` for provider "${provider}"`};`
      + ' add at least one model to this provider first',
      'CONNECTION_CHECK_FAILED',
    )
  }
  // A key typed into the form wins: it is the one the user is testing, and it
  // may be the replacement for exactly the stored key that is failing. The
  // stored one is asked for only here, past both refusals above, so a draft
  // that cannot be probed at all costs no credential lookup.
  const apiKey = request.apiKey ?? await context.storedApiKey()
  return await probeOpenAiChatCompletion({
    baseURL,
    model,
    ...apiKey === undefined ? {} : { apiKey },
    ...request.signal === undefined ? {} : { signal: request.signal },
  })
}
