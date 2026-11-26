# 自动会话与无人值守

## 选用已有会话

“无人值守”表示自动完成环境允许且已获授权的浏览器步骤，不表示绕过登录、验证码、浏览器安全警告或宿主审批。任务已包含网站操作时，不重复要求用户打开浏览器或运行调试命令；先完成可自动执行的步骤。

1. 宿主有浏览器控制工具时，用其公开的清单确认浏览器、配置和标签页，读该工具返回的 API 文档。需要登录的网站优先使用该配置的现有登录态；有正常浏览器时不要默认选 Game Assist/游戏边栏。宿主能直接操作普通 Edge，不需要先开启外部 CDP。
2. 有授权的已知 CDP 端点时，用 `openSession({endpoint, targetUrl})` 精确选择标签页；`--url` 可以复用相同 URL 的标签页，否则创建新页，不覆盖不相关页面。多个匹配会返回 `AMBIGUOUS_PAGE`，没有匹配的目标会返回 `TARGET_NOT_FOUND`。
3. 没有可用宿主会话且允许独立启动时，由代理自行启动 CLI。用固定的 `--profile-name` 跨任务保留该专用配置的登录态。不会导入个人默认浏览器的 Cookie，也不要求用户关闭自己的浏览器。

宿主只有 standalone sidebar 时，新建标签页可能不可用。先检查已有目标页是否可操作；没有合适的已授权目标时报告具体能力缺口。截图宽度为 0 时记录视觉尚未确认，不激活窗口补看、不把 DOM 快照说成截图。不要反复重试相同的受限操作，也不要通过 shell、另一个启动器或隐藏连接绕过审批拒绝。

宿主提供的标签页或 CDP capability 可能只覆盖单页。只有 CLI 的浏览器级记录器成功附加的目标，才能计入其全目标捕获范围。

## 跨任务保留登录态

```powershell
node scripts/browser.mjs pipe --browser chrome --unattended --profile-name shop --work C:/ABSOLUTE/TASK/work/browser-debug
```

命名配置在 Windows 默认保存于 `%LOCALAPPDATA%/Codex/browser-debugger/profiles/实际浏览器/shop`，上例为 `chrome/shop`。macOS/Linux 默认根目录为 `${XDG_STATE_HOME:-~/.local/state}/browser-debugger`。可用 `--state-dir ABS_PATH` 或 `BROWSER_DEBUGGER_STATE_DIR` 改目录。`work` 中只保存本次捕获和任务文件。`doctor` 会报告实际 stateDir，不会读取或导出凭据。跨任务固定 browser 与 profile-name；不同浏览器、不同通道使用独立配置，不复制个人默认配置。

同一名称应对应同一个预期账号；不要为了登录失败而改名反复创建空配置。`--profile-name` 与 `--profile` 互斥；附加端点不能同时指定 profile。名称仅允许 1–64 个字母、数字、下划线和连字符，不能包含目录跳转。配置只能由一个浏览器进程使用；已被占用时复用明确的已授权连接，不杀浏览器或删除其锁文件。

首次身份验证可能仍需站点支持的登录流程。现有宿主登录态、已授权的正常自动登录或命名配置中的有效登录态可直接复用；没有这些条件时，输出 `LOGIN_REQUIRED`，不要承诺已经具备访问权限。

## 在实际 Node 进程中持续交互

持久 REPL 不一定有完整 Node 能力。先检查 `typeof process`；若不存在或不允许原生模块，直接用 CLI `pipe`，无需临时构建服务器、轮询文件或复制 stdin runner。

通过终端工具启动 `pipe` 并保留其 session ID，然后用该工具的 stdin 写入能力发送 JSONL。需要 PTY 的宿主应在启动时设置 `tty: true`。每条命令独占一行，不要把命令拼进 shell。

```json
{"id":1,"op":"navigate","url":"https://example.com/"}
{"id":2,"op":"snapshot","maxChars":12000}
{"id":3,"op":"run","script":"C:/ABSOLUTE/TASK/work/task.mjs"}
{"id":4,"op":"screenshot"}
{"id":5,"op":"flush"}
{"id":6,"op":"close"}
```

命令串行执行，回复包含相同的 `id`、`ok` 和 `result` 或 `error`。非法 JSON、任务异常和被阻塞的命令不会自动重放，进程保持可用。`close`、stdin EOF、SIGINT 或 SIGTERM 会退出并刷盘；自行启动的浏览器关闭，附加的浏览器只断开连接。stdin 不开放任何 HTTP 服务或额外远程命令端口。

| op | 参数与结果 |
| --- | --- |
| `navigate` | `url`：HTTP(S) 地址；等待 DOM 就绪后检查状态，相同 URL 不重复导航 |
| `inspect` | 只读返回页面状态，可传 `readiness` |
| `snapshot` | 返回实际 URL、标题和正文；`maxChars` 为 1–50000，默认 12000 |
| `select` | `url`：精确匹配已有标签页；缺失或重复时不改变当前页 |
| `run` | `script`：实际本地模块绝对路径；每次重新导入执行，返回模块结果 |
| `screenshot` | 可选 `path` 绝对路径、`fullPage`；默认保存到捕获目录，零尺寸返回 `SCREENSHOT_UNAVAILABLE` |
| `flush` | 写入当前捕获索引和 HAR，继续记录 |
| `close` | 结束持续会话 |

任务模块导出 `default async function({session,page,context,outputDir,signal})`。`signal` 可用于取消耗时循环。使用 `session.selectPage(url)` 更新持续会话的当前页；局部变量 `page` 不会随选择自动重绑定。

```javascript
export default async function ({ session }) {
  // 从实际页面得出选择器；此处只是示例，不是某个真实站点的选择器。
  await session.navigate('https://example.com/account', { readySelector: '#account-panel' });
  const page = session.page;
  await page.getByLabel('名称').fill('用户指定的名称');
  await session.ensureReady({ readySelector: '#account-panel' });
  // 后续提交仍按当前用户已授权的具体任务执行，并核验网站结果。
  return { url: page.url() };
}
```

`run` 前会检查当前页；任务内部发生导航后应再次使用 `session.navigate()` 或 `ensureReady()`。直接调用原生 `page.goto()` 和 Playwright 操作仍可用，但不会凭空获得站点专属的就绪判断。

## 就绪与阻塞状态

`--unattended` 自行启动时默认无头，可显式选择 `--headed`；不会自动把被拒绝的无头会话改成隐蔽的普通浏览器。`session_ready` 仅代表连接和捕获器已启动，其 `pageReady` 为 null，不代表登录或任务已成功。

从实际页面确定关键状态后，设置 `--ready-selector CSS`、`--ready-text TEXT`、`--login-selector CSS`、`--blocked-selector CSS`。pipe 的每条命令也可传 `readiness:{readySelector,readyText,loginSelector,blockedSelector,readyTimeoutMs}`，覆盖启动参数。readySelector 与 readyText 同时提供时必须都成立；默认给缺失就绪条件 10 秒加载时间，readyTimeoutMs 可设为 1–60000 毫秒。未指定就绪条件时仅返回 `observed`、`ready:null`，不声称账号已登录或页面已可提交。

通用检测只判断实际可见的登录表单/登录 iframe、已识别的验证挑战和明确访问拦截。普通导航中的“登录”链接、隐藏登录 iframe 不会阻塞。它不是所有网站的验证检测器；站点特定流程必须提供对应的就绪/阻塞选择器，并在每次关键状态变化后检查。

| code | 含义 |
| --- | --- |
| `LOGIN_REQUIRED` | 可见登录页面或指定登录控件，需要有效身份验证 |
| `VERIFICATION_REQUIRED` | 检测到可见验证挑战，插件不代为绕过 |
| `ACCESS_BLOCKED` | 网站明确拒绝访问或匹配 blockedSelector |
| `READY_CONDITION_MISSING` | 实际就绪条件未成立，未运行任务模块 |
| `FRAME_INSPECTION_INCOMPLETE` | 可见 frame 未能检查，状态尚未确认 |
| `AMBIGUOUS_PAGE` / `TARGET_NOT_FOUND` | 无法唯一确定操作目标 |
| `TAB_CREATION_UNAVAILABLE` | 当前连接不能建立新页，需要可用的已授权目标 |

`run --unattended` 启动检查失败时退出码为 1，并以结构化 `error` 给出原因。`pipe` 中的失败通过对应 id 回复，等待后续已授权命令，不反复提交有副作用的任务。

截图成功不代表视觉验收通过；返回的 `visualVerified:false` 是提醒后续按 background-visual-check 检查原图与证据。不得在 `snapshot` 中输出密码框值、Cookie、Authorization 或整份 storage 来证明登录。
