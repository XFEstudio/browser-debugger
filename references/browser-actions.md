# 网页操作、文件与浏览器会话

以下示例假设已取得 `debugSession`、真实目标 `page` 和任务工作目录。先检查页面再替换 selector/名称，不把示例按钮名当作网站事实。

## 页面、表单与多标签

```javascript
console.log(debugSession.context.pages().map(p => ({ url: p.url() })));
console.log(await page.locator('body').ariaSnapshot());
await page.screenshot({ path: `${debugSession.outputDir}/before.png`, fullPage: true });
await page.getByLabel('搜索').fill('用户指定的内容');
await page.getByRole('button', { name: '搜索', exact: true }).click();
await page.getByRole('heading', { name: '搜索结果' }).waitFor();

// 下拉框、勾选、键盘、鼠标及拖动使用真实 Playwright 对象。
await page.getByLabel('城市').selectOption({ label: '上海' });
await page.getByLabel('显示详情').check();
await page.keyboard.press('Escape');
await page.getByTestId('source').dragTo(page.getByTestId('target'));

var popupWait = page.waitForEvent('popup');
await page.getByRole('link', { name: '查看详情' }).click();
var popup = await popupWait;
await popup.waitForLoadState('domcontentloaded');

var freshPage = await debugSession.newPage(); // 已等待捕获目标附加完成
await freshPage.goto('https://example.com', { waitUntil: 'domcontentloaded' });
```

iframe 用 `page.frameLocator(selector)`，shadow DOM 用支持穿透的 Locator。截图和 DOM 不一致时先检查 iframe、可见性、遮挡、当前标签和弹窗；不要用盲目坐标点击替代观察。

## 上传实际文件

先确认用户授权的绝对路径确实存在。多文件需要 input 具有 `multiple`；目录上传需要网站的 `webkitdirectory` input。用户没给出上传文件时先查其明确指定的任务目录，仍不确定再问具体文件，不随意挑其它私人文件。

```javascript
// 直接设置真实 file input，隐藏 input 也可以使用；不是填写文本框。
await debugSession.upload({
  page,
  selector: 'input[type="file"]',
  files: ['C:/ABSOLUTE/TASK/input/a.pdf', 'C:/ABSOLUTE/TASK/input/b.png']
});

// 网站通过按钮动态创建 input：先监听 filechooser 再点击。
await debugSession.upload({
  page,
  files: 'C:/ABSOLUTE/TASK/input/a.pdf',
  trigger: () => page.getByRole('button', { name: '选择文件', exact: true }).click()
});

// 选择文件后，有的网站立即上传，有的网站还需要点击提交。
var uploadResponse = page.waitForResponse(r =>
  r.url().includes('/api/upload') && r.request().method() === 'POST'
);
await page.getByRole('button', { name: '开始上传', exact: true }).click();
var response = await uploadResponse;
console.log({ status: response.status(), result: await response.json() });
await page.getByText('上传成功', { exact: true }).waitFor();
```

如果选择后立即触发上传，必须把 `waitForResponse` 放在 `upload` 调用之前。选文件、上传请求、服务端确认、页面成功各是独立证据。文件内容会真的发给网站；任务范围必须包括该网站和这些文件。

需要目录时：

```javascript
await debugSession.upload({ page, selector: 'input[webkitdirectory]', files: 'C:/ABSOLUTE/TASK/input/folder' });
```

网页自定义拖放上传如不使用 file input，需要根据真实实现处理：可用 Playwright `DataTransfer`/`File` 配合 `dispatchEvent('drop')`，前提是确实从用户指定文件读取字节且站点支持；不能仅发送伪造文件名。系统 `showOpenFilePicker`、浏览器内部页面或原生证书选择不保证有 Playwright 对等 API；使用宿主允许的原生 UI 工具或保留现场让用户完成该一步。

## 下载、对话框与权限

```javascript
var downloadWait = page.waitForEvent('download');
await page.getByRole('button', { name: '导出' }).click();
var download = await downloadWait;
var failure = await download.failure();
if (failure) throw new Error(failure);
// 选择本任务目录内的文件名，避免直接信任服务器文件名造成覆盖或越界。
await download.saveAs('C:/ABSOLUTE/TASK/work/export.csv');
```

为目标动作专门注册 dialog handler，依据用户任务决定接受/取消，记录类型和文本；不要全局无条件接受全部确认弹窗。clipboard、geolocation、camera/microphone 等权限只在任务需要且用户授权的站点 origin 上设置；变更后验证效果。登录、支付系统确认或硬件授权缺少能力时不声称自动完成。

## 会话状态和页面诊断

```javascript
console.log(await debugSession.context.cookies(['https://example.com']));
var state = await page.evaluate(() => ({
  url: location.href,
  localStorage: Object.fromEntries(Object.entries(localStorage)),
  sessionStorage: Object.fromEntries(Object.entries(sessionStorage))
}));
var timings = await page.evaluate(() => performance.getEntriesByType('navigation').map(e => e.toJSON()));
```

这些值可能含私密数据，按需要读取并脱敏报告。IndexedDB、Cache Storage、DOM、样式、媒体/视口模拟和性能可以使用 Playwright evaluate、`context.newCDPSession(page)` 或 `debugSession.cdp`；不要把支持“调试接口”解释为可操作所有浏览器原生 UI。

官方依据：[Playwright Actions / 上传和文件选择](https://playwright.dev/docs/input)、[BrowserContext](https://playwright.dev/docs/api/class-browsercontext)、[Page](https://playwright.dev/docs/api/class-page)。
