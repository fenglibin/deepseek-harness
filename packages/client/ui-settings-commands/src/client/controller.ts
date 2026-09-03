/**
 * Prompt-command settings section model. The section stages add/edit as an
 * editor and commits each confirmed change as one whole-list write, so a
 * change never partially lands. Reads ride the settings scope snapshot;
 * writes address the `prompt-commands` namespace's `commands` path.
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** One prompt-command entry, mirroring the Host-side configuration shape. */
export interface PromptCommandEntry {
  /** Lowercase command name without the leading slash. */
  name: string
  /** Localized display title (e.g. a Chinese name). */
  title?: string
  /** Human-readable summary shown in discovery UI. */
  description: string
  /** The prompt text submitted to the model on invocation. */
  prompt: string
  /** Optional free-form input hint. */
  hint?: string
}

/** The `prompt-commands` settings section value. */
export interface PromptCommandsValue {
  commands: PromptCommandEntry[]
}

/** A blank editor draft for a new command. */
export const EMPTY_DRAFT: PromptCommandEntry = {
  name: '',
  description: '',
  prompt: '',
}

/** Command-name grammar shared with the Host command registry. */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/

/**
 * Whether an editor draft is a command the list accepts. `name` (a lowercase
 * hyphenated identifier), `description`, and `prompt` are required; a blank
 * `title`/`hint` is stored as absent rather than empty.
 */
export function normalizeDraft(draft: PromptCommandEntry): PromptCommandEntry | undefined {
  const name = draft.name.trim()
  const description = draft.description.trim()
  const prompt = draft.prompt.trim()
  if (name === '' || description === '' || prompt === '') return undefined
  if (!COMMAND_NAME.test(name)) return undefined
  const title = draft.title?.trim() ?? ''
  const hint = draft.hint?.trim() ?? ''
  return {
    name,
    description,
    prompt,
    ...(title === '' ? {} : { title }),
    ...(hint === '' ? {} : { hint }),
  }
}

/** Owns the `prompt-commands` settings section and its whole-list writes. */
export class PromptCommandsController {
  /**
   * @param scope - the bound `prompt-commands` settings scope.
   */
  constructor(private readonly scope: SettingsScope<PromptCommandsValue>) {}

  /** @returns the current command list (empty while the section is not served). */
  commands(): PromptCommandEntry[] {
    return this.scope.getSnapshot().value?.commands ?? []
  }

  /** @returns the current scope snapshot. */
  snapshot(): ReturnType<SettingsScope<PromptCommandsValue>['getSnapshot']> {
    return this.scope.getSnapshot()
  }

  /** Observe section changes. */
  subscribe(listener: () => void): () => void {
    return this.scope.subscribe(listener)
  }

  /** Whether the Host document accepts writes. */
  writable(): boolean {
    return this.scope.getSnapshot().writable
  }

  /** Commit a whole command list as one atomic write. */
  async commit(commands: PromptCommandEntry[]): Promise<void> {
    await this.scope.mutate([{ op: 'set', path: ['commands'], value: commands as unknown as JsonValue }])
  }
}
