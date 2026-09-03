# Agent Note: Deleting a session retires an attached Agent instead of refusing

Status: implemented

English | [中文](2026-09-03-delete-attached-idle-session.zh.md)

## Problem

`deleteSession` refused any Session the Host still held an attached Agent for, with `RemoteError('session/live', …)`. An Agent is attached for the lifetime of an opened Session — following a Session activates its Agent in the background, the promotion every open performs — so a Session the user had merely opened, and which was running nothing, could not be deleted. The "still running" refusal was keyed to residency, not to work in flight, and it told the user to archive a Session that was in fact idle.

## Decision

`SessionCommandController.deleteSession` now treats residency and running as two distinct facts. It refuses with `session/live` only while `ctx.agents.get(sessionId).status === 'running'`. An attached-but-idle Agent is retired instead: `ApiSessionAgentController` retains the `AgentHandle` from every `create`/`resume` it performs and exposes `release(sessionId)`, which waits out any in-flight activation and then disposes the handle — taking the Session out of the store and draining whatever it still owed durable storage — before `sessionPersistence.remove` discards the log. An attached Agent this controller did not activate (configured, subagent-owned, or created elsewhere) has no retained handle, so it is still refused with `session/live`, because persistence refuses to discard a log an attached Session could rewrite.

## Alternatives considered

**Refuse only on `status === 'running'` and delete past the attachment.** Rejected: persistence's `remove` rejects while any live owner holds the id, so the delete would surface as `gateway/internal` and leave the log in place. Retiring the Agent is what makes the discard legal.

**Keep the residency test and teach the Client to archive first.** Rejected: it preserves the reported bug — an idle opened Session is not "still running", and the refusal misstates the user's options.

**Dispose without retaining the handle.** Rejected: the command has no other route to the loop's teardown capability; the loop's `AgentHandle` is the only way to stop the Agent and detach its Session.

## Consequences

`ApiSessionAgentController` now keeps a `Map<SessionId, AgentHandle>` and a `release` entry point. Deleting an opened idle Session retires the Agent, which publishes `api-session/removed` through the sink a live disposal uses, and then publishes the delete's own `api-session/removed`; Clients drop the row twice, which is idempotent. A running Session is still refused and must be cancelled or allowed to finish first.
