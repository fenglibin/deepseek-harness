# Agent Note: 模型偏好目录在设置提交后未失效

Status: implemented

## Problem

在「设置 → 模型」页编辑某个模型的属性（例如勾选「支持图片输入」）并保存后，「轻量模型」与「图片理解模型」两个偏好卡片不会立即反映这次编辑——必须刷新页面，被勾选的模型才会出现在「图片理解模型」候选里。根因在 `ui-settings-models` 的推送失效接线：模型属性写入 settings 触发的是 `settings/document-updated`（route 集合与 retry 策略都没变，所以不会触发 `llm/adapters-updated`），而该事件的监听器只刷新提供方目录（`controller`），从不刷新两个偏好卡片缓存的模型目录；此外 `llm/adapters-updated` 的监听器 `refreshAdapters` 只刷新了轻量模型，漏掉了图片理解模型。

## Decision

`ui-settings-models` 的 `apply` 把两个偏好卡片的目录刷新抽成一个 `refreshCatalogs`（同时调用 `lightweight.refresh()` 与 `imageUnderstanding.refresh()`），并让 `settings/document-updated` 与 `llm/adapters-updated` 都调用它。`credentials/reference-updated` 仍只刷新提供方目录，因为凭据状态不影响模型目录。

## Alternatives considered

**按 namespace 过滤，只在 llm 相关 namespace 变化时刷新目录。** 否决：模型配置可能落在任意 provider 的 namespace（`llm-pi-ai`、`llm-deepseek` 以及未来 provider），枚举既不完整也不易维护；`ui-model-selection` 与 `ui-settings-plugins` 已对 `settings/document-updated` 无条件刷新目录，保持一致更简单。

**只补 `refreshAdapters` 漏掉的 `imageUnderstanding.refresh()`。** 否决：这无法覆盖「仅 settings 变化、route 未重注册」的场景，而那正是用户报告的路径——只修对称性，「图片理解模型」仍要刷新页面才生效。

## Consequences

编辑模型属性后，两个偏好卡片无需刷新即可看到新的候选：勾选「支持图片输入」的模型即时进入「图片理解模型」候选。代价是任何 settings 提交在 Models 页面已打开时都会重新拉取一次模型目录；`refresh()` 自带的「目录从未请求过就保持 idle」守护把未打开页面时的开销压到零，因此后台失效不会让页面触达网络。
