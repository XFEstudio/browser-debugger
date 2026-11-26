# 运行、附加和排错

## 运行时与目录

`package-lock.json` 固定依赖。安装仅写本 skill 的 `node_modules`，不全局安装、不改用户浏览器设置。默认配置位于 `workDir`，跨任务应使用 `profileName` 将配置放到固定 stateDir；捕获数据仍在本次 `workDir/captures/时间-随机值/`。不要使用正在运行的个人默认 profile 启动第二个实例；一个 profile 同时只能由一个浏览器进程使用。

网站需要身份验证时，先复用宿主公开的已授权浏览器会话或有效命名配置。新建空配置不会继承个人浏览器登录态；不要从其它 profile 抽取 Cookie 或要求用户把密码、OTP 发到聊天里。无人值守模式、宿主会话路由和持续交互见 [自动会话与无人值守](unattended.md)。

`openSession` 参数：

| 参数 | 默认与用途 |
| --- | --- |
| `browser` | `auto`；支持 Chrome、Edge、Chromium、Brave、Vivaldi、Opera 及通道，详见 [浏览器选择](browsers.md) |
| `headless` | `false`，默认显示浏览器 |
| `unattended` | 默认 `false`；设为 true 且未指定 headless 时使用无头，配合 `navigate/ensureReady` 与 CLI 进行阻塞检查 |
| `executablePath` | 可选，本机 Chromium 系浏览器的绝对可执行路径 |
| `workDir` | 当前任务工作目录下 `work/browser-debug` |
| `profileDir` | `workDir/profile-实际浏览器名`，仅用于自行启动；auto + 自定义路径使用稳定哈希隔离 |
| `profileName` | 可选固定配置名；与 profileDir 互斥，跨任务保留该专用配置的登录态 |
| `stateDir` | 命名配置根目录，Windows 默认 `%LOCALAPPDATA%/Codex/browser-debugger`，支持环境变量 `BROWSER_DEBUGGER_STATE_DIR` |
| `outputDir` | 自动生成唯一捕获目录；不覆盖已有 `events.jsonl` |
| `endpoint` | 附加到已开启 CDP 的浏览器，HTTP 或 browser WebSocket 地址 |
| `targetUrl` | 附加时精确选择已有目标；多个/缺失匹配会报错，不猜第一个标签页 |
| `initialUrl` | CLI 的初始导航目标；附加时优先复用相同 URL，否则尝试创建新页，不覆盖无关标签页 |
| `contextIndex` | 附加模式下选择操作用的已有 context，默认 0；捕获仍覆盖该端点可附加的目标 |
| `timeoutMs` | Playwright 动作默认 15 秒 |
| `navigationTimeoutMs` | 导航默认 30 秒 |
| `maxBodyBytes` | 32 MiB，单响应体保存上限；0 关闭响应体保存 |

自行启动时使用随机本地调试端口 `--remote-debugging-port=0`，从专用 profile 的 `DevToolsActivePort` 发现端口；调试地址为本机回环，不把调试服务暴露到局域网。不会强制关闭用户现有 Edge，也不添加关闭证书校验或关闭同源策略的参数。

## 附加已有 Chromium 系浏览器

现有浏览器必须已经支持并启用远程调试，普通已打开的窗口不一定可以直接附加。不杀进程、不静默重启用户浏览器。优先使用当前工具公开的浏览器会话；需要独立的 CDP 会话时创建专用实例，或连接用户给出的调试端点。

宿主浏览器控制不要求外部 CDP。独立实例由 CLI 自动启动并使用随机回环端口，不默认让用户执行 PowerShell 启动命令；宿主审批拒绝后也不能通过另一启动器重试同一受限动作。

```javascript
var debugSession = await browserDebug.openSession({
  endpoint: 'http://127.0.0.1:9222',
  targetUrl: 'https://example.com/',
  workDir: 'C:/ABSOLUTE/TASK/work/browser-debug'
});
var page = debugSession.page; // 已精确选择实际目标。
```

HTTP 端点提供 `/json/version`、`/json/list`、`/json/protocol`。必须使用 browser WebSocket 端点来做跨目标捕获，不能把 `/devtools/page/...` 当浏览器根连接。

Playwright CDP 附加对部分高级能力的兼容性低于原生 Playwright 启动。附加模式无法回溯安装原生 HAR 录制配置，因此使用 `network.cdp.har`；已有浏览器的下载、窗口和权限行为以实际上下文为准。当前会话不在环境允许的执行范围内时遵守宿主限制，不绕过限制建立隐藏连接。

## 持久工具与脚本

有持久 Node.js REPL 时直接导入 helper，保持 `debugSession` 在全局变量中。工具可能有自己的模块搜索路径，但 `file:///` 绝对路径导入会让 helper 从本 skill 目录解析 `playwright-core`，不要求修改全局包目录。读取截图时用当前工具的图片输出能力或从本地文件查看，不输出大段图片 base64。

没有原生 Node REPL 时，多轮操作用 `browser.mjs pipe` 及终端 stdin，一次完整任务用 `run --script`。不要在短命进程中创建 session 后假设下一次命令还能访问其 page；也不要为每个任务重写持久通信脚本。只有任务本来要求用户手动交互抓包时才使用 `capture` 等待该交互。

## 定位失败

- `playwright-core` 缺失：在 skill 目录执行 `npm.cmd ci --ignore-scripts`。
- `BROWSER_NOT_FOUND`：用 `browsers` 查看已发现的路径，显式指定 `--browser` 或绝对 `--executable`。指定 Chrome 不会改用 Edge；Chrome for Testing、便携版和非标准安装路径用 `--executable`。
- `INVALID_EXECUTABLE`：路径必须绝对、存在且为可执行文件。不要传应用目录或 macOS `.app` 目录，需指向 `Contents/MacOS/` 内的可执行文件。
- profile 被占用：复用已有端点，或在本任务 `work/` 中另取 profile；不强杀所有 Edge 进程。
- CDP 无法连接：检查本机端口、`/json/version`、企业策略及浏览器是否实际启用调试；不能从“窗口存在”推断 CDP 可用。
- 页面卡住：先检查用户登录、JS 异常、失败请求、弹窗和 `debugSession.targets()`。采集器在配置新目标后会恢复等待调试的目标；手动设置断点后由操作者负责 `Debugger.resume`。
- 请求有记录但没有 body：看 `bodyUnavailable`、`maxBodyBytes`、是否下载/重定向/流式未结束、目标是否已关闭，不能伪造空响应体。
- 跨站 iframe/Worker 遗漏：核对目标类型、`networkEnabled`、附加时刻和 `capture-summary.json` 警告，再做可控复现；新开标签页须先附加再导航。
- 原生文件对话框/系统弹窗：常规上传优先用 file input 或 filechooser API，只有原生系统功能才路由到宿主可用的原生 UI 工具。

需要验证环境或修改了 helper 时运行 `npm.cmd test`（macOS/Linux 用 `npm test`）。单元测试覆盖三系统路径、通道、缺失浏览器、Opera 版本目录和自定义配置隔离；集成测试启动独立无头浏览器和本地 HTTP fixture，覆盖上传、下载、网络与媒体流程、命名配置持久化、账号隔离、精确选择标签页、阻塞检测和真实 CLI 会话。通过 `BROWSER_DEBUGGER_TEST_BROWSER=chrome` 或 `BROWSER_DEBUGGER_TEST_EXECUTABLE` 选择测试浏览器，默认 auto。产物在 `work/self-test-*` 与 `work/unattended-test-*`；也可向两个集成脚本传入绝对 work 子目录。不会访问外部站点或真实账号。

官方依据：[Edge DevTools Protocol](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/)、[Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype)。协议方法以本机 `protocol.json` 为准。
