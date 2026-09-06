/**
 * Text generated from an image for a model route that cannot accept the image
 * itself. The Service Definition declares the contract, the provider answers it
 * through one configured vision route, and `describeForRoute` in
 * `./consumer.ts` decides when a route needs the text at all.
 *
 * @module @deepseek-ai/dsh-image-understanding
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, GenerateOptions, ImageDescription, LlmModelInfo, Message,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-settings'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { ImageDescriptionResult, ImageDescriberRoute } from './types.ts'

export type { ImageDescriptionResult, ImageDescriberRoute } from './types.ts'
export { describeForRoute, routeExcludesImages } from './consumer.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Generated text for images the current model route cannot read. */
    imageUnderstanding: ImageUnderstanding
  }
}

/**
 * Instruction sent with every image. It is part of the route identity: changing
 * it changes the form of every description the deployment produces.
 */
export const DEFAULT_INSTRUCTION = 'Describe what this image shows for a reader who cannot see it. '
  + 'Transcribe visible text verbatim, including labels, code, and error messages. '
  + 'Answer in plain prose with no preamble.'

/** Code stamped on the timeout that aborts one understanding call. */
export const IMAGE_UNDERSTANDING_TIMEOUT_CODE = 'IMAGE_UNDERSTANDING_TIMEOUT'

/** Settings namespace carrying the user-chosen describer route. */
export const IMAGE_UNDERSTANDING_SETTINGS_NAMESPACE = 'image-understanding'

/** Stored route. Both fields empty means the user set no describer, so discovery picks one. */
export interface ImageUnderstandingSettings {
  /** Registered provider route, empty when unset. */
  provider: string
  /** Provider-owned model id, empty when unset. */
  model: string
}

/** Schema of the image-understanding settings section. */
export const IMAGE_UNDERSTANDING_SETTINGS_SCHEMA: z<ImageUnderstandingSettings> = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
})

/**
 * Generated descriptions for durable images. Implementations answer one route
 * question and one batch question; a batch answer is always index-aligned with
 * its input, so a caller can attach each result to the block it came from.
 */
export abstract class ImageUnderstanding extends Service {
  constructor(ctx: Context) {
    super(ctx, 'imageUnderstanding')
  }

  /**
   * Resolve the route this deployment uses, validating it on first use.
   * @param signal - cancellation for the provider-directory reads this may perform.
   * @returns the route in force, or `undefined` when no model can describe images.
   * @throws when a configured route exists but cannot serve the call.
   */
  abstract resolveRoute(signal?: AbortSignal): Promise<ImageDescriberRoute | undefined>

  /**
   * Describe every reference that has no description yet.
   * @param refs - durable normalized attachments in owning-message order.
   * @param signal - cancellation shared by every call this batch makes.
   * @param sessionId - owning session, stamped on the understanding call.
   * @returns one description or `undefined` per input, aligned by index.
   */
  abstract describe(
    refs: readonly ImageAttachmentRef[],
    signal?: AbortSignal,
    sessionId?: GenerateOptions['sessionId'],
  ): Promise<readonly ImageDescriptionResult[]>
}

/** Vision route and bounds for one understanding deployment. */
export interface Config {
  /** Default provider route; the user's settings selection wins, and empty with no selection discovers the first model that accepts images. */
  provider?: string
  /** Default model id interpreted by `provider`; set together with `provider`. */
  model?: string
  /** Instruction sent with each image. */
  instruction?: string
  /** Maximum output tokens for one description. */
  maxOutputTokens?: number
  /** End-to-end deadline in milliseconds for one understanding call. */
  timeoutMs?: number
  /** Maximum characters retained from one description. */
  maxDescriptionChars?: number
  /** Total-pixel budget for one deterministic request image in an understanding call. */
  requestImagePixelBudget?: number
  /** Encoded-byte target for one request image; the smallest quality-ladder output is used when no quality fits. */
  requestImageMaxBytes?: number
  /** Number of attachment descriptions retained per route. */
  maxCacheEntries?: number
}

/** Reject a route that names a provider without a model, or the reverse. */
function assertPaired(value: { provider: string; model: string }): void {
  if ((value.provider.length === 0) !== (value.model.length === 0)) {
    throw new Error('image-understanding: provider and model must be set together or both left empty')
  }
}

/** Reject a bound that is not a positive safe integer. */
function assertPositiveInteger(name: string, value: number, max?: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`image-understanding: ${name} must be a positive safe integer`)
  }
  if (max !== undefined && value > max) {
    throw new Error(`image-understanding: ${name} must not exceed ${max}`)
  }
}

/** Truncate text at a code-point boundary so a surrogate pair is never split. */
function truncateAtCodePoints(text: string, max: number): string {
  const points = Array.from(text)
  return points.length <= max ? text : points.slice(0, max).join('')
}

/** Cache key over every input that changes a description's text. */
function cacheKey(attachmentId: string, route: ImageDescriberRoute): string {
  return `${route.provider}\u0000${route.model}\u0000${route.instruction}\u0000${attachmentId}`
}

/**
 * Answer descriptions through one LLM route that accepts images. A deployment
 * with no image-capable model reports no route instead of failing, so callers
 * keep the omission placeholder they use today.
 */
export class LlmImageUnderstanding extends ImageUnderstanding {
  static Config: z<Config> = z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    instruction: z.string().default(DEFAULT_INSTRUCTION),
    maxOutputTokens: z.number().step(1).min(1).default(512),
    timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
    maxDescriptionChars: z.number().step(1).min(1).default(4000),
    requestImagePixelBudget: z.number().step(1).min(1).default(1024 * 1024),
    requestImageMaxBytes: z.number().step(1).min(1).default(1024 * 1024),
    maxCacheEntries: z.number().step(1).min(1).default(64),
  })

  static inject = ['llm']

  private readonly config: Required<Config>
  private resolved: ImageDescriberRoute | undefined
  private readonly cache = new Map<string, ImageDescription>()
  private source: () => ImageUnderstandingSettings

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    const resolvedConfig: Required<Config> = {
      provider: config.provider ?? '',
      model: config.model ?? '',
      instruction: config.instruction ?? DEFAULT_INSTRUCTION,
      maxOutputTokens: config.maxOutputTokens ?? 512,
      timeoutMs: config.timeoutMs ?? 30_000,
      maxDescriptionChars: config.maxDescriptionChars ?? 4000,
      requestImagePixelBudget: config.requestImagePixelBudget ?? 1024 * 1024,
      requestImageMaxBytes: config.requestImageMaxBytes ?? 1024 * 1024,
      maxCacheEntries: config.maxCacheEntries ?? 64,
    }
    assertPaired(resolvedConfig)
    if (resolvedConfig.instruction.trim().length === 0) {
      throw new Error('image-understanding: instruction must not be blank')
    }
    assertPositiveInteger('maxOutputTokens', resolvedConfig.maxOutputTokens)
    assertPositiveInteger('timeoutMs', resolvedConfig.timeoutMs, MAX_TIMER_DELAY_MS)
    assertPositiveInteger('maxDescriptionChars', resolvedConfig.maxDescriptionChars)
    assertPositiveInteger('requestImagePixelBudget', resolvedConfig.requestImagePixelBudget)
    assertPositiveInteger('requestImageMaxBytes', resolvedConfig.requestImageMaxBytes)
    assertPositiveInteger('maxCacheEntries', resolvedConfig.maxCacheEntries)
    this.config = resolvedConfig
    const entry: ImageUnderstandingSettings = { provider: resolvedConfig.provider, model: resolvedConfig.model }
    this.source = () => entry
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, IMAGE_UNDERSTANDING_SETTINGS_NAMESPACE, IMAGE_UNDERSTANDING_SETTINGS_SCHEMA, entry, {
        setSource: (current) => { this.source = current },
        // A changed user selection invalidates the memoized route so the next
        // describe call re-resolves against the new describer.
        onChange: () => { this.resolved = undefined },
        validate: assertPaired,
      })
    })
  }

  /**
   * Read the user-chosen describer route.
   * @returns a detached provider and model, or `undefined` when none is set.
   */
  currentSelection(): { provider: string; model: string } | undefined {
    const { provider, model } = this.source()
    if (provider.length === 0 || model.length === 0) return undefined
    return { provider, model }
  }

  /** @inheritdoc */
  override async resolveRoute(signal?: AbortSignal): Promise<ImageDescriberRoute | undefined> {
    if (this.resolved !== undefined) return this.resolved
    const selection = this.currentSelection()
    const route = selection === undefined
      ? await this.discoverRoute()
      : await this.validateRoute(selection.provider, selection.model, signal)
    if (route === undefined) return undefined
    this.resolved = route
    return route
  }

  /** @inheritdoc */
  override async describe(
    refs: readonly ImageAttachmentRef[],
    signal?: AbortSignal,
    sessionId?: GenerateOptions['sessionId'],
  ): Promise<readonly ImageDescriptionResult[]> {
    if (refs.length === 0) return []
    const route = await this.resolveRoute(signal)
    if (route === undefined) return refs.map(() => undefined)
    const results: ImageDescriptionResult[] = refs.map(ref => this.cache.get(cacheKey(ref.attachmentId, route)))
    for (const [index, ref] of refs.entries()) {
      const cached = results[index]
      if (cached !== undefined) continue
      results[index] = await this.describeOne(ref, route, signal, sessionId)
    }
    return results
  }

  /** First registered model whose declared input modalities include images. */
  private async discoverRoute(): Promise<ImageDescriberRoute | undefined> {
    for (const provider of this.ctx.llm.listProviders()) {
      const models = await this.ctx.llm.listModels(provider.id)
      const found = models.find(model => model.inputModalities?.includes('image') === true)
      if (found === undefined) continue
      this.ctx.logger.info(`image-understanding: using ${describeModel(found)} to describe images`)
      return { provider: found.provider, model: found.id, instruction: this.config.instruction }
    }
    this.ctx.logger.warn('image-understanding: no registered model accepts image input; images stay omitted')
    return undefined
  }

  /**
   * Prove one configured route accepts images. An undeclared modality means
   * unknown, not capable, so only an explicit declaration admits the route.
   * @param provider - configured provider route.
   * @param model - configured model id.
   * @param signal - cancellation for the metadata read.
   * @returns the validated route.
   * @throws when the provider is unknown or the route cannot accept images.
   */
  private async validateRoute(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ImageDescriberRoute> {
    if (!this.ctx.llm.listProviders().some(entry => entry.id === provider)) {
      throw new Error(`image-understanding: provider "${provider}" is not registered`)
    }
    const info = await this.ctx.llm.resolveModelInfo(provider, model, signal)
    if (info.inputModalities?.includes('image') !== true) {
      throw new Error(`image-understanding: model "${model}" on "${provider}" does not accept image input`)
    }
    return { provider, model, instruction: this.config.instruction }
  }

  /**
   * Run one understanding call, caching its result and degrading to
   * `undefined` so a single failed image never blocks the message it belongs to.
   * @param ref - durable normalized attachment to describe.
   * @param route - validated route and instruction.
   * @param signal - cancellation for the call.
   * @param sessionId - owning session, stamped on the understanding call.
   * @returns the description, or `undefined` when the call produced no text.
   */
  private async describeOne(
    ref: ImageAttachmentRef,
    route: ImageDescriberRoute,
    signal?: AbortSignal,
    sessionId?: GenerateOptions['sessionId'],
  ): Promise<ImageDescriptionResult> {
    try {
      const text = await this.requestDescription(ref, route, signal, sessionId)
      if (text === undefined) return undefined
      const description: ImageDescription = {
        text: truncateAtCodePoints(text, this.config.maxDescriptionChars),
        source: { provider: route.provider, model: route.model, instruction: route.instruction },
      }
      this.remember(ref.attachmentId, route, description)
      return description
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`image-understanding: describing ${ref.attachmentId} failed: ${reason}`)
      return undefined
    }
  }

  /**
   * Stream one description request and read its text.
   * @param ref - durable normalized attachment the model must see.
   * @param route - validated route and instruction.
   * @param signal - cancellation for the whole call.
   * @returns trimmed model text, or `undefined` when the model produced none.
   */
  private async requestDescription(
    ref: ImageAttachmentRef,
    route: ImageDescriberRoute,
    signal?: AbortSignal,
    sessionId?: GenerateOptions['sessionId'],
  ): Promise<string | undefined> {
    const messages: Message[] = [createUserMessage({
      content: [
        { type: 'image', attachment: ref },
        { type: 'text', text: route.instruction },
      ] satisfies ContentBlock[],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-image-understanding' },
    })]
    using callDeadline = deadline(signal, this.config.timeoutMs, IMAGE_UNDERSTANDING_TIMEOUT_CODE)
    const options: GenerateOptions = deepFreeze({
      provider: route.provider,
      model: route.model,
      messages,
      maxTokens: this.config.maxOutputTokens,
      purpose: 'image-understanding',
      signal: callDeadline.signal,
      requestImagePolicy: {
        maxPixels: this.config.requestImagePixelBudget,
        maxBytes: this.config.requestImageMaxBytes,
      },
      ...(sessionId === undefined ? {} : { sessionId }),
    })
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream(options)) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
    callDeadline.signal.throwIfAborted()
    const finish = assembler.finish
    if (finish.kind === 'error') throw new Error(finish.failure.message)
    if (finish.kind === 'aborted') throw new Error('image-understanding: call aborted')
    const text = assembler.blocks()
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join(' ')
      .trim()
    return text.length === 0 ? undefined : text
  }

  /** Store one description, evicting the oldest entry when the bound is reached. */
  private remember(attachmentId: string, route: ImageDescriberRoute, description: ImageDescription): void {
    const key = cacheKey(attachmentId, route)
    this.cache.delete(key)
    this.cache.set(key, description)
    while (this.cache.size > this.config.maxCacheEntries) {
      const oldest = this.cache.keys().next()
      /* v8 ignore next -- the loop condition proves one key exists */
      if (oldest.done === true) break
      this.cache.delete(oldest.value)
    }
  }
}

/** Provider-qualified model name for operator logs. */
function describeModel(model: LlmModelInfo): string {
  return `model "${model.id}" on "${model.provider}"`
}

export default LlmImageUnderstanding
