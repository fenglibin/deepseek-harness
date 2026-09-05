# Agent Note: Web 构建原子替换 dist，避免服务中的页面变空白

Status: implemented

## Problem

`dsh web` 的 GUI 通过逐请求读取 `apps/web/dist` 来提供服务——`dsh-host-frontend-static` 有意不设内存缓存，这样 `pnpm run dev:web` 的 watch 重建能在下一次读取时生效。但 `pnpm run build` 的 `build:web` 阶段执行的是普通 `vite build`，其默认的 `emptyOutDir` 会在构建开始时清空整个 `dist` 目录。因此在 GUI 运行期间执行构建，会使 `dist/index.html` 在整个构建期间缺失，用户在此期间刷新页面会得到 `frontend-static` 为"缺失的配置索引"所定义的空 404——即空白页。watch 脚本早已用 `--no-emptyOutDir` 规避了这一问题，但一次性 build 没有。

## Decision

`apps/web/vite.config.ts` 现在把构建产物暂存到被服务目录的旁边，再原子地替换进去。单个 `stageDistOutput` 插件把 `build.outDir` 设为 `dist.staging`，在 `generateBundle` 中记录 worker bootstrap 入口，并在自己的 `writeBundle` 里先把 `preview.html` 拼接到暂存目录树，再把旧 `dist` 移到 `dist.previous`，把 `dist.staging` 重命名为 `dist`，最后删除备份。拼接与 swap 共用同一个钩子，是因为 Rollup 并行执行 `writeBundle` 与 `closeBundle` 钩子，两个插件无法保证拼接先于 rename。两次 rename 都在同一文件系统上，因此被服务的目录树在 old→new 之间切换，没有文件缺失窗口。`.gitignore` 忽略 `dist.staging` 和 `dist.previous`（构建失败会留下暂存目录，下次构建的 `emptyOutDir` 会清理它）。

## Alternatives considered

**给 `build` 脚本加 `--no-emptyOutDir`，与 `watch` 保持一致。** 拒绝：Vite 会原地覆盖 `index.html`，但会残留所有过期的 hash 资源文件，多次构建后不断累积，并污染 npm 发布的 `dist`（`files: ["dist"]`）。

**在 `frontend-static` 中缓存 index 与资源，缺失时回退缓存。** 拒绝：这会改变该包文档所定义、并有测试锁定的"缺失文件 → 空 404"契约；而且必须缓存每一个 hash 资源（不只是 index），否则重建后的页面仍会因脚本加载失败而空白。

**先在别处构建、再原地重写 `dist`。** 拒绝：目录级的原子替换只能表达为两次 rename 的 swap；原地复制文件并非原子，会重新引入窗口期。

## Consequences

`pnpm run build` 不再删除正在运行的 GUI 所服务的 index.html。swap 窗口从"整个构建过程"缩小到两次 rename 加一次备份删除——毫秒级；若两次 rename 之间崩溃，会留下 `dist.previous` 供下次构建清理。`dist.staging` 与 `dist.previous` 已被 gitignore。服务侧契约、包与测试均无改动：`dsh-host-frontend-static` 对从未存在的 index 仍返回空 404。
