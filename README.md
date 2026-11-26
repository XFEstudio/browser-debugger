# 浏览器调试与抓包 · Browser Debugger

面向 Codex 等支持 `SKILL.md` 的代理工具：复用已授权的浏览器会话，自动操作网页，并从操作前开始记录 HTTP、WebSocket、SSE 与跨目标 CDP 事件。

支持 Chrome、Edge、Chromium、Brave、Vivaldi、Opera，以及 Chrome / Edge 的 Beta、Dev、Canary 通道。提供 Windows、macOS、Linux 安装发现规则、自定义可执行路径和已有 CDP 端点连接。

## 能做什么

- **网页操作**：真实文件上传、下载、表单、弹窗、iframe、截图、媒体画面与字幕取证。
- **网络捕获**：可附加标签页、弹窗、跨进程 iframe、Worker 的请求、重定向、响应体、WS 帧、SSE 与控制台事件，导出 JSONL、接口索引和 HAR。
- **持续会话**：命名专用配置跨任务保留登录态，JSONL 管道持续交互；连接已有浏览器后退出只断开本工具。
- **调试**：调用当前浏览器实际支持的 CDP 命令，保存实时协议定义；对登录、验证和访问阻塞返回明确状态。

抓包范围为连接后成功启用 Network 的 CDP 目标，不保证浏览器内部、连接前或其它进程的流量。Firefox / Safari 不适用本 CDP 记录器。详见 [浏览器矩阵](references/browsers.md) 与 [捕获范围](SKILL.md#捕获范围与交付)。

## 安装为 skill

需要 **Node.js 22+**、Git，以及一个兼容的 Chromium 浏览器。将仓库放入代理工具识别的 skills 目录；Codex 可使用个人的 `~/.agents/skills/browser-debugger`。

Windows PowerShell：

```powershell
git clone https://github.com/XFEstudio/browser-debugger.git "$HOME/.agents/skills/browser-debugger"
Set-Location "$HOME/.agents/skills/browser-debugger"
npm.cmd ci --ignore-scripts --no-audit --no-fund
node scripts/browser.mjs doctor
```

macOS / Linux：

```sh
git clone https://github.com/XFEstudio/browser-debugger.git ~/.agents/skills/browser-debugger
cd ~/.agents/skills/browser-debugger
npm ci --ignore-scripts --no-audit --no-fund
node scripts/browser.mjs doctor
```

已有同名 skill 时先备份自己的改动再更新，不向已有目录直接 clone。也可下载 [Release](https://github.com/XFEstudio/browser-debugger/releases) 的 ZIP，解压为 `browser-debugger` 目录后安装依赖。依赖锁定，不会自动下载浏览器。若未安装兼容浏览器，可自行运行 `npx playwright-core install chromium`。

## 使用

对代理工具说：

> 使用 $browser-debugger，通过 Chrome 打开我指定的网站，操作前开始抓包，完成后保存 HAR 和接口分析结果。

命令行也可独立运行：

```sh
# 查看安装发现结果；不会启动浏览器
node scripts/browser.mjs browsers
node scripts/browser.mjs doctor --browser chrome

# 使用指定产品，捕获 10 秒
node scripts/browser.mjs capture --browser chrome --headless --url https://example.com --seconds 10

# 跨任务保留专用登录态，JSONL 持续交互
node scripts/browser.mjs pipe --browser edge --unattended --profile-name demo

# 附加已授权的浏览器根 CDP 端点
node scripts/browser.mjs capture --endpoint http://127.0.0.1:9222 --target-url https://example.com/ --seconds 10
```

默认 `auto`：Windows 优先 Edge，macOS/Linux 优先 Chrome；指定产品失败会明确报错。便携版可加 `--executable` 绝对路径。固定登录态时固定 `--browser` 与 `--profile-name`。所有选项见 `node scripts/browser.mjs help`。

`pipe` 从 stdin 接收一行一个命令：

```jsonl
{"id":1,"op":"navigate","url":"https://example.com/"}
{"id":2,"op":"snapshot"}
{"id":3,"op":"flush"}
{"id":4,"op":"close"}
```

需要完整 Playwright / CDP 操作时，用 `run --script ABS_PATH` 或在持久 Node 进程导入 [browser-session.mjs](scripts/browser-session.mjs)。任务模块导出 `default async function({session,page,context,outputDir,signal})`。

## 输出

默认保存到当前任务 `work/browser-debug/captures/时间-随机值/`：

| 文件 | 内容 |
| --- | --- |
| `events.jsonl` | 原始 CDP 事件、WS 帧、SSE、控制台事件 |
| `requests.json`、`extra-info.json`、`bodies/` | 请求各跳、元数据及可取得的响应体 |
| `network.cdp.har` | 所有已捕获目标的 HTTP HAR |
| `network.playwright.har` | 自行启动 context 的原生 HAR，关闭时生成 |
| `api-index.json` | 观察到的 fetch/XHR 接口索引 |
| `capture-summary.json` | 目标、警告、遗漏原因与范围 |
| `session.json`、`protocol.json` | 实际浏览器、选择路径、实时协议 |

专用登录配置与捕获分开保存。原始抓包可能包含凭据与私人内容，分享前脱敏；本仓库和发行包不包含登录配置、依赖、抓包或真实任务数据。

## 验证与开发

```sh
npm run test:unit
npm run test:integration
```

单元测试覆盖三系统发现、显式选择不回退、Opera 版本排序和便携浏览器配置隔离。集成测试只访问本地 fixture，验证上传、下载、跨目标抓包、WS/SSE、HAR、媒体、附加/断开、持久登录和真实 CLI 管道。用 `BROWSER_DEBUGGER_TEST_BROWSER` 与 `BROWSER_DEBUGGER_TEST_EXECUTABLE` 指定测试产品及路径。CI 在三系统运行发现测试，在 Windows / Linux 运行托管 Chromium 集成测试，并在 Windows 运行 Chrome 集成测试。

## 文档

- [代理执行入口](SKILL.md)
- [多浏览器矩阵与选择](references/browsers.md)
- [运行、连接与排错](references/runtime.md)
- [持久登录与无人值守](references/unattended.md)
- [上传下载等网页操作](references/browser-actions.md)
- [网络、接口与 CDP 调试](references/network-and-devtools.md)
- [媒体与嵌入式浏览器](references/media-and-embedded.md)
- [更新记录](CHANGELOG.md)

MIT License · XFEstudio
