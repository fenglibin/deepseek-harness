# 任务清单

## 1. 改写 deep-selfcheck 正文

- [x] 把 prompt-commands 里 deep-selfcheck 的正文改写为四段：自检依据／三问与可观察证据／修复／收尾顺序 (covers: delivery-discipline/正文按级别指明自检依据, delivery-discipline/正文要求逐条回答并给出证据, delivery-discipline/正文给出收尾顺序与记录格式, design/D1)
- [x] 删除与机制不符的「L0、L1 可能没有设计文档」，按级别写实 L2 读 openspec/changes/<change_id>/、L1 读 .dsh/design/<task_id>.md 与 todo_write 清单 (covers: delivery-discipline/正文按级别指明自检依据, design/D2)
- [x] 修正 revision 提醒：读码确证四处 record_* 都推进 revision，措辞改为「每次调用之后都必须重新取」 (covers: delivery-discipline/正文给出收尾顺序与记录格式, design/D3)

## 2. 勾选为验收命令

- [x] 在 delivery 段写入 verificationCommands: [deep-selfcheck]，取命令名而非正文 (covers: delivery-discipline/调整提示词正文无需重新勾选, design/D4)

## 3. 验证

- [x] 真实调用 advance_delivery_task → verified，门禁按预期阻止且错误消息内嵌的正文逐字等于新写入的内容 (covers: delivery-discipline/未留下验收记录时阻止推进, delivery-discipline/调整提示词正文无需重新勾选, design/D1)
- [x] 留下 acceptance: deep-selfcheck 记录后再次推进，确证放行 (covers: delivery-discipline/留下验收记录后放行, design/D1)
- [x] 用 YAML 解析器确证配置可解析、正文块标量保留换行、命令名与门禁匹配规则一致 (covers: delivery-discipline/留下验收记录后放行, design/D4)
- [x] 确证 settings-file 默认 watch: true 会热重载外部编辑，无需重启 GUI (covers: delivery-discipline/调整提示词正文无需重新勾选, design/D4)

## 4. 如实报告的边界

- [x] 在交付说明中如实写明边界：不覆盖 l0、门禁只保证留下记录、每任务只触发一次 (covers: delivery-discipline/未留下验收记录时阻止推进, design/D1)
