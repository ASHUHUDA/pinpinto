# PinPinto

[English README](README_en.md)

一个面向 Chrome、Edge 和 Firefox 的 Pinterest 图片采集与批量下载扩展。

## 核心功能
- 页面图片识别与勾选
- 自动滚动抓取更多图片
- 自动分批下载支持自定义每批图片数量
- 手动选择后下载 ZIP 或逐张保存
- 卡片单图使用浏览器 Blob 下载，并可尝试交由外部下载器处理
- 支持完成当前批次后停止或立即取消自动下载
- 弹窗与侧边栏均可控制锁定的目标标签页

## 快速开始
1. 安装依赖
```bash
corepack.cmd pnpm install
```
2. 构建扩展
```bash
corepack.cmd pnpm build
```
3. 加载扩展
- 打开 `chrome://extensions` 或 `edge://extensions`
- 开启“开发者模式”
- 选择“加载已解压的扩展程序”
- 目录选择 `dist`

## 开发命令
```bash
# 本地开发
corepack.cmd pnpm dev

# 重新生成扩展图标
corepack.cmd pnpm run icon:build

# 类型检查
corepack.cmd pnpm run typecheck

# Node 行为与契约测试
corepack.cmd pnpm run test:release

# 自动验证：类型检查、行为测试和 Chrome 构建
corepack.cmd pnpm run verify

# 构建 Chrome / Edge 扩展并打包
corepack.cmd pnpm build

# 生成 Chrome 与 Firefox 发布包
corepack.cmd pnpm run build:browsers

# 生产包审计
corepack.cmd pnpm run audit:production

# 生产依赖审计
corepack.cmd pnpm run audit:dependencies

# 首次端到端测试前安装 Chromium
corepack.cmd pnpm exec playwright install chromium

# 确定性扩展端到端测试
corepack.cmd pnpm run test:e2e

# 发布预检与本地发布命令
corepack.cmd pnpm run release:preflight
corepack.cmd pnpm run release
corepack.cmd pnpm run release:force
corepack.cmd pnpm run release:push
```

首次安装 Playwright、完整质量门禁、失败证据位置、发布流程及只读线上 smoke 边界见 [测试指南](docs/testing.md)。

## 许可证
MIT（见 [LICENSE](LICENSE)）

PinPinto 与 Pinterest, Inc. 不隶属、无关联，也未获得其官方认可。请仅下载你有权获取的内容，并遵守适用法律、Pinterest 服务条款以及版权和其他知识产权要求。

---
致敬上游项目：[inyogeshwar/pinvault-pro-extension](https://github.com/inyogeshwar/pinvault-pro-extension)


