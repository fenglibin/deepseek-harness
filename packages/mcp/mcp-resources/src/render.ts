/**
 * 资源结果的投影，把二进制载荷挡在模型历史之外。
 *
 * @module @deepseek-ai/dsh-mcp-resources
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * 渲染资源 JSON，同时只把原始二进制数据留给程序化调用方。
 * @param server - 已配置服务器的来源标注。
 * @param value - 规范的资源结果。
 * @returns 带来源标注、且二进制载荷已替换为说明文字的文本。
 */
export function renderResourceResult(server: string, value: JsonValue): ContentBlock[] {
  const rendered = JSON.stringify(value, (key, item: unknown) => {
    if (key === 'blob' && typeof item === 'string') {
      return `[binary resource: ${item.length} base64 characters; available to programmatic callers]`
    }
    return item
  })
  return [{ type: 'text', text: `MCP server: ${server}\n${rendered}` }]
}
