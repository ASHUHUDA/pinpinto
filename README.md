# PinPinto

[English README](README_en.md)

一个基于 Chrome/Edge Manifest V3 的 Pinterest 图片采集与批量下载扩展。

## 功能概览
- 页面图片识别与勾选
- 自动滚动抓取更多图片
- 自动分批下载支持自定义每批图片数量
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

# 类型检查 + 构建（自动验证）
corepack.cmd pnpm run verify

# 仅构建
corepack.cmd pnpm build

# 同时生成 Chrome + Firefox 发布包
corepack.cmd pnpm run build:browsers
```

`build:browsers` 会把：
- Chrome 包输出到 `artifacts/pinpinto-chrome-v*.zip`
- Firefox 包输出到 `artifacts/pinpinto-firefox-v*.xpi`
- 并且**保持 `dist` 仍然是 Chrome 构建结果**，避免把 Firefox manifest 误加载到 Chrome / Edge 里

## 仓库结构
- `src/background.ts`: 下载与任务编排
- `src/content.ts`: 页面图片扫描与选择覆盖层
- `src/popup.ts`: 弹窗控制逻辑
- `src/sidebar.ts`: 侧边栏控制逻辑
- `src/shared/pinterest.ts`: Pinterest 域名与匹配常量
- `manifest.config.ts`: CRX manifest 源配置

## 许可证
MIT（见 [LICENSE](LICENSE)）

---
致敬上游项目：[inyogeshwar/pinvault-pro-extension](https://github.com/inyogeshwar/pinvault-pro-extension)


