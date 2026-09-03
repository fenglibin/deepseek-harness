import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as commandPromptConfig from '@deepseek-ai/dsh-command-prompt-config'

/** In-memory settings provider fixture: the smallest real subclass of the Service Definition. */
class BareProvider extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: { doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  return ctx
}

/** Mint a scope whose key is a live agent (real session: the executor logs lifecycle events on it). */
async function mintAgentScope(ctx: Context, name: string): Promise<{ scope: Scope; agent: Agent }> {
  const session = ctx.sessions.create(SessionId(name))
  const agent = { id: session.id, session } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['commands'] }))
  return { scope, agent }
}

describe('@deepseek-ai/dsh-command-prompt-config', () => {
  it('exposes a Loader-friendly plugin shape', () => {
    expect(commandPromptConfig.name).toBe('command-prompt-config')
    expect(commandPromptConfig.inject).toEqual(['commands'])
  })

  it('registers configured prompt commands with their localized titles', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    await ctx.plugin(commandPromptConfig, {
      commands: [
        { name: 'code-review', title: '代码审查', description: 'review the diff', prompt: 'Review this diff' },
        { name: 'summarize', description: 'summarize', prompt: 'Summarize this' },
      ],
    })
    expect(ctx.commands.list(agent)).toEqual([
      { name: 'code-review', title: '代码审查', description: 'review the diff' },
      { name: 'summarize', description: 'summarize' },
    ])
  })

  it('submits the configured prompt to the model as a command-invocation user message', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    const followup = vi.fn()
    Object.assign(agent, { followup })
    await ctx.plugin(commandPromptConfig, {
      commands: [{ name: 'summarize', description: 'summarize', prompt: 'Summarize this workspace' }],
    })
    const execution = await ctx.commands.execute(agent, '/summarize', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success' })
    expect(followup).toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: 'Summarize this workspace' }],
      source: { kind: 'command-invocation', name: 'summarize' },
    }))
  })

  it('registers no commands when the configuration is empty', async () => {
    const ctx = await mount()
    const { agent } = await mintAgentScope(ctx, 'a')
    await ctx.plugin(commandPromptConfig, {})
    expect(ctx.commands.list(agent)).toEqual([])
  })

  it('fails loud when an entry is invalid (registry-level validation)', async () => {
    const ctx = await mount()
    await expect(ctx.plugin(commandPromptConfig, {
      commands: [{ name: 'blank', description: 'blank prompt', prompt: '   ' }],
    })).rejects.toThrow('prompt must be a non-empty string')
  })
})

describe('settings-backed prompt commands', () => {
  async function mountWithSettings(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(BareProvider)
    return ctx
  }

  it('registers the cordis.yml entry as the base layer when no user section exists', async () => {
    const ctx = await mountWithSettings()
    const { agent } = await mintAgentScope(ctx, 'a')
    await ctx.plugin(commandPromptConfig, {
      commands: [{ name: 'default-cmd', description: 'default', prompt: 'default prompt' }],
    })
    expect(ctx.commands.list(agent)).toEqual([{ name: 'default-cmd', description: 'default' }])
  })

  it('re-registers commands when the settings section changes', async () => {
    const ctx = await mountWithSettings()
    const { agent } = await mintAgentScope(ctx, 'a')
    await ctx.plugin(commandPromptConfig, {
      commands: [{ name: 'default-cmd', description: 'default', prompt: 'default prompt' }],
    })
    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(['default-cmd'])

    await ctx.settings.update('prompt-commands', {
      commands: [
        { name: 'new-cmd', title: '新命令', description: 'new', prompt: 'new prompt' },
        { name: 'second-cmd', description: 'second', prompt: 'second prompt' },
      ],
    })

    expect(ctx.commands.list(agent)).toEqual([
      { name: 'new-cmd', title: '新命令', description: 'new' },
      { name: 'second-cmd', description: 'second' },
    ])
  })

  it('re-inherits the composition entry when the user section is reset', async () => {
    const ctx = await mountWithSettings()
    const { agent } = await mintAgentScope(ctx, 'a')
    await ctx.plugin(commandPromptConfig, {
      commands: [{ name: 'default-cmd', description: 'default', prompt: 'default prompt' }],
    })
    await ctx.settings.update('prompt-commands', {
      commands: [{ name: 'user-cmd', description: 'user', prompt: 'user prompt' }],
    })
    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(['user-cmd'])

    await ctx.settings.replace('prompt-commands', {})

    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(['default-cmd'])
  })

  it('rejects an invalid section and keeps the last good command list', async () => {
    const ctx = await mountWithSettings()
    const { agent } = await mintAgentScope(ctx, 'a')
    await ctx.plugin(commandPromptConfig, {
      commands: [{ name: 'default-cmd', description: 'default', prompt: 'default prompt' }],
    })
    // An invalid name must be refused by the settings write, not strand the list.
    await expect(ctx.settings.update('prompt-commands', {
      commands: [{ name: 'Invalid Name', description: 'x', prompt: 'y' }],
    })).rejects.toThrow(/command name/)

    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(['default-cmd'])
  })

  it('rejects a section whose entry has an empty prompt', async () => {
    const ctx = await mountWithSettings()
    const { agent } = await mintAgentScope(ctx, 'a')
    await ctx.plugin(commandPromptConfig, {
      commands: [{ name: 'default-cmd', description: 'default', prompt: 'default prompt' }],
    })
    await expect(ctx.settings.update('prompt-commands', {
      commands: [{ name: 'blank', description: 'blank', prompt: '   ' }],
    })).rejects.toThrow(/requires a prompt/)

    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(['default-cmd'])
  })

  it('rejects a section with duplicate command names', async () => {
    const ctx = await mountWithSettings()
    const { agent } = await mintAgentScope(ctx, 'a')
    await ctx.plugin(commandPromptConfig, {
      commands: [{ name: 'default-cmd', description: 'default', prompt: 'default prompt' }],
    })
    await expect(ctx.settings.update('prompt-commands', {
      commands: [
        { name: 'dup', description: 'a', prompt: 'a' },
        { name: 'dup', description: 'b', prompt: 'b' },
      ],
    })).rejects.toThrow(/duplicated/)

    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(['default-cmd'])
  })
})
