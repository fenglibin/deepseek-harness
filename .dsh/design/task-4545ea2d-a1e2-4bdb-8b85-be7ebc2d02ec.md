- [revision 3] 完整设计稿见 docs/design/session-changes-revert.zh.md。

## 现状分析结论

全部撤销四层链路：按钮（SessionChangesDock.tsx 显示条件为 Remote 存在且有记录路径）→ 回调（revertAll 置 reverting 后调 Remote）→ Remote（client/index.ts 读全局 current 调 remote.revert 不带 path）→ Host（api/session-file-revisions revert 取 revisions 全集逐路径处理）。**没有二次确认**，一次点击直接落盘（writeAtomic/rm 均不可逆）。撤销对象是宿主修订记录而非列表全集，两者可能因 maxRecordBytes 超限不落盘、createdAt 不一致 retire、重启丢失而不一致。list/diff 收显式 sessionId 而 revertAll 读全局 current，是不对称。revertContent 是反向补丁非覆盖，保留会话外改动；对不上上下文的 hunk 跳过。**「删除的文件自动恢复」当前不成立**：MUTATION_TOOLS 只含 write/edit/str_replace_editor，后者的命令集无 delete，DSH 无删除工具，agent 只能走 bash rm，而 rm 既不进捕获也不进 changedFiles 列表，被删文件在列表里根本不出现。单文件撤销 Host 已支持（path 可选、revert 已分叉、revertOne 本就是单路径），缺 Client 两层。行数数据已送达浏览器但被 refreshRecorded 只取 path 丢弃，且 lineCounts 算的是两侧文件总行数而非变更行数，现有测试因内容整体替换而巧合相等。

## 设计决策

- D1 删除识别不解析 bash 命令，改问 git：实测 git status --porcelain -z 在 7302 文件仓库耗时 33ms，且 python3 os.remove 与 find -delete 删除的文件 git 均识别为 " D <path>"，因此无需解析命令文本即可覆盖脚本与间接删除。基线：会话内首次查询记一份删除基线，之后只报增量，避免把会话前或会话外的删除列进来。
- D2 新增 origin: 'deleted'（现有 endState 必填 string 无法表达「不存在」），连带改 storedRevision 枚举、revertOne 恢复分支、列表行状态；revisionsDomainSpec.version 1→2，按预发布立场不做兼容垫片。
- D3 恢复内容由 git 提供，三级取用：git status 确认已删除 → git restore --source=HEAD；index-only 路径必须用 git cat-file -p :<path>（实测 restore --source=HEAD 对 index-only 静默失败）。失败分三种可判定情形给具体文案：非 git 仓库、pathspec 不匹配（未加入 git）、越界复用既有 containPath 的 EscapeError。已知限制：会话前有未提交改动的 tracked 文件被删后只能恢复到 HEAD，那些改动丢失（用户明确接受）。
- D4 git 调用复用既有 @deepseek-ai/dsh-native-command 的 runNativeCommand（无 shell、参数数组、abort 传播）；路径来自已捕获 revision 并经 containPath 收敛，非模型控制，不构成注入面。能力归属 api/session-file-revisions，因其已在同处做文件 IO，不新开包。
- D5 单文件撤销不新增 Remote 动词，复用 revert 的 path 可选分叉：revision-remote.ts 接口改为 revert(path?)，行内状态从全局 reverting 布尔改为按路径的 ReadonlySet<string>。
- D6 行数在 Host 用 diffLines 计算真实增删：existing 用 diffLines(baseline,endState)，absent 全为新增，unknown 两侧均 0（保持无基线不可比的诚实语义）。纯函数 lineCounts 下沉到 fs/session-file-revisions（与 revertContent 同居、该包已声明 diff 依赖），避免 api 包新引入 diff。
- D7 图标：接受 IconCheckOutline16（已有）、撤销 IconUndoOutline16（已有，比叉更贴近撤销语义）、查看变更新增 IconEyeOutline16（按 16px 网格与描边惯例绘制）。保留 aria-label。行内顺序：路径、操作徽标、+N -M、查看变更、接受、撤销；删除行以「已删除」替代行数。
- D8 二次确认复用 RiskConfirmation 与 locale 字典里已存在却无人引用的死文案 revertConfirm，补标题/勾选/取消/确认标签，展示将影响的文件数。

## 非目标

不做 pre-execute 内容捕获、不新增模型可见 delete 工具、不解析 bash 命令文本、不改 revertContent 反向补丁语义、不改 changedFiles 投影的既有写入工具识别规则。

## 验证要求

Host：lineCounts 真实行数用例（含整体替换与单行修改两类以防再次巧合相等）、git 检测与恢复四条失败路径。Client：单文件撤销接线、二次确认门禁（未勾选时确认不可用）、图标与行数渲染、删除行状态。用户可见输出变化须更新无密钥录制会话快照；pnpm run test:gui 与 verify-client-ui-i18n 覆盖 Client 面。
