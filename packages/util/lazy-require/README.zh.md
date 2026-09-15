---
description: "按调用方解析并惰性加载 CommonJS 兼容的 Host 依赖，使应用启动时不初始化尚未使用的依赖。"
kind: "package-library"
---

# @deepseek-ai/dsh-lazy-require

## 概述

`dsh-lazy-require` 让兼容 CommonJS 的 Host 依赖保持未加载状态，直到首次实际操作。解析仍以消费方 package 为基准，同一进程 realm 会复用一次成功加载的模块值。

启动路径上被静态导入的原生依赖会在进程启动时付出初始化成本，即使该功能当次运行从未被使用。本包把这份成本推迟到真正的首次使用，而依赖声明位置不变。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

传入依赖的字面量 specifier 与调用方的 `import.meta.url`：

```ts
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'

interface NativeModule { open(): void }
const requireNative = createLazyRequire<NativeModule>('native-package', import.meta.url)
```

调用 `requireNative()` 时才加载依赖，并且只加载一次。失败的加载不会被缓存，因此安装修复后可以直接重试。

调用方保留 type-only 导入来引用该依赖的类型，只在实际操作发生处调用返回的 loader。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本工具用传入的调用方 URL 创建 Node `require`，并且只缓存成功返回的值。显式传入调用方 URL 会在发布后保留 package 局部的依赖解析，而不是落到仓库根被提升的 `node_modules`。

`verify-package-dependencies` 会把 `createLazyRequire('x', import.meta.url)` 的第一个字面量实参识别为 Host runtime 边，因此该依赖仍必须声明在 `dependencies` 中——延迟加载改变的是**何时**加载，不是它是否必需。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 按调用方解析的 loader 与成功结果缓存 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具包地图](../README.zh.md)——相邻的共享原语。
- [出站代理支持](../http-proxy/README.zh.md)——同样在启动路径上安装、同样按进程一次决策的策略。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这个 Host 侧的模块加载原语不注册任何面向模型的内容。

#### KV 缓存影响

这里的内容不会进入模型请求，因此不影响提供方缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限兼容 CommonJS 的依赖**——纯 ESM 的 package 需要由调用方自己持有异步 factory。
- **WebWorker 打包需要显式请求**——静态 packer 无法发现只在 `createLazyRequire()` 调用中命名的依赖，因此 Preview image 使用的 package 必须另有一条受支持的字面量请求让它保持可达。

本包的 invariant 伴生入口不注册任何运行时检查：loader 只持有一个闭包内的加载缓存，没有事件流，也没有跨插件的可变关系；其缓存与按调用方解析的行为由单元测试覆盖。

<a id="dev-note"></a>
### 开发备注

无。
