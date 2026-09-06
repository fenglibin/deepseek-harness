/** Session commands whose activation policy is explicit at each Remote method. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import { AttachmentError, admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  ReasoningEffortId, createUserMessage, freezeMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource, ModelModality } from '@deepseek-ai/dsh-llm'
import { describeForRoute, routeExcludesImages } from '@deepseek-ai/dsh-image-understanding'
import type { SessionEvent, SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { SessionTitleInvalidError } from '@deepseek-ai/dsh-session-title'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionNotFound,
  ApiSessionPresetConflict,
  ApiSessionSubagentOwnership,
  apiSessionSubagentOwnershipError,
  hasApiSessionSubagentOwner,
  inspectApiSession,
} from './agent.ts'
import type {
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionCreateRequest,
  SessionCreateValue,
  SessionDeleteRequest,
  SessionDeleteValue,
  SessionForkRequest,
  SessionForkValue,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
} from './types.ts'

interface SessionReadState {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly events: SessionEvent[]
}

/** Implements Session business commands delegated by the Session Controller Remote service. */
export class SessionCommandController {
  /**
   * @param ctx - Host context carrying Agent, model, attachment, title, and Workspace services.
   * @param agents - sole owner of create, resume, and Session-local model selection.
   * @param defaultCwd - project directory used when create names neither a Workspace nor a cwd.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agents: ApiSessionAgentController,
    private readonly defaultCwd: string,
  ) {}

  /**
   * Create or idempotently adopt one ordinary Session.
   * @param request - requested identity, location, and Agent preset.
   * @returns the Session identity and resolved preset when configured.
   */
  async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
    if (request.workspaceId !== undefined && request.cwd !== undefined) {
      throw new RemoteError('gateway/bad-request', 'session.create accepts workspaceId or cwd, not both', {})
    }
    const sessionId = request.sessionId ?? brandString<SessionId>(`session-${randomUUID()}`)
    let workspace: Workspace | undefined
    if (request.workspaceId !== undefined) {
      workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
      if (workspace === undefined) {
        throw new RemoteError('workspace/not-found', `workspace "${request.workspaceId}" not found`, {
          workspaceId: request.workspaceId,
        })
      }
    }
    const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
    let adopted: Agent
    try {
      adopted = await this.agents.ensureSession(
        sessionId,
        cwd,
        request.sessionId !== undefined,
        request.agentPreset,
      )
    } catch (error) {
      this.rejectCreation(sessionId, error)
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId, workspaceId: workspace.id },
        )
      }
    }
    const agentPreset = this.agents.presetForSession(adopted.session)
    return { sessionId, ...(agentPreset === undefined ? {} : { agentPreset }) }
  }

  /**
   * Validate and install one Session-local model selection.
   * @param request - Session identity and requested model selection.
   * @returns the normalized selection installed for the Session.
   */
  async selectModel(request: SessionSelectModelRequest): Promise<SessionSelectModelValue> {
    const agent = await this.resolveAgent(request.sessionId)
    return this.agents.serializeImageAdmission(agent, async () => {
      try {
        const resolved = await this.ctx.llm.resolveCallConfig({
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) }),
        })
        const selected: AgentModelSelection = {
          provider: resolved.provider,
          model: resolved.model,
          ...(resolved.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: resolved.reasoningEffort }),
        }
        this.agents.selectForNextRequest(agent, selected)
        try {
          await this.ctx.agentDefaultModel.saveSelection(selected)
        } catch (error) {
          this.ctx.logger.warn(
            `session-controller: model selection changed for the Session but the default was not saved: ${String(error)}`,
          )
        }
        return { selected: { ...selected } }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'session/model-unavailable',
          error instanceof Error ? error.message : String(error),
          { provider: request.provider, model: request.model },
        )
      }
    })
  }

  /**
   * Normalize and append a user-owned Session title.
   * @param request - Session identity and proposed title.
   * @returns the accepted title and durable event sequence.
   */
  async rename(request: SessionRenameRequest): Promise<SessionRenameValue> {
    const agent = await this.resolveAgent(request.sessionId)
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined) {
      throw new RemoteError('gateway/internal', 'renaming is unavailable: this deployment mounts no session-title service', {})
    }
    try {
      const accepted = titles.rename(agent.session, request.title)
      return { title: accepted.title, seq: accepted.eventSeq }
    } catch (error) {
      if (error instanceof SessionTitleInvalidError) {
        throw new RemoteError('session/title-invalid', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to rename session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
  }

  /**
   * Create a new ordinary Session from one completed-turn prefix.
   * @param request - source Session and optional event anchor.
   * @returns the new Session identity.
   */
  async fork(request: SessionForkRequest): Promise<SessionForkValue> {
    if (request.atSeq !== undefined
      && (!Number.isInteger(request.atSeq) || request.atSeq < 0)) {
      throw new RemoteError('gateway/bad-request', 'atSeq must be a non-negative integer', {})
    }
    let observed: SessionObservation
    try {
      observed = await this.ctx.sessionQuery.observeSession(request.sessionId)
    } catch (error) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${request.sessionId}" not found`, {
          sessionId: request.sessionId,
        })
      }
      throw new RemoteError(
        'gateway/internal',
        `fork source unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    using source = observed
    const lastSeq = source.events.at(-1)?.seq ?? -1
    const atSeq = request.atSeq
    const anchoredBoundary = atSeq === undefined
      ? undefined
      : source.events.find(event => event.type === 'turn/end' && event.seq >= atSeq)
    const boundary = anchoredBoundary
      ?? (atSeq === undefined || atSeq > lastSeq
        ? source.events.findLast(event => event.type === 'turn/end')
        : undefined)
    if (boundary === undefined) {
      throw new RemoteError(
        'session/fork-unavailable',
        atSeq !== undefined && atSeq <= lastSeq
          ? `session "${request.sessionId}" has not completed the turn containing event ${String(atSeq)}`
          : `session "${request.sessionId}" has no completed turn to fork from`,
        { sessionId: request.sessionId },
      )
    }
    let cut = boundary.seq + 1
    while (cut < source.events.length && source.events[cut]?.type !== 'turn/start') cut++
    let workspace: Workspace | undefined
    try {
      workspace = await this.forkWorkspace(source.header)
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to resolve fork workspace for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const childId = brandString<SessionId>(`session-${randomUUID()}`)
    const composition = await this.agents.composeAgent(this.agents.presetForObservation(source))
    try {
      const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
      await this.ctx.agents.create({
        sessionId: childId,
        seed: source.events.slice(0, cut),
        meta: {
          ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
          parentSession: source.header.id,
          seedLength: cut,
          ...(composition.agentPreset === undefined
            ? {}
            : { agentPreset: composition.agentPreset }),
        },
        agentOptions: { provider, model },
        setup: composition.setup,
      })
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to fork session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(childId)
      } catch (error) {
        throw new RemoteError(
          'session/workspace-attach-failed',
          `session "${childId}" was forked but could not attach to workspace "${workspace.id}": ${String(error)}`,
          { sessionId: childId, workspaceId: workspace.id },
        )
      }
    }
    return { sessionId: childId }
  }

  /**
   * Delete one Session: retire any attached Agent, discard its durable log,
   * then drop every Host reference the Workspace registry holds. A Session
   * whose Agent is mid-turn is refused — its write-behind drain would
   * recreate the log under the same id.
   * @param request - Session identity.
   * @returns the deleted identity.
   */
  async deleteSession(request: SessionDeleteRequest): Promise<SessionDeleteValue> {
    const sessionId = request.sessionId
    // Attaching a Session is what opening it does, so attachment alone says
    // nothing about work in flight: only a running turn blocks the delete.
    if (this.ctx.agents.get(sessionId)?.status === 'running') {
      throw new RemoteError(
        'session/live',
        `session "${sessionId}" is still running a turn; cancel it before deleting it`,
        { sessionId },
      )
    }
    // An idle attachment still owns a write-behind drain, and persistence
    // refuses to discard a log it could rewrite, so retire the Agent first.
    // An Agent this controller did not activate cannot be retired here.
    if (this.ctx.sessions.get(sessionId) !== undefined) {
      const retired = await this.retire(sessionId)
      if (!retired) {
        throw new RemoteError(
          'session/live',
          `session "${sessionId}" is live and cannot be retired here; archive it instead of deleting it`,
          { sessionId },
        )
      }
    }
    // `sessionPersistence` is a sibling row of this one in every shipped
    // composition (base's `session-persistence-*` against web-app's
    // `session-controller`), and the context proxy's service walk is
    // ancestor-only, so a direct `ctx.sessionPersistence` read throws
    // "without inject" here. `ctx.get` reaches the same service through the
    // global store; see docs/postmortem/0001-acp-default-export-drops-inject.zh.md.
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'deleting is unavailable: this deployment mounts no session-persistence service',
        {},
      )
    }
    try {
      await persistence.remove(sessionId)
    } catch (error) {
      if (error instanceof SessionPersistenceNotFoundError) {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, {
          sessionId,
        })
      }
      throw new RemoteError(
        'gateway/internal',
        `failed to delete session "${sessionId}": ${String(error)}`,
        {},
      )
    }
    // The projection cache's rows are derived from the log that is now gone;
    // it is an optional service, so a deployment without it simply has no row.
    await this.ctx.get('sessionProjectionCache')?.remove(sessionId)
    await this.ctx.workspaceRegistry.removeSession(sessionId)
    // Publish the removal at its commit point: every connected Client drops the
    // row from this broadcast, so the caller's own projectList() is an echo of
    // the same fact rather than its source.
    this.ctx.emit('api-session/removed', sessionId)
    return { sessionId, deleted: true }
  }

  /**
   * Release one attached Session's Agent ahead of a delete.
   * @param sessionId - Session identity to retire.
   * @returns whether the Host released the Session.
   */
  private async retire(sessionId: SessionId): Promise<boolean> {
    try {
      return await this.agents.release(sessionId)
    } catch (error) {
      throw new RemoteError(
        'gateway/internal',
        `failed to retire session "${sessionId}" before deleting it: ${String(error)}`,
        {},
      )
    }
  }

  /**
   * Admit one browser prompt after explicit Agent resume and image validation.
   * @param request - Session identity, prompt content, source metadata, and delivery mode.
   * @returns acknowledgement that the Agent accepted the prompt.
   */
  async prompt(request: SessionPromptRequest): Promise<SessionPromptValue> {
    const clientTimeZone = request.clientTimeZone === undefined
      ? undefined
      : canonicalClientTimeZone(request.clientTimeZone)
    if (request.clientTimeZone !== undefined && clientTimeZone === undefined) {
      throw new RemoteError(
        'session/invalid-time-zone',
        'clientTimeZone must be UTC or a valid IANA Area/Location name',
        { value: request.clientTimeZone },
      )
    }
    const agent = await this.resolveAgent(request.sessionId)
    const selection = this.agents.selectionFor(agent).current
    if (!routeServed(this.ctx, selection.provider)) {
      throw new RemoteError(
        'session/model-unavailable',
        `no adapter serves provider "${selection.provider}"; select a model for this session`,
        { provider: selection.provider, model: selection.model },
      )
    }
    const source: MessageSource = {
      kind: 'user',
      rpcId: request.requestId,
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    }
    const hasImage = request.content.some(part => part.type === 'image')
    const admit = async (): Promise<SessionPromptValue> => {
      try {
        const selection = hasImage ? this.agents.selectionFor(agent).current : undefined
        const modalities = selection === undefined
          ? undefined
          : (await this.ctx.llm.resolveModelInfo(selection.provider, selection.model)).inputModalities
        // A text-only route is only a dead end when nothing can describe the
        // images for it; with a describer mounted the images ride along as text.
        if (selection !== undefined && routeExcludesImages(modalities) && !(await this.canDescribeImages())) {
          throw new RemoteError(
            'session/attachment-invalid',
            `Model "${selection.model}" does not support image input.`,
            { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
          )
        }
        const content = await durablePromptContent(this.ctx, request.content, modalities, request.sessionId)
        const message: UserMessage = createUserMessage({ content, source })
        if (request.mode === 'steer') agent.steer(message)
        else agent.followup(message)
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        if (error instanceof AttachmentError) {
          throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
        }
        throw new RemoteError('session/agent-busy', 'prompt rejected', { reason: String(error) })
      }
      return { accepted: true }
    }
    return hasImage ? this.agents.serializeImageAdmission(agent, admit) : admit()
  }

  /**
   * Whether a mounted describer can supply text for images this route cannot read.
   * @returns true when a describer resolved a usable vision route.
   * @throws RemoteError when a mounted describer is misconfigured, so the user
   *   sees a diagnostic refusal instead of a generic `prompt rejected`.
   */
  private async canDescribeImages(): Promise<boolean> {
    const service = this.ctx.get('imageUnderstanding')
    if (service === undefined) return false
    try {
      return await service.resolveRoute() !== undefined
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError(
        'session/attachment-invalid',
        `image description is misconfigured: ${reason}`,
        { reason: 'IMAGE_DESCRIBER_INVALID' },
      )
    }
  }

  /**
   * Read one durable image after proving the Session log references it.
   * @param request - Session and attachment identities used for authorization.
   * @returns the durable attachment reference and base64-encoded bytes.
   */
  async attachment(request: SessionAttachmentRequest): Promise<SessionAttachmentValue> {
    let source: SessionReadState
    try {
      source = await this.readSessionState(request.sessionId)
    } catch (error) {
      if (error instanceof ApiSessionNotFound) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `attachment authorization unavailable for session "${request.sessionId}": ${String(error)}`,
        {},
      )
    }
    const ref = referencedImage(source.events, String(request.attachmentId))
    if (ref === undefined) {
      throw new RemoteError(
        'session/attachment-invalid',
        'Image is not referenced by this session.',
        { reason: 'ATTACHMENT_NOT_REFERENCED' },
      )
    }
    try {
      const stored = await this.ctx.attachments.readImage(ref)
      return {
        attachment: stored.ref,
        data: Buffer.from(stored.data).toString('base64'),
      }
    } catch (error) {
      if (error instanceof AttachmentError) {
        throw new RemoteError('session/attachment-invalid', error.message, { reason: error.code })
      }
      throw new RemoteError('gateway/internal', 'Unable to read image attachment.', {})
    }
  }

  /**
   * Mutate one still-pending queue occurrence without resuming a cold Agent.
   * @param request - Session, queue item, and requested mutation.
   * @returns acknowledgement that the queue mutation was applied.
   */
  updateQueue(request: SessionUpdateQueueRequest): SessionUpdateQueueValue {
    if (request.action.kind === 'edit'
      && request.action.content.some(block => block.type !== 'text')) {
      throw new RemoteError(
        'session/attachment-invalid',
        'queue edits accept text content only',
        { reason: 'QUEUE_EDIT_NON_TEXT' },
      )
    }
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent !== undefined && hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(request.sessionId)
    }
    if (agent === undefined) {
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
    }
    const nextTurn = agent.inbox.nextTurn.find(message => message.id === request.itemId)
    const nextStep = agent.inbox.nextStep.find(message => message.id === request.itemId)
    const located = nextTurn === undefined
      ? nextStep === undefined ? undefined : { target: 'next-step' as const, message: nextStep }
      : { target: 'next-turn' as const, message: nextTurn }
    if (located === undefined) {
      throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending', { itemId: request.itemId })
    }
    const { target, message } = located
    if (request.action.kind === 'steer' && (target !== 'next-turn' || agent.status !== 'running')) {
      throw new RemoteError('session/steer-unavailable', 'current turn no longer accepts steering', { itemId: request.itemId })
    }
    if (request.action.kind === 'edit') {
      agent.inbox.replace(request.itemId, freezeMessage<UserMessage>({
        ...message,
        content: [...request.action.content],
      }))
    } else {
      agent.inbox.remove(request.itemId)
      if (request.action.kind === 'steer') agent.steer(message)
    }
    return { accepted: true }
  }

  /**
   * Cancel one live ordinary Agent while retaining pending inbox work.
   * @param request - Session whose active Agent turn is cancelled.
   * @returns acknowledgement that cancellation was requested.
   */
  cancel(request: SessionCancelRequest): SessionCancelValue {
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      throw new RemoteError(
        'session/not-found',
        `session "${request.sessionId}" not found (not attached)`,
        { sessionId: request.sessionId },
      )
    }
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw apiSessionSubagentOwnershipError(request.sessionId)
    }
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { accepted: true }
  }

  private async resolveAgent(sessionId: SessionId): Promise<Agent> {
    const found = await this.agents.resolveAgent(sessionId)
    if ('error' in found) throw found.error
    return found.agent
  }

  private rejectCreation(sessionId: SessionId, error: unknown): never {
    if (remoteErrorOf(error) !== undefined) throw error
    if (error instanceof ApiSessionPresetConflict) {
      throw new RemoteError('agent-preset/conflict', error.message, {
        sessionId: error.sessionId,
        requestedPreset: error.requestedPreset,
        ...(error.existingPreset === undefined ? {} : { existingPreset: error.existingPreset }),
      })
    }
    if (error instanceof ApiSessionCwdConflict) {
      throw new RemoteError('session/conflict', error.message, {
        sessionId: error.sessionId,
        requestedCwd: error.requestedCwd,
        ...(error.existingCwd === undefined ? {} : { existingCwd: error.existingCwd }),
      })
    }
    if (error instanceof ApiSessionSubagentOwnership) {
      throw apiSessionSubagentOwnershipError(error.sessionId)
    }
    throw new RemoteError('gateway/internal', `failed to create session "${sessionId}": ${String(error)}`, {})
  }

  private async readSessionState(sessionId: SessionId): Promise<SessionReadState> {
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      return { id: attached.id, header: attached.header, events: [...attached.events] }
    }
    const inspected = await inspectApiSession(this.ctx, sessionId)
    return { id: inspected.meta.id, header: inspected.meta, events: inspected.events }
  }

  private async forkWorkspace(source: SessionHeader): Promise<Workspace | undefined> {
    const workspaces = this.ctx.workspaceRegistry.list()
    const direct = workspaces.find(workspace => workspace.sessionIds.includes(source.id))
    if (direct !== undefined || source.origin !== 'subagent') return direct
    const lineage = await this.ctx.sessionQuery.traceSession(source.id)
    for (const ancestor of lineage.ancestors) {
      const workspace = workspaces.find(candidate => candidate.sessionIds.includes(ancestor.header.id))
      if (workspace !== undefined) return workspace
    }
    return undefined
  }
}

/**
 * Project wire prompt parts into durable content blocks, attaching a generated
 * description to every image the target route cannot accept.
 * @param ctx - Host context carrying attachment and optional describer services.
 * @param content - ordered wire prompt parts.
 * @param modalities - declared input modalities of the exact target route.
 * @param sessionId - owning session, stamped on the understanding call.
 * @returns content blocks in the same order as `content`.
 */
async function durablePromptContent(
  ctx: Context,
  content: readonly SessionPromptRequest['content'][number][],
  modalities: readonly ModelModality[] | undefined,
  sessionId: SessionId,
): Promise<ContentBlock[]> {
  if (content.every(part => part.type === 'text')) {
    return content.map(part => ({ type: 'text', text: part.text }))
  }
  const refs = await admitEncodedImages(ctx.attachments, content.filter(part => part.type === 'image'))
  // admitEncodedImages returns one reference per image part in order, so the
  // descriptions it yields are index-aligned with both.
  const descriptions = await describeForRoute(ctx, refs, modalities, undefined, sessionId)
  let next = 0
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    const attachment = refs[next] as ImageAttachmentRef
    const description = descriptions[next]
    next += 1
    return {
      type: 'image',
      attachment,
      ...(description === undefined ? {} : { description }),
    }
  })
}

function imageBlockIn(
  content: unknown,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { readonly type?: unknown; readonly attachment?: unknown; readonly content?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      if (match(ref)) return ref
    }
    if (block.type === 'tool-result') {
      const nested = imageBlockIn(block.content, match)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function imageInEvent(
  event: SessionEvent,
  match: (ref: ImageAttachmentRef) => boolean,
): ImageAttachmentRef | undefined {
  const data = event.data as {
    readonly content?: unknown
    readonly message?: { readonly content?: unknown }
    readonly inserted?: readonly { readonly content?: unknown }[]
    readonly chunk?: { readonly type?: unknown; readonly block?: unknown }
  }
  const direct = imageBlockIn(data.content, match)
  if (direct !== undefined) return direct
  const message = imageBlockIn(data.message?.content, match)
  if (message !== undefined) return message
  for (const inserted of data.inserted ?? []) {
    const found = imageBlockIn(inserted.content, match)
    if (found !== undefined) return found
  }
  return event.type === 'assistant/chunk' && data.chunk?.type === 'block-end'
    ? imageBlockIn([data.chunk.block], match)
    : undefined
}

function referencedImage(
  events: readonly SessionEvent[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  for (const event of events) {
    const found = imageInEvent(event, ref => String(ref.attachmentId) === attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}

function routeServed(ctx: Context, provider: string): boolean {
  return ctx.llm.listProviders().some(entry => entry.id === provider)
}
