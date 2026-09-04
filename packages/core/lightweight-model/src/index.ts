/**
 * User-chosen route for auxiliary model calls that do not need the
 * conversation's own model.
 *
 * @module @deepseek-ai/dsh-lightweight-model
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional route auxiliary calls use instead of the conversation's model. */
    lightweightModel: LightweightModelConfig
  }
}

/** Settings namespace carrying the user's lightweight route. */
export const LIGHTWEIGHT_MODEL_SETTINGS_NAMESPACE = 'lightweight-model'

/** Stored route. Both fields empty means the user set no lightweight model. */
export interface LightweightModelSettings {
  /** Registered provider route, empty when unset. */
  provider: string
  /** Provider-owned model id, empty when unset. */
  model: string
}

/** One exact provider/model route. */
export interface LightweightModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** Schema of the lightweight-model settings section. */
export const LIGHTWEIGHT_MODEL_SETTINGS_SCHEMA: z<LightweightModelSettings> = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
})

/** Optional deployment base for the route. */
export interface Config {
  /** Provider inherited when the user document leaves the route unset. */
  provider?: string
  /** Model inherited when the user document leaves the route unset. */
  model?: string
}

/** Reject a stored section that names a provider without a model, or the reverse. */
function assertPaired(value: LightweightModelSettings): void {
  if ((value.provider.length === 0) !== (value.model.length === 0)) {
    throw new Error('lightweight-model: provider and model must be set together or both left empty')
  }
}

/**
 * Owns the lightweight route independently of any Host or transport. The
 * composition entry remains usable without a settings provider; when one is
 * mounted, its user layer is read live.
 */
export class LightweightModelConfig extends Service {
  static Config: z<Config> = z.object({
    provider: z.string(),
    model: z.string(),
  })

  private source: () => LightweightModelSettings

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'lightweightModel')
    const entry: LightweightModelSettings = { provider: config.provider ?? '', model: config.model ?? '' }
    assertPaired(entry)
    this.source = () => entry
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, LIGHTWEIGHT_MODEL_SETTINGS_NAMESPACE, LIGHTWEIGHT_MODEL_SETTINGS_SCHEMA, entry, {
        setSource: (current) => { this.source = current },
        // Every consumer reads through currentSelection(), so no registration-level fact
        // needs rebuilding when the settings document changes.
        onChange: () => {},
        validate: assertPaired,
      })
    })
  }

  /**
   * Read the current lightweight route.
   * @returns a detached provider and model, or `undefined` when the user set none.
   */
  currentSelection(): LightweightModelSelection | undefined {
    const { provider, model } = this.source()
    if (provider.length === 0 || model.length === 0) return undefined
    return { provider, model }
  }

  /**
   * Save the lightweight route. A deployment without a settings provider keeps
   * its composition entry.
   * @param next - exact route accepted by an entry point.
   * @returns fulfillment after the optional settings write settles.
   */
  async saveSelection(next: LightweightModelSelection): Promise<void> {
    await this.ctx.get('settings')?.replace(LIGHTWEIGHT_MODEL_SETTINGS_NAMESPACE, {
      provider: next.provider,
      model: next.model,
    })
  }

  /**
   * Drop the lightweight route so auxiliary calls follow the conversation's
   * own model again.
   * @returns fulfillment after the optional settings write settles.
   */
  async clearSelection(): Promise<void> {
    await this.ctx.get('settings')?.replace(LIGHTWEIGHT_MODEL_SETTINGS_NAMESPACE, {
      provider: '',
      model: '',
    })
  }
}

export default LightweightModelConfig
