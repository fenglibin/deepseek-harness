
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'

const ctx = new Context()
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SubagentRuntime)
let selectedStarts = 0
ctx.subagents.registerProvider({
  name: 'built-selected',
  capabilities: { agentOptions: true, outputSchema: true, depthLimit: false, toolFilter: false, persona: false },
  inheritsParentContext: false,
  async start() {
    selectedStarts += 1
    return {
      id: 'built-child',
      result: Promise.resolve({ output: [], structured: { answer: 42 }, stopReason: 'completed' }),
      dispose: () => Promise.resolve(),
    }
  },
})
await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'must-not-be-used' })
const run = ctx.workflowEngine.start({
  script: "const value = await agent('answer', { schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] } }); return value.answer",
  meta: { name: 'built-smoke', description: 'built worker smoke' },
  subagentProvider: 'built-selected',
  parent: { id: 'built-smoke-parent', options: {} },
})
const result = await run.result
await run.dispose()
if (result.stopReason !== 'completed' || result.value !== 42 || selectedStarts !== 1) {
  console.error('unexpected result: ' + JSON.stringify(result))
  process.exit(1)
}
console.log('built-worker-smoke-ok')
