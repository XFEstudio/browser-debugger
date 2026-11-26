# 多浏览器选择

本技能使用 Playwright Chromium + 浏览器级 Chrome DevTools Protocol（CDP）。`npm ci` 只安装 Node 依赖，不安装或更改系统浏览器。

| `--browser` | Windows | macOS | Linux |
| --- | --- | --- | --- |
| `edge`、`chrome`、`chromium` | 检测并启动 | 检测并启动 | 检测并启动 |
| `brave`、`vivaldi`、`opera` | 检测并启动 | 检测并启动 | 检测并启动 |
| `opera-gx` | 检测并启动 | 检测并启动 | 无发现规则 |
| `chrome-beta`、`chrome-dev` | 检测并启动 | 检测并启动 | 检测并启动 |
| `edge-beta`、`edge-dev` | 检测并启动 | 检测并启动 | 检测并启动 |
| `chrome-canary`、`edge-canary` | 检测并启动 | 检测并启动 | 无发现规则 |

表格表示实现的发现规则；浏览器是否提供对应发行版、可否启动以及 CDP 命令兼容性，以实际安装和运行结果为准。Brave、Vivaldi、Opera 通过自定义可执行文件启动，Playwright 不保证所有 Chromium 分支兼容。Firefox、Safari 不提供本记录器需要的 Chromium CDP，不能使用这套全目标抓包链路；不要将 Playwright 本身支持其它引擎误写成这里已经支持。

## 发现与指定

```sh
node scripts/browser.mjs browsers
node scripts/browser.mjs doctor --browser chrome
node scripts/browser.mjs capture --browser chrome --headless --url https://example.com --seconds 10
node scripts/browser.mjs pipe --browser brave --unattended --profile-name demo
```

- 默认 `auto` 在 Windows 优先 Edge，在 macOS/Linux 优先 Chrome，然后选择其它已发现的浏览器；检测只查已知应用目录、Linux 的绝对 PATH 目录和已存在的 Playwright Chromium 文件，不扫描网络或读取登录配置。
- 显式 `--browser chrome` 找不到时返回 `BROWSER_NOT_FOUND`，不会切换账号或产品。`msedge`、`google-chrome`、`brave-browser` 等别名也可使用。
- Windows 支持系统级和用户级安装，Opera 会优先选择已知安装根目录下版本号最新的可执行文件；macOS 查系统和用户 Applications；Linux 查 PATH、常见发行版目录及 Snap 路径。
- 便携版、Chrome for Testing、未列出的 Chromium 分支用 `--executable ABS_PATH`；路径必须为真实的可执行文件。自定义路径优先于自动发现，设置 `browser` 仅作为产品和配置标签，不验证该文件的品牌。

```powershell
node scripts/browser.mjs doctor --browser chrome --executable C:/Tools/chrome-win64/chrome.exe
node scripts/browser.mjs capture --browser chrome --executable C:/Tools/chrome-win64/chrome.exe --headless --url https://example.com --seconds 10
```

未指定 browser 而指定 executable 时，配置使用路径派生的 `custom-哈希` 命名空间，避免不同便携浏览器共用配置。命名配置按最终产品及通道隔离，例如 `profiles/chrome/demo` 与 `profiles/edge/demo`。需要稳定登录态时显式固定产品、通道和 profile-name，auto 可能随安装变化选择其它产品。

可选的托管 Chromium 安装（由使用者明确运行，不在依赖安装时自动执行）：

```sh
npx playwright-core install chromium
node scripts/browser.mjs doctor --browser chromium
```

## 附加与实际兼容性

`--endpoint` 使用已授权的浏览器根 CDP 端点，不要求本机安装被附加的浏览器；`--browser` 不改变该端点实际连接的产品。端点不能同时指定 profile 或 executable。通过 `session.json.browser` 查看实际版本，通过 `browserSelection` 查看选择路径与来源。`doctor.runtimeReady` 不检查安装，`ready` 还要求选中的启动文件可用，都不等于已经成功启动。

Chrome 136 起，默认个人配置不接受普通远程调试开关。使用本技能新建的专用配置或 Chrome for Testing，不复制个人 Cookie、不重启个人窗口。企业策略、扩展和分支差异可能限制 CDP 或无头模式；记录错误、协议表和 `capture-summary.json` 的实际警告。

官方依据：[Playwright 浏览器与发行通道](https://playwright.dev/docs/browsers)、[自定义可执行文件兼容性](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-executable-path)、[Chrome 远程调试配置要求](https://developer.chrome.com/blog/remote-debugging-port)。
