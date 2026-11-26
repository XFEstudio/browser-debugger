import { access, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CdpConnection, NetworkRecorder, resolveEndpoint } from './cdp-recorder.mjs';
import { BrowserControlError, profileDirectory, selectPage, stateDirectory, inspectPage, ensurePageReady } from './session-controls.mjs';
import { browserCatalog, discoverBrowsers, normalizeBrowser, resolveBrowser } from './browser-registry.mjs';

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export async function doctor(options = {}) {
  let playwright;
  try { playwright = await import('playwright-core'); } catch {}
  const browserName = normalizeBrowser(options.browser);
  const discovery = { managedExecutablePath: playwright?.chromium.executablePath() };
  let browsers = [], selection, selectionError;
  try {
    browsers = await discoverBrowsers(discovery);
    selection = await resolveBrowser({ ...discovery, ...options, browser: browserName, installed: browsers });
  } catch (error) { selectionError = { code: error.code ?? 'BROWSER_DISCOVERY_FAILED', message: error.message }; }
  const runtimeReady = Number(process.versions.node.split('.')[0]) >= 22 && Boolean(playwright) && typeof WebSocket === 'function';
  return {
    node: process.version, nativeWebSocket: typeof WebSocket === 'function',
    platform: process.platform, playwrightCoreInstalled: Boolean(playwright), browsers,
    supported: browserCatalog(), selected: selection ?? null, selectionError: selectionError ?? null,
    stateDir: stateDirectory(), runtimeReady, browserAvailable: Boolean(selection),
    capabilities: ['multi-browser discovery', 'named persistent profiles', 'targeted tab selection', 'stdin JSONL session', 'passive readiness checks'],
    ready: runtimeReady && Boolean(selection),
    note: 'ready checks runtime dependencies and a launch executable; it does not prove that a browser launched. CDP attachment only requires runtimeReady and an authorized endpoint, not a locally installed browser.',
  };
}

export async function openSession(options = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22 || typeof WebSocket !== 'function') {
    throw new Error('Node.js 22+ with native WebSocket is required.');
  }
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { throw new Error('Missing playwright-core. Run npm ci --ignore-scripts in the skill directory (npm.cmd on Windows).'); }
  const browserName = normalizeBrowser(options.browser);
  if (options.endpoint && (options.profileName !== undefined || options.profileDir !== undefined)) throw new BrowserControlError('INVALID_OPTIONS', 'An attached endpoint already owns its profile; do not combine endpoint with profileDir or profileName.');
  if (options.endpoint && options.executablePath !== undefined) throw new BrowserControlError('INVALID_OPTIONS', 'An attached endpoint already owns its browser; do not combine endpoint with executablePath.');
  const workDir = path.resolve(options.workDir ?? path.join(process.cwd(), 'work', 'browser-debug'));
  const outputDir = path.resolve(options.outputDir ?? path.join(workDir, 'captures', `${timestamp()}-${randomUUID().slice(0, 8)}`));
  // Refuse an accidental overwrite of a previous capture.
  try { await access(path.join(outputDir, 'events.jsonl')); throw new Error(`Capture already exists: ${outputDir}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(outputDir, { recursive: true });
  let browser, context, protocol, recorder, endpoint, version;
  const passiveDialogContexts = [];
  const passiveDialog = () => {}; // An observing CDP client must not dismiss another client's dialogs.
  const owned = !options.endpoint;
  let profileDir, browserSelection;
  try {
    if (owned) {
      browserSelection = await resolveBrowser({ browser: browserName, executablePath: options.executablePath, managedExecutablePath: chromium.executablePath() });
      profileDir = profileDirectory({ ...options, browser: browserSelection.profileKey, workDir });
      await mkdir(profileDir, { recursive: true });
      const headless = options.headless ?? Boolean(options.unattended);
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath: browserSelection.executablePath,
        headless, acceptDownloads: true,
        serviceWorkers: 'allow', viewport: headless ? { width: 1440, height: 900 } : null,
        recordHar: { path: path.join(outputDir, 'network.playwright.har'), mode: 'full', content: 'embed' },
        args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
      });
      browser = context.browser();
      const activePort = (await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
      const port = Number(activePort[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Browser did not create a valid DevToolsActivePort file.');
      endpoint = `http://127.0.0.1:${port}`;
    } else {
      browserSelection = { requested: browserName, id: 'attached', source: 'cdp' };
      endpoint = options.endpoint;
      browser = await chromium.connectOverCDP(endpoint);
      const contexts = browser.contexts();
      for (const candidate of contexts) { candidate.on('dialog', passiveDialog); passiveDialogContexts.push(candidate); }
      const index = options.contextIndex ?? 0;
      context = contexts[index];
      if (!context) throw new Error(`No existing browser context at index ${index}. Available: ${contexts.length}`);
    }
    context.setDefaultTimeout(options.timeoutMs ?? 15000);
    context.setDefaultNavigationTimeout(options.navigationTimeoutMs ?? 30000);
    version = await resolveEndpoint(endpoint);
    protocol = await CdpConnection.connect(version.webSocketDebuggerUrl);
    recorder = new NetworkRecorder(protocol, outputDir, { maxBodyBytes: options.maxBodyBytes });
    await recorder.start();
    const existingPages = context.pages();
    let page;
    if (options.targetUrl) page = selectPage(existingPages, options.targetUrl);
    else if (options.initialUrl && !owned) {
      const matching = existingPages.filter(page => page.url() === new URL(options.initialUrl).href);
      if (matching.length) page = selectPage(matching, options.initialUrl);
      else {
        try { page = await context.newPage(); }
        catch { throw new BrowserControlError('TAB_CREATION_UNAVAILABLE', 'This browser cannot create a tab. Use a matching existing targetUrl through the authorized host session.'); }
      }
    } else if (!owned) page = selectPage(existingPages);
    else page = existingPages.find(page => page.url() === 'about:blank') ?? await context.newPage();
    const session = new BrowserDebugSession({ browser, context, page, protocol, recorder, outputDir, workDir, endpoint, owned, profileDir, browserSelection, version, passiveDialogContexts, passiveDialog, unattended: Boolean(options.unattended) });
    await session.pageSessionId(page);
    await writeFile(path.join(outputDir, 'session.json'), `${JSON.stringify({ endpoint, owned, profileDir, profileName: options.profileName, unattended: session.unattended, outputDir, browser: version, browserSelection, captureStartedAt: recorder.startedAt }, null, 2)}\n`, 'utf8');
    if (/^https?:/i.test(endpoint)) {
      try {
        const response = await fetch(new URL('/json/protocol', endpoint), { signal: AbortSignal.timeout(10000) });
        if (response.ok) await writeFile(path.join(outputDir, 'protocol.json'), await response.text(), 'utf8');
        else recorder.warn('protocol-schema-unavailable', `HTTP ${response.status}`);
      } catch (error) { recorder.warn('protocol-schema-unavailable', error); }
    }
    return session;
  } catch (error) {
    if (recorder?.events) { try { await recorder.stop(); } catch {} }
    else if (protocol) { try { await protocol.close(); } catch {} }
    if (owned && context) { try { await context.close(); } catch {} }
    else if (browser) { try { await browser.close(); } catch {} }
    throw error;
  }
}

export class BrowserDebugSession {
  constructor(values) { Object.assign(this, values); this.pageIds = new WeakMap(); }

  async pageSessionId(page = this.page) {
    let targetId = this.pageIds.get(page);
    if (!targetId) {
      const probe = await page.context().newCDPSession(page);
      try { ({ targetInfo: { targetId } } = await probe.send('Target.getTargetInfo')); }
      finally { await probe.detach(); }
      this.pageIds.set(page, targetId);
    }
    return this.recorder.readyTarget(targetId);
  }

  targets() { return [...this.recorder.sessions.values()].map(info => ({ ...info })); }

  inspect(options) { return inspectPage(this.page, options); }

  ensureReady(options) { return ensurePageReady(this.page, options); }

  async navigate(url, readiness = {}) {
    const destination = new URL(url);
    if (!['http:', 'https:'].includes(destination.protocol)) throw new BrowserControlError('INVALID_URL', 'navigate requires an HTTP(S) URL.');
    if (this.page.url() !== destination.href) await this.page.goto(destination.href, { waitUntil: 'domcontentloaded' });
    return this.unattended ? this.ensureReady(readiness) : this.inspect(readiness);
  }

  async selectPage(targetUrl) {
    const selected = selectPage(this.context.pages(), targetUrl);
    await this.pageSessionId(selected);
    this.page = selected;
    return selected;
  }

  async screenshot({ path: file = path.join(this.outputDir, `page-${timestamp()}-${randomUUID().slice(0, 8)}.png`), fullPage = false } = {}) {
    const size = await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (!size.width || !size.height) throw new BrowserControlError('SCREENSHOT_UNAVAILABLE', 'The page has a zero-size viewport. Visual state is unconfirmed; do not activate a window to compensate.', size);
    if (!path.isAbsolute(file)) throw new BrowserControlError('INVALID_PATH', 'Screenshot output requires an absolute path.');
    await mkdir(path.dirname(file), { recursive: true });
    await this.page.screenshot({ path: file, fullPage });
    return { path: file, ...size, visualVerified: false };
  }

  async newPage() {
    const page = await this.context.newPage();
    await this.pageSessionId(page);
    return page;
  }

  async cdp(method, params = {}, options = {}) {
    const root = options.root ?? /^(Browser|Target|SystemInfo)\./.test(method);
    const sessionId = options.sessionId ?? (root ? undefined : await this.pageSessionId(options.page ?? this.page));
    return this.protocol.call(method, params, sessionId, options.timeoutMs ?? 15000);
  }

  async upload({ files, selector = 'input[type="file"]', page = this.page, trigger, timeoutMs = 15000 }) {
    const paths = (Array.isArray(files) ? files : [files]).map(file => {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Upload requires actual absolute local file/directory paths.');
      return path.resolve(file);
    });
    for (const file of paths) await stat(file);
    if (trigger) {
      const chooserPromise = page.waitForEvent('filechooser', { timeout: timeoutMs });
      const [chooser] = await Promise.all([chooserPromise, trigger()]);
      await chooser.setFiles(paths, { timeout: timeoutMs });
    } else {
      await page.locator(selector).setInputFiles(paths, { timeout: timeoutMs });
    }
    // A selected file is not proof that the website finished its upload.
    return { files: paths, selected: true, uploadConfirmed: false };
  }

  flush() { return this.recorder.flush(); }

  async close() {
    if (this.closed) return this.finalSummary;
    let summary, captureError;
    try { summary = await this.recorder.stop(); }
    catch (error) { captureError = error; }
    finally {
      if (this.protocol.connected) await this.protocol.close();
      if (this.owned) {
        // Release page-bound HAR content waits before Playwright exports its HAR.
        // Only this helper's dedicated browser is closed; attached pages stay untouched.
        await Promise.allSettled(this.context.pages().map(page => page.close({ runBeforeUnload: false })));
        await this.context.close();
      }
      else await this.browser.close(); // connectOverCDP: disconnect; do not send Browser.close.
      for (const candidate of this.passiveDialogContexts) candidate.off('dialog', this.passiveDialog);
      this.closed = true;
    }
    this.finalSummary = summary;
    if (captureError) throw captureError;
    return summary;
  }
}
