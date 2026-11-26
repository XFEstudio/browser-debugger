# 视频、嵌套页面与内置浏览器

## 视频内容取证

先枚举 `page.frames()`，HTML5 播放器、字幕和题目可能位于不同层 iframe。不能从主文档没有 `<video>` 推断页面没有视频。导航时旧 iframe 可能暂时仍在：等待所选章节/文档身份与任务 iframe 同时更新，再读取新内容。

`scripts/media-evidence.mjs` 提供正常播放期间的画面与字幕取证，兼容跨域视频（使用浏览器截图，不依赖可能被污染的 canvas）：

```javascript
var mediaTools = await import(pathToFileURL('C:/ABSOLUTE/SKILL/browser-debugger/scripts/media-evidence.mjs').href);
var mediaState = await mediaTools.inspectMedia(page);
// 先依据实际页面点击播放按钮；helper 不会自动修改播放状态。
var evidence = await mediaTools.captureMediaEvidence(page, {
  outputDir: 'C:/ABSOLUTE/TASK/work/video-evidence',
  seconds: 60, intervalSeconds: 10,
  onSample: async sample => { /* 可按批调用用户配置的视觉 Agent */ }
});
```

清单记录真实媒体时间、采集时间、播放器位置、来源、字幕活动 cue、截图和缺失原因。`duration=null` 表示浏览器尚未提供有限时长；不伪造时长。`inspectMedia` 读取所有媒体状态；采集只在媒体时间前进、画面就绪且没有 seek 时进行。截图时点可能比状态读取稍晚，不应当作逐帧精确时间码。读取媒体 URL 不等于已下载完整视频，blob URL 也不能在独立 HTTP 客户端中直接使用。

画面不能代替音轨。读取 textTracks 的活动字幕；网站字幕若由 DOM 渲染，观察实际选择器后另行读取。纯音频/讲解音轨需要真实转写或用户给出的字幕，不能让模型根据少量画面声称听完全文。视觉 Agent 的图片输入、端点和模型名应依据该供应商当前官方文档确认，缺少 API Key 时使用本地 mock 验证连接代码并报告未进行真实 API 联调。

如果题目或正文使用自定义字体，DOM 中可能是错误字符。对比浏览器截图；给视觉 Agent 原样截图，保留 DOM 文本仅作结构/选项标识，不能把乱码当作实际题意。模型建议、UI 填写、提交动作与站点确认是不同阶段；每一步以实际页面或响应判断，身份验证、未知题型、低置信度或缺少内容依据时保留现场。

## 已有扩展浏览器会话

宿主已经提供已登录浏览器时优先复用其标签页和公开的 CDP capability。先阅读当前 capability 文档，不猜测方法签名。此类连接可能只覆盖一个标签页或当前 origin，不能当作 `openSession` 的浏览器级全目标记录器。

若接口提供事件 cursor/sequence，先建立基线，再触发操作；读取后以返回 cursor 继续分页，保留同一过滤条件，直到 `hasMore=false`。一旦返回 `truncated=true`，说明缓冲区丢失过事件，必须报告本次记录不完整。对子 iframe/Worker 的 `Target.attachedToTarget` 读取实际 session/target 标识后再路由命令，不猜 ID。只输出 HTTP/HTTPS 的有限 method、去敏 URL、状态、类型摘要；避免把 data URL、图片 base64 或凭据打印进对话。

## C# / WebView2

可由应用在创建自己的 `CoreWebView2Environment` 前启用本机 CDP，并使用独立 userDataFolder：

```csharp
var options = new CoreWebView2EnvironmentOptions {
    AdditionalBrowserArguments = $"--remote-debugging-address=127.0.0.1 --remote-debugging-port={port}"
};
var environment = await CoreWebView2Environment.CreateAsync(null, profileDirectory, options);
await webView.EnsureCoreWebView2Async(environment);
using var playwright = await Playwright.CreateAsync();
var browser = await playwright.Chromium.ConnectOverCDPAsync($"http://127.0.0.1:{port}");
```

`port` 从当前空闲端口分配，启动有竞争时处理失败，不固定暴露到局域网。不要读取其它个人浏览器 profile 的 Cookie。软件自有 WebView2 登录由用户在可见界面完成；发布包需要包含 Playwright 驱动，安装机器需要 WebView2 Runtime。

Playwright .NET 把 `EvaluateAsync<T>` 直接映射到 C# DTO 时，要验证 JSON 字段名映射，不能因为反序列化不匹配而把默认空列表当作网页无内容。可读取 `JsonElement` 后用明确的 `JsonSerializerOptions` 转换，并用真实浏览器集成测试覆盖。应用的去敏网络诊断日志通常只有 URL/状态，不能称为保存了请求/响应体的完整 HAR。

需要纯原生界面、后台多页面时，`Context.NewPageAsync` / CDP `Target.createTarget` 在 WebView2 中可能创建带地址栏的可见窗口。应由应用的 STA 消息泵在同一环境下创建多个 message-only HWND 的 `CoreWebView2Controller`，通过唯一初始 URL 或实际 targetId 关联已有 Playwright page；记录器只附加现成目标。校验完成状态时使用独立隐藏目录页面，避免刷新正在播放的课程。释放页面时由拥有 controller 的进程关闭它，避免累积后台 controller。

一个浏览器同时连接多个 Playwright 客户端时，未注册 `dialog` 监听的观察客户端会自动 dismiss 弹窗，可能与主客户端竞争并使连接出错。附加模式 helper 对现有 context 安装被动监听，保留弹窗处理权给宿主或显式动作。需要处理弹窗时仍在触发前注册自己的接受/取消逻辑；不能把监听器注册成功当成站点流程成功。单纯拥有 WebView2 环境的辅助进程无需再维持第二个 Playwright 连接。

参考：[Playwright .NET WebView2](https://playwright.dev/dotnet/docs/webview2)、[WebView2 Environment Options](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environmentoptions)、[HTMLMediaElement](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement)。
