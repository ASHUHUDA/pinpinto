# PinPinto

[English README](README_en.md)

一个面向 Chrome、Edge 和 Firefox 的 Pinterest 图片采集与批量下载扩展。

## 功能概览
- 页面图片识别与勾选
- 自动滚动抓取更多图片
- 自动分批下载支持自定义每批图片数量
- 手动下载可选择 ZIP 压缩包或受控逐张保存
- 卡片单图默认走浏览器 Blob 下载，另可选择外部下载器尽力接管
- 关闭自动下载会完成当前批次后停止，取消按钮才会立即中断任务
- 自动滚动开启后只自动选择新识别的合格图片
- 后台持有批量任务状态，关闭并重开弹窗/侧栏后可恢复进度
- 抓图失败时交由浏览器单独下载，不阻断其余图片打包
- 批量打包 ZIP 下载
- 侧边栏与弹窗双入口
- 目标标签页锁定（侧边栏不再误抓当前活动页）

## 快速开始
1. 安装依赖
```bash
corepack.cmd pnpm install
```
2. 构建扩展
```bash
corepack.cmd pnpm build
```
   - 这会生成 **Chrome / Edge 桌面版**可直接加载的 `dist`
   - 侧边栏会走真正的 `side_panel`，不是新标签页降级页
3. 加载扩展
- 打开 `chrome://extensions` 或 `edge://extensions`
- 开启“开发者模式”
- 选择“加载已解压的扩展程序”
- 目录选择 `dist`

## 开发命令
```bash
# 本地开发
corepack.cmd pnpm dev

# 类型检查 + 行为测试 + Chrome 构建（自动验证）
corepack.cmd pnpm run verify

# 仅构建
corepack.cmd pnpm build

# 同时生成 Chrome + Firefox 发布包
corepack.cmd pnpm run build:browsers

# 审计 Chrome / Firefox 生产包
corepack.cmd pnpm run audit:production

# 审计生产依赖漏洞
corepack.cmd pnpm run audit:dependencies

# 首次运行端到端测试前安装 Chromium
corepack.cmd pnpm exec playwright install chromium

# 运行确定性的扩展端到端测试
corepack.cmd pnpm run test:e2e

# 验证、递增补丁版本、提交全部改动、打 tag 并原子推送
corepack.cmd pnpm run release:push
```

`build:browsers` 会把：
- Chrome 包输出到 `artifacts/pinpinto-chrome-v*.zip`
- Firefox 包输出到 `artifacts/pinpinto-firefox-v*.xpi`
- Firefox 构建最低支持版本为 115，以使用模块化后台脚本和 `storage.session`
- 并且**保持 `dist` 仍然是 Chrome 构建结果**，避免把 Firefox manifest 误加载到 Chrome / Edge 里

端到端测试使用隔离的 Chromium 配置目录和被拦截的 Pinterest 搜索页，不需要登录，也不会操作真实 Pinterest 账户。测试会验证推荐内容过滤、80 张尾批、手动 ZIP、手动逐张、自动 ZIP、优雅停止、立即取消、Blob 单图字节、失败重试、成功清理、CSP 和无障碍状态；失败时保留报告、截图和 trace。

首次安装 Playwright、完整门禁顺序、失败证据位置和只读线上 smoke 边界见 [测试指南](docs/testing.md)。

正式发布统一使用 `release:push`，不要手工拆分分支和 tag 推送。脚本默认递增补丁版本并运行完整本地门禁；tag 推送后，GitHub Actions 会再次验证、生成 Chrome ZIP 与 Firefox XPI，并创建 GitHub Release。指定已同步的版本可使用 `corepack.cmd pnpm run release:push -- --version=1.5.12`。

## 仓库结构
- `src/background.ts`: 浏览器事件与消息入口
- `src/background/batch-coordinator.ts`: 后台批量任务生命周期、取消与下载结算
- `src/background/individual-download-queue.ts`: 手动逐张下载队列、三槽并发与恢复
- `src/background/single-image-download.ts`: 卡片单图 Blob/外部下载路由
- `src/background/batch-download.ts`: 图片抓取、ZIP 与浏览器补救下载
- `src/content.ts`: 页面图片扫描与选择覆盖层入口
- `src/content/auto-batch-session.ts`: 自动滚动、批次窗口与后台重握手
- `src/content/auto-selection.ts`: 自动滚动新增图片选择控制
- `src/shared/batch-task.ts`: 批量任务共享类型
- `src/popup.ts` / `src/sidebar.ts`: 可关闭、可重连的控制界面
- `src/shared/pinterest.ts`: Pinterest 域名与匹配常量
- `manifest.config.ts`: CRX manifest 源配置

## 许可证
MIT（见 [LICENSE](LICENSE)）

PinPinto 与 Pinterest, Inc. 不隶属、无关联，也未获得其官方认可。请仅下载你有权获取的内容，并遵守适用法律、Pinterest 服务条款以及版权和其他知识产权要求。

---
致敬上游项目：[inyogeshwar/pinvault-pro-extension](https://github.com/inyogeshwar/pinvault-pro-extension)


