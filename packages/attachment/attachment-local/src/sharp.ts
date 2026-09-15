/** 进程内对 Sharp 兼容 CommonJS 入口的惰性访问。 */

import type sharp from 'sharp'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

/** 在首次栅格操作时加载 Sharp，并保留其可调用导出。 */
export const requireSharp = createLazyRequire<typeof sharp>('sharp', import.meta.url)
