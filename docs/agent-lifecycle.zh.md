<!-- 由 scripts/gen-doc-graphs.ts 生成——请勿手工编辑。
     运行 `pnpm run gen-doc-graphs` 重新生成。 -->

# Agent 轮次与步骤生命周期

此时序图是 [architecture.md](architecture.zh.md#turn-flow) 的配套图示。持久的回放事实保存在 `session/event` 中，实时控制与状态则保存在 `agent/*` 中。

```mermaid
sequenceDiagram
  participant User
  participant Agent
  participant Driver
  participant Hooks as hook listeners
  participant Prompt as ctx.systemPrompt
  participant LLM as ctx.llm
  participant Tools as ctx.tools
  participant Session
  participant SDK as UI or SDK listener
  User->>Agent: followup(content)
  Agent-->>SDK: <code>agent/inbox/spliced</code>
  Agent-->>SDK: <code>agent/inbox/inserted</code> { message }
  Agent->>Driver: queued work wakes driver
  Driver-->>SDK: <code>agent/status</code> running
  Driver->>Session: <code>turn/start</code>
  Note over Agent,Driver: claim pending next-step input plus one queued prompt
  Driver-->>SDK: <code>agent/inbox/spliced</code> pure deletion
  Driver-->>SDK: <code>agent/inbox/claimed</code> { message, turn } per message
  Driver->>Hooks: <code>agent/pre-step</code> waterfall
  Hooks-->>Driver: authoritative reject or enter(messages)
  alt proposed step rejected or pre-step failed
    Driver-->>Driver: claimed batch stays removed, the open turn spends no step
  else enter proposed step
  Driver->>Session: <code>step/start</code>
  Driver->>Session: <code>user/message</code> per entered message
  Driver->>Prompt: <code>system-prompt/assemble</code> waterfall
  Driver->>LLM: <code>agent/request</code> waterfall, then <code>llm/stream</code> waterfall
  LLM-->>Driver: StreamChunk*
  Driver->>Session: <code>assistant/chunk</code>*
  Session-->>SDK: <code>session/event</code> <code>assistant/chunk</code>*
  alt final adapter or terminal in-band request failure
    Driver->>Session: <code>step/end</code>
    Driver->>Hooks: <code>agent/request-error</code> waterfall
    Hooks-->>Driver: return retry action or preserve the original error
  else model request succeeded
  Driver->>Session: <code>assistant/message</code>
  Driver->>Tools: classify pending call by executionMode
  loop barriers and bounded rolling pool, reclassify before start
    opt call starts
      Driver->>Session: <code>tool/call</code>
      Driver->>Tools: ordered pre, concurrent execute
      Tools-->>Session: tool-owned events when applicable
    end
    opt next model-order result ready
      Driver->>Tools: ordered post
      Driver->>Session: <code>tool/result</code>
    end
  end
  Driver->>Session: <code>step/end</code>
  opt natural stop and next-step inbox empty
    Driver->>Hooks: <code>agent/turn-stopping</code> serial terminal checkpoint
  end
  opt next-step input is pending
    Driver-->>Driver: claim pending next-step input
    Driver-->>SDK: <code>agent/inbox/claimed</code> { message, turn } per message
    Driver->>Hooks: <code>agent/pre-step</code> waterfall
    Hooks-->>Driver: authoritative reject or enter(messages)
  end
  end
  end
  Driver->>Session: <code>turn/end</code>
  Driver-->>SDK: <code>agent/status</code> idle
```

`assistant/message` 事件记录每一次成功的提供方调用，包括无内容和 `max-tokens` 的结束。空内容不进入派生历史，而持久事件保留用量和 `sourceEventSeqs`，列出确切的 `assistant/chunk` 事件，包括显式的空列表。

`dsh-compaction-basic` 在请求派生之前用 `agent/pre-step` 处理压力，并仅在规范上下文溢出时用 `agent/request-error`。一旦任一触发条件成立，可选的工具结果剪枝会在摘要选择之前运行。恢复在已关闭的失败步与失败轮次关闭之间工作，且仅在剪枝或摘要推进表面替换代数时才开启新的重试轮次；否则原始请求错误保持权威。

返回的 `agent/pre-step` 决策是权威的；包裹 `next()` 的监听者保留下游消息和 `startsRequestSeries`，除非替换是有意的。转向与注入的上下文在后续 claim 操作取走其下一批后，通过同一 waterfall。

需要可回放转录数据的 SDK 用户应消费 `session/event`；`agent/*` 是队列/状态、提示词拦截、请求构造、转向、续行和错误的实时协调 API。

维护模式：人工维护的 Mermaid 时序图，由生成器写出；确切的事件签名位于生成的 Cordis 目录中。。
