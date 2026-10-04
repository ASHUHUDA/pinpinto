# 使用 aria2 下载器

本指南面向 PinPinto 用户。功能适用于 Chrome、Edge 和 Firefox，可连接本机开放 aria2 JSON-RPC 的下载器，例如 aria2c、Motrix。仅使用 aria2 内核但没有开放 RPC 的软件不一定兼容。

## 功能边界

| 入口 | aria2 模式 |
| --- | --- |
| 图片卡片单图按钮 | 直接提交一张图片；卡片显示已交接，不因提交成功移除 |
| Pinterest 图片右键菜单 | 使用“单图下载方式”设置 |
| 弹窗、侧边栏的手动批量 | 去重后逐张提交，不生成 ZIP，保留页面记录 |
| 自动分批 | 本批提交结束后压缩页面记录；页面确认后才推进 cursor 和恢复滚动 |

**已提交不等于下载完成。** aria2 模式只负责交接，进度百分比表示提交进度，不是文件下载进度。落盘、暂停、重试和后续下载失败由下载器管理。原有浏览器单图、逐张保存、ZIP 和外部下载器拦截选项仍保留；浏览器自动批次仍等待下载终态。

## 1. 准备下载器

先启动下载器并启用本机 RPC，确认端口与 RPC 密钥。

- **Motrix**：在高级设置中查看 RPC 监听端口和授权密钥。官方示例端口为 `16800`；以你的实际设置为准。扩展的“使用 Motrix 端口”按钮只填写地址，不会启动软件。
- **aria2c**：在你自己的配置中设置 `enable-rpc=true`、`rpc-listen-all=false`、`rpc-listen-port=6800`，并设置自己的 `rpc-secret`。官方默认端口是 `6800`。
- **其他下载器**：必须提供兼容的 `aria2.getVersion`、`aria2.addUri` 和 `aria2.tellStatus`，且支持为任务指定 GID。

不要把 RPC 监听开放到公网，也不要把真实密钥写进仓库。图片保存到下载器已经配置的默认目录；PinPinto 不设置 `dir`。

## 2. 保存并测试连接

1. 打开 PinPinto 弹窗或侧边栏，展开 **aria2 连接设置**。
2. 填写本机 HTTP(S) JSON-RPC 地址，例如 `http://127.0.0.1:6800/jsonrpc` 或 `http://localhost:16800/jsonrpc`。
3. 将 RPC 密钥填入独立密码框。如果下载器没有设置密钥，可留空；不接受包含用户名或密钥的 URL。
4. 点击 **保存并测试连接**，按浏览器提示授权这个本机主机。
5. 成功时应看到 aria2 版本号。失败时检查下载器是否运行、RPC 是否启用、端口和密钥是否对应。

地址保存在本机。密钥只保存在浏览器会话存储，不进入云同步、任务快照、日志或页面消息。关闭弹窗不会丢失会话密钥，**重启浏览器后需要重新输入**。密码框留空会保留现有会话密钥；勾选“清除已保存的密钥”并保存可删除它。配置保存后即使测试失败也会保留，以便修正设置。

只支持 `localhost` 和 `127.0.0.1`，不支持 NAS、远程地址、WebSocket、带 query/fragment 的地址。浏览器主机权限不能限定端口；实际 RPC 请求仍严格使用所填本机端点，禁止重定向。

## 3. 选择下载方式

- **单图下载方式 → aria2 RPC**：作用于图片卡片按钮和图片右键菜单。
- **批量 / 自动下载方式 → aria2 RPC**：作用于弹窗、侧边栏的手动下载及自动分批。此时 ZIP 开关禁用，但不会覆盖原来的 ZIP 偏好；切回浏览器恢复该设置。
- 自动开关显示 **自动提交至 aria2**，每批仍按配置数量暂停滚动和逐张发送。原有总批次数、完成当前批次后停止、立即取消均有效。

优先高清开启时，直接提交优选高清 URL，不在扩展中下载图片，也不把缩略图与高清图作为同一任务的镜像。若该高清地址在下载器中失败，可关闭优先高清后自行选择重新提交；扩展不追踪交接后的图片错误，也不自动回退浏览器。

## 4. 错误、取消和记录

- **明确拒绝**：跳过并计数，继续提交后面的图片；自动模式会随本批一起释放这些已明确跳过的记录，不自动重试。
- **超时、断线、无效或冲突响应**：停止提交，报告已接收、明确拒绝、状态不明和未提交数量。自动模式保留整个当前窗口，不推进 cursor。单图请求丢失后台回包时也标记不确定并禁用重复点击。先检查下载器队列，不要直接重选整批重发。
- **取消当前任务**：停止后续提交，已交接的任务不撤销。正在发送的请求可能已经到达下载器，因此提示状态不明；删除这些任务需在下载器中操作。
- **后台重启**：完整持久化的已交接窗口可继续页面确认；未完整交接的窗口标记中断，绝不自动重放图片。
- **防止底层重发产生重复任务**：每次提交携带固定的唯一 GID。若浏览器重发触发重复 GID 拒绝，只用 `tellStatus` 核对同一任务和图片 URL；核对成功才确认交接，不再次调用 `addUri`。

计数提示对应当前窗口；已完成自动窗口的累计计数在继续扫描和最终交接摘要中显示。页面被保留并不意味着图片未提交，手动重新开始仍可能产生重复任务，必须先核查下载器。

## 开发验证

```powershell
corepack.cmd pnpm exec node --test scripts/tests/aria2-client.test.mjs scripts/tests/aria2-config.test.mjs scripts/tests/aria2-download.test.mjs scripts/tests/background-download-lifecycle.test.mjs
corepack.cmd pnpm run verify
corepack.cmd pnpm run test:e2e
corepack.cmd pnpm run build:browsers
corepack.cmd pnpm run audit:production
git diff --check
```

E2E 使用本机可控 RPC 服务，覆盖按钮操作、单图、手动、自动窗口、明确拒绝、断线及 Chromium 底层 POST 重发，不需要真实下载器或密钥。真实 Motrix/aria2c 的端口、密钥、下载目录和实际图片下载需按以上步骤自行验证；Firefox 构建验证不等于 Firefox 运行时实测。

## 来源

- [aria2 官方 RPC 手册](https://aria2.github.io/manual/en/html/aria2c.html#rpc-interface)：方法、授权、GID 与任务选项。
- [Motrix 官方 RPC 说明](https://motrix.app/zh/blog/motrix-v1-4-x-release-note#rpc-authorization-secret-token)：浏览器接入和官方端口示例。
- [Chrome 扩展跨域请求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)：后台请求与主机权限边界。
- [MDN 浏览器兼容数据](https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/optional_host_permissions.json)：Firefox 的专用可选主机权限键从 128 开始支持；PinPinto 为 Firefox 115 使用 `optional_permissions`。
