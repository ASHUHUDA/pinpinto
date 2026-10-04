# PinPinto 项目流水 · DESKTOP-5D6NR80

## 2026-10-04 · aria2 全入口接入

- 用户经 grilling 确认：aria2 覆盖卡片单图、右键菜单、弹窗/侧边栏手动批量及自动分批；仅本机；接收即交接；明确拒绝计数跳过继续；状态不明停止；用下载器默认目录；保留浏览器/ZIP/外部拦截。
- 自动 aria2 是“自动提交”而非落盘保证：交接窗口完成后沿用 commit/ack/cursor/resume；断线保留窗口且不重放。浏览器模式的终态与压缩先后不变。
- 实测踩坑：Chromium 在复用连接重置时会底层重发 POST（同一 RPC ID），仅禁止应用层重试不足以防重。为 addUri 指定唯一 GID；拒绝后用 tellStatus 只读核对同 GID 和原图片 URI，不再 addUri。
- 密钥仅 storage.session，页面配置消息只允许可信 popup/sidebar；端点在 local，模式偏好在 sync。重启浏览器需重新填密钥。只允许 localhost/127.0.0.1，禁止重定向、携带 URL 凭据和任意外部图片 URL。
- Firefox 115 不支持 optional_host_permissions（128 才支持），Firefox 构建使用 optional_permissions 主机模式；Chrome 用专用可选主机键。生产审计禁止将本机权限变成必需权限。
- 为保持 700 行既有硬契约，仅抽离 ZIP 执行适配和输出摘要；协调器最终 699 行。不放宽契约测试。全量回归另修正原有 tooltip 文案期望和输入框遮挡，断言保留。
- 验证：类型检查、177/177 Node、14/14 Chromium E2E、Chrome/Firefox 构建与生产包审计、git diff --check 均通过。无新增依赖；不推送、不发布。
- 未验证：真实 Motrix/aria2c 和 Firefox 运行时；E2E 使用可控本机 RPC。正式说明见 docs/aria2.md，测试流程见 docs/testing.md。

## 2026-10-04 · 用户明确版本交付规则

- 用户要求每次功能变更同步更新版本，幅度按功能轻重；aria2 新能力从 1.5.14 升至 1.6.0，而非仅升补丁。规则写入 AGENTS.md 和项目 MEMORY.md，不擅自提升为全局偏好。
- 同步 package.json、manifest.config.ts、popup.html、sidebar.html；pnpm-lock.yaml 不含项目根版本字段，无需修改依赖锁。
- 新增源版本一致性测试，要求四处与 package.json 一致；已升版正式发布显式传 --version，防止 release:push 默认补丁再次递增。主版本升级另须处理发布脚本 1.x 限制。
- 版本更正验证：6/6 release 测试、verify 的 178/178 Node、Chrome/Firefox 1.6.0 构建与生产包审计通过，git diff --check 通过。仅版本和规范变动，未重复运行 E2E；上一轮功能 E2E 为 14/14。未推送、未发布。
