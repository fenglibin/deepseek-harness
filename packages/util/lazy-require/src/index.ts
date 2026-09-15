/** 按调用方解析的惰性加载，面向兼容 CommonJS 的 Host 依赖。 */

import { createRequire } from 'node:module'

/**
 * 在 Node 的 caller-relative `require` 之外包一层成功结果缓存。
 * 失败的加载不被缓存，因此安装修复后可以重试。
 * @param specifier - 调用方 package 声明的字面量依赖说明符。
 * @param parentURL - 调用方的 `import.meta.url`，由它决定 package 解析基准。
 * @returns 一个零参数 loader，在首次使用时解析该依赖。
 */
export function createLazyRequire<T>(specifier: string, parentURL: string | URL): () => T {
  const require = createRequire(parentURL)
  let loaded = false
  let value: T
  return () => {
    if (!loaded) {
      value = require(specifier) as T
      loaded = true
    }
    return value
  }
}
