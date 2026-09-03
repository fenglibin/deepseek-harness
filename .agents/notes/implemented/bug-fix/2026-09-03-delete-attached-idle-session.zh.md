# Agent Note: 删除会话时退役驻留 Agent，而不是直接拒绝

Status: implemented

[English](2026-09-03-delete-attached-idle-session.md) | 中文

## Problem

`deleteSession` 会以 `RemoteError('session/live', …)` 拒绝任何 Host 仍持有驻留 Agent 的 Session。而 Agent 会在 Session 被打开的整个生命周期内保持驻留——follow 一个 Session 会在后台激活其 Agent，这正是每次打开会话时发生的提升（promotion）——因此一个用户仅仅打开过、且实际上没有运行任何东西的 Session 也无法被删除。"仍在运行"的拒绝依据是驻留状态，而不是正在执行的工作，它让用户去归档一个实际上处于空闲状态的会话。

## Decision

`SessionCommandController.deleteSession` 现在把"驻留"与"运行"当作两个不同的事实。仅当 `ctx.agents.get(sessionId).status === 'running'` 时，它才以 `session/live` 拒绝。驻留但空闲的 Agent 则会被退役：`ApiSessionAgentController` 保留它每次 `create`/`resume` 得到的 `AgentHandle`，并暴露 `release(sessionId)`——该方法会先等待任何仍在进行的激活，然后 dispose 该 handle——把 Session 移出 store 并排空它欠 durable 存储的内容，随后 `sessionPersistence.remove` 才丢弃日志。本控制器未激活过的驻留 Agent（配置启动、subagent 持有或外部创建的）没有保留的 handle，因此仍以 `session/live` 拒绝，因为 persistence 拒绝丢弃一个驻留 Session 仍可能重写的日志。

## Alternatives considered

**仅依据 `status === 'running'` 拒绝，并绕过驻留直接删除。** 否决：persistence 的 `remove` 在任何 live owner 持有该 id 时都会拒绝，因此删除会以 `gateway/internal` 暴露，且日志保留在原地。退役 Agent 才是让丢弃变得合法的关键。

**保留驻留判定，并引导客户端先归档。** 否决：它保留了所报告的 bug——一个空闲的已打开 Session 并非"仍在运行"，这种拒绝错误地描述了用户的可选项。

**只 dispose 而不保留 handle。** 否决：命令没有其他途径获得 loop 的退役能力；loop 的 `AgentHandle` 是停止 Agent 并解除其 Session 的唯一方式。

## Consequences

`ApiSessionAgentController` 现在持有 `Map<SessionId, AgentHandle>` 并暴露 `release` 入口。删除一个已打开的空闲 Session 会退役其 Agent（它通过 live disposal 所使用的同一 sink 发布 `api-session/removed`），随后再发布删除自身的 `api-session/removed`；客户端会两次丢弃该行，这是幂等的。正在运行的 Session 仍会被拒绝，必须先取消或等其结束。
