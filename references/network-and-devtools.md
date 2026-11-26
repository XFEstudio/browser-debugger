# 网络、API 与 DevTools 调试

## 从操作前开始记录

`openSession` 返回时已有标签页的捕获器已经附加；`newPage` 同样等待附加完成。先启动，再导航/点击/上传，避免最早的 document、XHR、预检和子资源请求遗漏。默认不关闭缓存、不绕过 Service Worker，也不安装 request route，保留站点原有行为。

捕获器在浏览器根 WebSocket 上设置自动附加，再对子目标递归启用 Network。新目标会短暂等待调试，配置好记录后恢复。连接已有浏览器时，目标最初的请求可能已经发生，不能回补。

多个调试客户端（包括 Playwright 与独立记录器）并存时，SharedWorker 的启动可能被另一客户端提前恢复。即使 attached 事件带有 waitingForDebugger，也不能保证所有启动流量发生在本记录器 Network.enable 之后；共享 Worker 脚本的完成事件和首次 fetch 可能缺失。只恢复本记录器收到 waitingForDebugger 的目标，并优先完成 Worker 的 Network 启用，可减少竞争，但不能消除浏览器端所有竞争。集成测试把立即发起的启动探针如实记入 startupCoverage，并对 Network 就绪后发起的真实 SharedWorker 请求做强制断言，不把未观察到的启动请求补造进 HAR。相关机制见 [DevTools 多会话恢复说明](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/core/sdk/ChildTargetManager.ts) 与 [Target 协议](https://chromedevtools.github.io/devtools-protocol/tot/Target/)。

`debugSession.flush()` 生成当前快照，`close()` 停止记录并刷盘。`events.jsonl` 按到达顺序保留原始事件；`requests.json` 按 `(sessionId, requestId, hop)` 区分目标和重定向，不能只用 `requestId` 跨会话合并。

Worker 脚本和跨进程 iframe 文档可能在父 session 发起、子 session 完成。helper 只在请求 ID、browser context、Worker 脚本 URL/iframe 标识匹配且仅有一个候选时关联，记录 `eventSessionIds` 和 `_collector.requestMigrated`；取 body 使用实际完成该请求的 session。无法可靠关联的事件保留在 JSONL，并在汇总的 `unmatchedHttpEvents` 中报告。

## 查找接口

```javascript
await debugSession.flush();
var fs = await import('node:fs/promises');
var requests = JSON.parse(await fs.readFile(`${debugSession.outputDir}/requests.json`, 'utf8'));
var matches = requests.filter(r => ['Fetch', 'XHR'].includes(r.type) && r.request.url.includes('/api/'));
console.log(matches.map(r => ({ id: r.id, method: r.request.method, url: r.request.url, status: r.response?.status, state: r.state })));
var chosen = matches.find(r => r.body);
if (chosen) {
  var bytes = await fs.readFile(`${debugSession.outputDir}/${chosen.body.file}`);
  // 根据 MIME 和实际字节解码；不要把所有二进制都当 UTF-8。
}
```

接口索引只列观察到的 Fetch/XHR。导航接口、GraphQL、WS、SSE、预检、下载或 Worker 还要结合 `requests.json` 和 `events.jsonl`。不要把某个路径返回 HTTP 200 直接等同业务成功；结合响应业务字段、操作前后状态和页面结果。

需要说明接口时提供：触发动作、method/URL、query、请求编码与参数、鉴权方式的类型、状态码、响应形状及关键业务字段。区分观察到的事实和推断，必要时给出可复现步骤。接口来自当前实际捕获，不能从页面名称猜 URL。

## HTTP、ExtraInfo 与响应体

`Network.requestWillBeSent`、`responseReceived` 提供基本元数据；ExtraInfo 可能先到、后到或某跳缺失。helper 仅在各跳数量一致时把 ExtraInfo 分配到相应请求，否则置 `extraInfoAmbiguous`，并在 `extra-info.json` 和原始事件中保留全部数据。需要精确分析时检查 `redirectHasExtraInfo`、`hasExtraInfo`、状态码、时间和原始序列，不猜 Cookie/响应头属于哪一跳。

某些迁移的脚本只有 ExtraInfo 而没有基础 response 事件。已完成请求可从 ExtraInfo 取实际观察到的状态码/响应头，并用 `responseFromExtraInfo` 标记，未知的时序/协议等字段不编造。

响应完成后通过 `Network.getResponseBody` 取正文，二进制解码为原始字节保存在 `bodies/`。默认每个 body 上限 32 MiB，默认请求体协议缓冲上限 16 MiB。超限、缓冲区淘汰、重定向、下载、已关闭目标和未完成的流可能没有 body；原因保存在请求和汇总中。multipart 的文件字节不保证出现在 CDP 请求体中，即使服务端确实收到了文件。需要核对文件时对用户指定的本地文件做大小/hash，再结合上传响应确认，不能声称 HAR 必然含完整文件字节。

`network.cdp.har` 覆盖捕获的各目标 HTTP 请求；unknown timing=-1，cookies 数组不另行解析，原始 Cookie/Set-Cookie 头在可得时保留在 headers 中。`network.playwright.har` 是自行启动 context 的原生 HAR，必须等关闭 context 才完整生成；不能用其条数替代全目标捕获完整性。WS 帧、SSE 消息、协议特有字段和精确时序使用 JSONL，而非仅依赖 HAR。

## WebSocket 和 SSE

原始事件包括 `webSocketCreated`、握手、`webSocketFrameSent/Received`、关闭和错误；SSE 使用 `eventSourceMessageReceived`。帧的 opcode 决定文本/二进制含义，不把所有 `payloadData` 当 JSON；opcode=1 是文本，其它编码依 CDP 和协议定义判断。普通 fetch ReadableStream 不是 EventSource，不保证产生 SSE 事件；记录响应头、dataReceived 和已完成响应正文，必要时对该应用流增加有范围的观察，不宣称已记录每个应用层 chunk。

## 过滤、拦截和模拟

“只看接口”用导出的数据过滤，默认不让采集器丢弃静态资源或错误请求。要主动拦截、修改、Mock 或重放时，确认用户任务包括这些行为，再在请求发起前设置：

```javascript
await debugSession.context.route('**/api/example', async route => {
  const request = route.request();
  await route.continue({ headers: { ...request.headers(), 'x-debug-request': '1' } });
});
// 请求操作完成后清理自己添加的 route，别移除其它工具的路由。
```

route 可能改变缓存行为，并且不能覆盖被 Service Worker 接管的所有请求。需要对 SW 影响做对照时明确说明，并为对照实验新建合适 context，不默认禁用 SW 或静默改变原站点行为。CDP `Fetch.enable` 可做更底层的请求/响应拦截，但每个暂停请求都必须 continue/fulfill/fail，并在结束时清理，以免把页面挂住。

单纯捕获任务不主动重放上传/支付/删除等有副作用请求。用户授权复现时，使用该任务会话、正确的 Origin/CSRF 等条件，不移用其它账号凭据。分享的命令用占位符/环境变量：

```powershell
# 环境变量由用户在本地设置；请求体是本任务生成的文件。
curl.exe --request POST 'https://example.com/api/example' --header "Authorization: Bearer $env:API_TOKEN" --header 'Content-Type: application/json' --data-binary '@C:\ABSOLUTE\TASK\work\payload.json'
```

## 底层调试

可发送当前浏览器 schema 中的全部 CDP 方法，方法是否存在取决于浏览器版本、目标类型和实际权限；不要声称一个固定脚本能覆盖未来所有方法或原生 DevTools 的全部 UI。

```javascript
var targets = debugSession.targets();
console.log(targets.map(t => ({ type: t.type, targetId: t.targetId, sessionId: t.sessionId, url: t.url, networkEnabled: t.networkEnabled })));

var dom = await debugSession.cdp('DOM.getDocument', { depth: 1 });
var result = await debugSession.cdp('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
await debugSession.cdp('Performance.enable');
var metrics = await debugSession.cdp('Performance.getMetrics');
await debugSession.cdp('Performance.disable');

// Worker 的 Runtime、Debugger 等要指定该目标的 sessionId。
var worker = targets.find(t => t.type === 'worker' && !t.detachedAt);
if (worker) {
  var result = await debugSession.cdp('Runtime.evaluate', { expression: 'self.location.href', returnByValue: true }, { sessionId: worker.sessionId });
}
```

DOM/CSS 检查、Debugger 断点、Runtime 表达式、Storage、Performance、Profiler、HeapProfiler、Tracing、Emulation、Fetch 等按需启用，不默认启用侵入性调试。断点触发前先监听事件；记录 pause 后用 `Debugger.resume` 恢复。监听接口：

```javascript
var paused = params => console.log({ reason: params.reason, callFrames: params.callFrames?.length });
debugSession.protocol.on('Debugger.paused', paused);
await debugSession.cdp('Debugger.enable');
// 根据已发现的真实脚本 URL/行号设置断点并触发操作。
// 调试结束时：
await debugSession.cdp('Debugger.resume').catch(() => {});
await debugSession.cdp('Debugger.disable');
debugSession.protocol.off('Debugger.paused', paused);
```

长任务用原始 event 回调收集证据，再分段分析；不要把完整 Cookie、巨量协议 schema、长响应或 WS payload 全部灌进聊天。

官方依据：[Playwright Network](https://playwright.dev/docs/network)、[CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/)、[CDP Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/)。helper 同时保存本机实际协议用于版本差异核对。
