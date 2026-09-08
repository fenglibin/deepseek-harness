# 实现清单

- [ ] `locales.ts` 新增 `open`、`openFailed` 两条文案 (covers: session-changes-dock/点击一行打开该文件, session-changes-dock/宿主打开失败, design/D5)
- [ ] `SessionChangesDock.tsx` 新增 `canonicalMutationPath(path, cwd?)` 纯函数 (covers: session-changes-dock/相对路径与绝对路径指向同一文件, session-changes-dock/分隔符与点段差异收敛, design/D1)
- [ ] `sessionChanges(conversation, cwd?)` 用规范化路径作折叠键并输出规范化路径 (covers: session-changes-dock/相对路径与绝对路径指向同一文件, session-changes-dock/不同目录的同名文件各自成行, design/D1)
- [ ] 列表行改为按钮：目录段 + 文件名段，`title`/`aria-label` 带完整路径 (covers: session-changes-dock/不同目录的同名文件各自成行, session-changes-dock/点击一行打开该文件, design/D4)
- [ ] 面板持有打开失败状态并在列表下方成行 (covers: session-changes-dock/宿主打开失败, design/D5)
- [ ] `SessionChangesDock.module.css`：`.path` 按钮化，新增 `.dirName`、`.baseName`、`.openError` (covers: design/D4, design/D5)
- [ ] `src/client/index.ts` 新增 `SessionChangesInjected { cwd, openFile }` 与 `sessions`/`remote`/`remote.session` 注入 (covers: design/D2, design/D3)
- [ ] `package.json` 的 `dsh.client.inject` 与 devDependencies 同步新增包边 (covers: design/D2)
- [ ] 更新/新增单测（折叠、规范化和点击、失败、apply 注入）并保 100% 覆盖率 (covers: session-changes-dock/相对路径与绝对路径指向同一文件, session-changes-dock/分隔符与点段差异收敛, session-changes-dock/不同目录的同名文件各自成行, session-changes-dock/点击一行打开该文件, session-changes-dock/宿主打开失败)
- [ ] README 同步 (covers: design/D1, design/D4)