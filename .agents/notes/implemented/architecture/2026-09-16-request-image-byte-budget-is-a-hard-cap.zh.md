# Agent Note: 发往模型的请求图片字节预算是硬上限

Status: implemented

## Problem

`ImageRequestPolicy.maxBytes` 一直是一个「尽力而为」的目标，而不是上限。`readRequestImageFile` 只做两件事：按 `maxPixels` 算一次栅格尺寸，然后沿固定的质量阶梯（85 / 75 / 60）取第一个不超预算的编码；三档都超预算时返回**最小的那一档**，而那一档本身仍然超预算。也就是说，一个复杂的 1024×1024 截图在 100 KiB 预算下会照旧发出约 585 KiB——预算被记录、被计费、被用作 offload 的输入，却没有被兑现。用户因此要求：每张发往 LLM 的图片，编码后不得超过 100 KiB，超了就先压缩。

请求预算的默认值也偏大：DeepSeek 视觉路由、pi-ai 路由与 image-understanding 各自默认 1 MiB。

## Decision

字节预算改为硬上限，由尺寸迭代兑现。`createRequestImage` 在质量阶梯穷尽之后不再返回最小输出，而是进入 `encodeWithinBudget`：按当前最小输出相对预算的溢出比例缩小栅格（`sqrt(maxBytes / bytes)`，因子夹在 0.5 与 0.95 之间），重新走一遍阶梯，最多 4 步。收缩有下限 `MIN_REQUEST_IMAGE_LONG_EDGE = 512`：一旦栅格长边到 512 还装不下，就接受该尺寸下最小的编码——再缩下去，换来的字节不足以补偿模型读不清图片的损失。

请求预算默认值改为 100 KiB：`llm-deepseek` 的 `DEFAULT_REQUEST_IMAGE_MAX_BYTES`、`llm-pi-ai` 的 `DEFAULT_REQUEST_IMAGE_MAX_BYTES`、`image-understanding` 的 `requestImageMaxBytes`（schema 默认值与构造函数回退两处）。像素预算保持不变，让够小的图仍保留原有分辨率。

`REQUEST_IMAGE_TRANSFORM_VERSION` 从 `v5` 升到 `v6`：同一份附件在新版本下的字节与尺寸都可能不同，缓存键必须跟着变，旧缓存自然失效一次。

`normalizeImage` 的入库归一化不受影响——那条路径的 4 MiB 目标是「存什么」，不是「发什么」，文档里对它的描述仍然准确。

## Alternatives considered

**只往质量阶梯里加更低档位（40、30）。** 改动最小，但复杂图在 q30 仍可能超预算，而画质已经不可用；字节数与质量的兑换比在低位越来越差。

**只调低像素预算，不动编码流程。** 一次编码就够快，但「多少像素对应 100 KiB」取决于图像内容，固定预算要么对简单图过度降分辨率，要么对复杂图仍然超标——还是保证不了上限。

**压不到预算就拒绝发送。** 语义最干净，但用户在输入框里已经看到图片被受理，发送时才失败是不可接受的回退；触底接受最小输出更贴近「先压缩再发送」的要求。

**在浏览器侧压缩后再上传。** 能把 host 的 CPU 成本挪到客户端，但压缩实现会分叉成两套（浏览器 canvas 与 sharp），产出不再确定，与「请求版本由 policy 与变换版本决定」的确定性缓存键冲突。

## Consequences

每一张需要重编码的图片最多多出 4 次编码尝试；每次尝试都受 `CompressionLimiter` 的并发闸（默认 2）约束，因此不会把 CPU 打满，但一个多图的 turn 会比过去稍慢——换来的是上传字节量下降一个数量级。缓存版本升级会让存量 `request-images/` 缓存全部重建一次。

极端图像（预算小到 512px 长边都装不下）仍会超出预算，这是有意保留的缺口：契约是「收缩到下限为止」，不是「无论如何都装得下」。需要严格保证的调用方应在自己的 policy 里给出能装下的预算。

`snapshots/` 下涉及请求图片字节数与尺寸的录制快照随默认值变化而更新；`llm-deepseek`、`llm-pi-ai`、`image-understanding` 三处既有断言从 1 MiB 改为 100 KiB。
