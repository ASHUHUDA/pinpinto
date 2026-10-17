# PinPinto

[English README](README_en.md)

一个面向 Chrome、Edge 和 Firefox 的 Pinterest 图片采集与批量下载扩展。

## 核心功能
- 页面图片识别与勾选
- 自动滚动抓取更多图片
- 自动分批下载使用浏览器 ZIP，支持自定义每批图片数量
- 手动选择后下载 ZIP 或逐张保存
- 单图默认提交至本机 aria2 RPC，可切换浏览器 Blob 下载或外部下载器；已保存的单图偏好保留
- 手动批量可选择本机 aria2 RPC；以接收成功为交接，不宣称落盘完成，自动批次不受该设置影响
- 支持完成当前批次后停止或立即取消自动下载
- 弹窗与侧边栏均可控制锁定的目标标签页

## 下载目录与文件名
- 浏览器下载 API 只接受相对于默认下载目录的路径。将浏览器默认下载目录设为 `E:\Downloads\Media` 后，PinPinto 的 `PinPinto/...` 路径会实际落到 `E:\Downloads\Media\PinPinto`。
- 单图和压缩包文件名均以 `PinPinto` 开头，ZIP 内的图片文件也以 `PinPinto-` 开头。
- 单图使用 aria2 时，实际落盘目录由 aria2 配置决定；上述目录约定适用于浏览器下载模式。

aria2 / Motrix 的地址、密钥、连接测试及失败处理见 [aria2 使用指南](docs/aria2.md)。RPC 密钥默认仅在本机长期保存，不加密、不云同步；面板显示圆点掩码，不因保存或重开而清空，仅显式清除才删除。说明收在密钥旁的 ⓘ 提示中。

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

# 发布前全量确定性扩展端到端测试（非单项 bug 的默认验证）
corepack.cmd pnpm run test:e2e

# 发布预检与本地发布命令
corepack.cmd pnpm run release:preflight
corepack.cmd pnpm run release
corepack.cmd pnpm run release:force
corepack.cmd pnpm run release:push
```

浏览器审查范围：版本发布前全量审查；单项 bug 仅审查该功能，不扩展到全部功能。日常开发默认不启动浏览器审查，仅在必要时做定向验证。

定向 E2E 命令、首次安装 Playwright、完整发布门禁、失败证据位置、发布流程及只读线上 smoke 边界见 [测试指南](docs/testing.md)。

## 许可证
MIT（见 [LICENSE](LICENSE)）

PinPinto 与 Pinterest, Inc. 不隶属、无关联，也未获得其官方认可。请仅下载你有权获取的内容，并遵守适用法律、Pinterest 服务条款以及版权和其他知识产权要求。

---
致敬上游项目：[inyogeshwar/pinvault-pro-extension](https://github.com/inyogeshwar/pinvault-pro-extension)


