# 能力增量：session-changes-dock

## 新增需求：改动列表按文件身份去重

同一文件的多次改动在“本次修改的文件”列表中 SHALL 只出现一条，其路径 SHALL 为规范化后的绝对路径。

#### Scenario: 相对路径与绝对路径指向同一文件

- **GIVEN** 会话的工作区根为 `/proj`
- **WHEN** 一个 turn 产出 `src/a.ts`，另一个 turn 产出 `/proj/src/a.ts`
- **THEN** 列表只有一条 `/proj/src/a.ts`，操作类型取最早一次

#### Scenario: 分隔符与点段差异收敛

- **WHEN** 两次改动分别记为 `src\\a.ts` 与 `./src//a.ts`（cwd 为 `/proj`）
- **THEN** 列表只有一条 `/proj/src/a.ts`

#### Scenario: 不同目录的同名文件各自成行

- **WHEN** 改动包含 `/proj/src/a.ts` 与 `/proj/lib/a.ts`
- **THEN** 列表是两条，且每行都带上目录（`src/a.ts` 与 `lib/a.ts`）

## 新增需求：列表行展示路径并打开

每行 SHALL 显示该文件相对工作区根的路径（工作区外的文件保留绝对路径），且整行 SHALL 是可点击的按钮，点击后以规范化后的绝对路径通过宿主 `session.openWorkspacePath` 打开该文件；文件名段 SHALL 始终完整可见，绝对路径 SHALL 保留在悬停文本中。

#### Scenario: 行内展示工作区相对路径

- **GIVEN** 会话的工作区根为 `/proj`
- **WHEN** 列表渲染 `/proj/src/a.ts`
- **THEN** 行内文本为 `src/a.ts`（目录段 `src/` 可省略，文件名段 `a.ts` 不省略），悬停文本为 `/proj/src/a.ts`

#### Scenario: 工作区外的文件保留绝对路径

- **WHEN** 列表渲染 `/other/src/a.ts`（工作区根为 `/proj`）
- **THEN** 行内文本是 `/other/src/a.ts`

#### Scenario: 点击一行打开该文件

- **WHEN** 用户点击 `/proj/src/a.ts` 所在行
- **THEN** 以 `{ path: '/proj/src/a.ts' }` 调用宿主打开接口，列表内容不变

#### Scenario: 宿主打开失败

- **WHEN** 打开 `/proj/src/a.ts` 被宿主拒绝（如 `xdg-open is not available`）
- **THEN** 列表下方出现一行失败原因，且该行在下次打开成功时消失