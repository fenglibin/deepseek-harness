/**
 * Configuration-driven prompt-command registration. This plugin turns a
 * validated list of prompt-command entries into `kind: 'prompt'` slash
 * commands, so adding a reusable prompt shortcut needs no code — only a
 * configuration change. Each entry carries the command name, an optional
 * localized title, a discovery description, the prompt text submitted to the
 * model, and an optional free-form input hint.
 *
 * When a settings provider is composed, the command list becomes the
 * user-editable `prompt-commands` settings section (the cordis.yml `commands`
 * entry is its composition `base`); otherwise it stays the static cordis.yml
 * entry. Either way, a change to the effective list re-registers the matching
 * prompt commands.
 *
 * @module @deepseek-ai/dsh-command-prompt-config
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
// Type-only: pulls the commands Context merge (`ctx.commands`).
import type {} from '@deepseek-ai/dsh-commands'
// Type-only: pulls the settings Context merge (`ctx.settings`).
import type {} from '@deepseek-ai/dsh-settings'

/** Settings namespace owning the user-editable prompt-command list. */
export const NAMESPACE = 'prompt-commands'

/** Command-name grammar shared with the command registry (`/^[a-z][a-z0-9_-]*$/`). */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

export const name = 'command-prompt-config'
export const inject = ['commands']

/** One prompt-command entry: discovery metadata plus the prompt text. */
export interface PromptCommandEntry {
  /** Lowercase command name without the leading slash. */
  name: string
  /** Localized display title (e.g. a Chinese name). */
  title?: string
  /** Human-readable summary shown in discovery UI. */
  description: string
  /** The prompt text submitted to the model on invocation. */
  prompt: string
  /** Optional free-form input hint advertised to capable clients. */
  hint?: string
}

/** Prompt-command configuration. */
export interface Config {
  /** Prompt commands to register, in configuration order. */
  commands?: PromptCommandEntry[]
}

export const Config: Schema<Config> = z.object({
  commands: z.array(z.object({
    name: z.string(),
    title: z.string(),
    description: z.string(),
    prompt: z.string(),
    hint: z.string(),
  })).default([]),
})

/**
 * Reject a resolved command list the registry could not register, for
 * constraints the schema cannot express — the command-name grammar and the
 * required non-empty description/prompt. Throwing here refuses the settings
 * write that produced the value, so a user edit that would strand the command
 * list is never persisted; the last good section keeps serving.
 * @param value - the resolved section, schema-valid by construction.
 */
function validateCommands(value: Config): void {
  const seen = new Set<string>()
  for (const command of value.commands ?? []) {
    if (!COMMAND_NAME.test(command.name)) {
      throw new Error(`prompt command name "${command.name}" must match ${String(COMMAND_NAME)}`)
    }
    if (seen.has(command.name)) {
      throw new Error(`prompt command "${command.name}" is duplicated`)
    }
    seen.add(command.name)
    if (command.description.trim() === '') {
      throw new Error(`prompt command "${command.name}" requires a description`)
    }
    if (command.prompt.trim() === '') {
      throw new Error(`prompt command "${command.name}" requires a prompt`)
    }
  }
}

/**
 * Register every prompt command in the current effective list, replacing any
 * previous set. Each registration reuses the registry's own per-entry
 * validation (name grammar, non-empty prompt, and the `code`/`prompt` mutual
 * exclusion), which fails loud on the first invalid entry.
 *
 * @param ctx - Cordis context carrying the command registry.
 * @param config - resolved prompt-command configuration (composition layer).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const entry = { commands: config.commands ?? [] }
  // The authoritative list source: the cordis.yml `commands` entry until a
  // settings provider attaches, then the resolved `prompt-commands` section.
  let current: () => Config = () => entry
  const disposers: Array<() => void> = []
  const sync = (): void => {
    for (const dispose of disposers) dispose()
    disposers.length = 0
    for (const command of current().commands ?? []) {
      disposers.push(ctx.commands.register({
        kind: 'prompt',
        name: command.name,
        ...(command.title === undefined ? {} : { title: command.title }),
        description: command.description,
        prompt: command.prompt,
        ...(command.hint === undefined ? {} : { input: { hint: command.hint } }),
      }))
    }
  }
  // Register the composition entry first; a settings provider (when composed)
  // re-registers from the resolved section through `onChange` below.
  sync()
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NAMESPACE, Config, entry, {
      setSource: (source) => { current = source },
      onChange: sync,
      validate: validateCommands,
    })
  })
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
    disposers.length = 0
  }, 'command-prompt-config: command disposers')
}
