# PinPinto 项目协作规则

本文件记录 PinPinto 仓库内的项目级执行边界。全局规则仍然适用；若发生冲突，以更具体、更安全的规则为准。

## 目标与成功标准

- PinPinto 是面向 Chrome、Edge 和 Firefox 的 Pinterest 图片采集与批量下载扩展。
- 核心体验：页面识别图片，用户可手动勾选下载，也可开启自动滚动与自动分批下载。
- 自动下载成功标准：开启自动下载后自动启用自动滚动；每达到设定批次数量就暂停滚动、下载当前窗口；浏览器确认 ZIP 和补救单图下载都进入终态，并收到页面端压缩确认后，才释放页面记录并继续下一批。
- 多浏览器成功标准：`dist` 始终保留 Chrome / Edge 构建，Firefox 构建进入独立 staging / artifact，避免误加载 manifest。

## 可改 / 禁改范围

- 可改：`src/`、`scripts/tests/`、`docs/`、README、manifest 与构建脚本中的项目逻辑、契约测试和说明文档。
- 谨慎改：批量任务状态机、浏览器下载监听、页面记录压缩、E2E 选择器、manifest 权限和 release 脚本；改动后必须跑对应最小验证。
- 默认不改：`dist/`、`artifacts/`、`.e2e-dist/`、`playwright-report/`、`test-results/` 等生成物。
- 禁止无确认操作：`git push`、`git reset --hard`、远端发布、生产配置/权限扩大、不可逆删除或迁移。
- 工作区已有未提交改动时，不要 reset、覆盖或大范围格式化；先判断是否与本次任务冲突。

## 目录地图

- `src/background.ts`：浏览器事件与消息入口。
- `src/background/batch-coordinator.ts`：后台批量任务生命周期、取消、下载结算和自动批次 cursor 推进。
- `src/background/batch-download.ts`：图片抓取、ZIP 生成与浏览器补救下载。
- `src/content.ts`：页面图片扫描、选择覆盖层和内容脚本消息入口。
- `src/content/auto-batch-session.ts`：自动滚动、批次窗口发送、暂停/恢复握手。
- `src/content/session-store.ts`：页面图片记录、选中状态和自动批次压缩。
- `src/shared/batch-task.ts`：批量任务共享类型。
- `src/shared/download-batching.ts`：自动批次数量、窗口切片与规范化。
- `src/popup.ts` / `src/sidebar.ts`：弹窗和侧边栏控制界面。
- `src/popup/download-actions.ts` / `src/sidebar/download-actions.ts`：下载、自动滚动和自动批次 UI 动作。
- `scripts/tests/`：Node 契约测试和行为测试。
- `scripts/release-push.mjs`：版本同步、本地发布门禁、release commit/tag 与原子推送入口。
- `e2e/`：确定性的扩展端到端测试。
- `manifest.config.ts`：CRX manifest 源配置。

## 自动下载业务术语

- `autoBatchLimit`：每批自动下载图片数量，输入需规范化到允许范围。
- `downloadImages(mode: auto)` / `startAutoBatchSession`：后台启动自动批次任务并通知内容脚本。
- `autoBatchWindowReady`：内容脚本在完整批次或滚动耗尽尾批可下载时发送的窗口。
- `commitAutoBatchWindow`：后台在浏览器下载结算后要求页面压缩并释放已下载窗口。
- `resumeAutoBatchSession`：页面确认压缩后，后台推进 cursor 并恢复下一轮滚动。
- `finishAutoBatchSession`：页面滚动耗尽且没有剩余窗口时结束自动任务。
- 自动批次必须保持单活动窗口、cursor 对齐、浏览器下载终态先于页面压缩。

## 验证命令

优先使用 Windows PowerShell，并通过仓库固定的 Corepack/pnpm 版本运行命令。

```powershell
corepack.cmd pnpm install --frozen-lockfile
corepack.cmd pnpm exec node --test scripts/tests/auto-batch-session.test.mjs scripts/tests/batch-coordinator.test.mjs scripts/tests/download-settings.test.mjs scripts/tests/source-contracts.test.mjs
corepack.cmd pnpm run verify
git diff --check
```

触及 E2E 选择器、页面覆盖层、下载落盘或 Pinterest 分类时，再运行：

```powershell
corepack.cmd pnpm exec playwright install chromium
corepack.cmd pnpm run test:e2e
```

发布前完整门禁按 `docs/testing.md` 执行：

```powershell
corepack.cmd pnpm run verify
corepack.cmd pnpm run audit:dependencies
corepack.cmd pnpm run build:browsers
corepack.cmd pnpm run audit:production
corepack.cmd pnpm run test:e2e
git diff --check
```

正式发布统一执行 `corepack.cmd pnpm run release:push`。该命令默认递增补丁版本并原子推送 `main` 与 tag；只有用户明确保留真实交互验证时才可传 `--skip-e2e`，远端 tag workflow 仍必须通过 E2E 后才能创建 Release。

## 代码与文档约束

- 修改前先检索相关代码、配置、测试和文档；版本敏感内容优先查官方或一手来源。
- 单个生产代码文件超过 700 行时进入拆分评估；继续修改超长文件需说明不拆理由。
- 保持现有消息契约：`downloadImages(mode:auto)`、`startAutoBatchSession`、`autoBatchWindowReady`、`commitAutoBatchWindow`、`resumeAutoBatchSession`、`finishAutoBatchSession`。
- 不要第一轮重命名兼容用的 `pinvault-*` DOM class、data attribute、事件名或 storage key，除非同时确认 E2E、覆盖层和旧用户迁移不受影响。
- 可见品牌文案、注释和静态 HTML 应使用 PinPinto；上游致谢、LICENSE 和兼容 key 属于允许保留的历史来源。
- 改完先跑最小有效验证，再做代码审查；没有验证证据不要宣称完成。

## 交付偏好

- 默认最小补丁，尊重仓库现有结构，不做无关格式化、重命名或大范围重排。
- 聊天回复结论先行，说明改了哪些文件、跑了哪些验证、还剩什么风险。
- 复杂方案或排障复盘写入 Markdown 文档；聊天只给摘要和文档位置。
