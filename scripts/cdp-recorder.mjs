import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function resolveEndpoint(endpoint) {
  if (/^wss?:/i.test(endpoint)) {
    if (!new URL(endpoint).pathname.includes('/devtools/browser/')) {
      throw new Error('Provide a browser WebSocket endpoint, not a page endpoint.');
    }
    return { webSocketDebuggerUrl: endpoint };
  }
  const base = new URL(endpoint);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Expected an HTTP or browser WebSocket CDP endpoint.');
  const response = await fetch(new URL('/json/version', base), { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`CDP discovery failed: HTTP ${response.status}`);
  const version = await response.json();
  if (!version.webSocketDebuggerUrl) throw new Error('CDP endpoint did not return webSocketDebuggerUrl.');
  return version;
}

export class CdpConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.connected = true;
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
      } else if (message.method) {
        this.emit('event', message);
        this.emit(message.method, message.params ?? {}, message.sessionId);
      }
    });
    const disconnect = () => {
      if (!this.connected) return;
      this.connected = false;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`CDP disconnected during ${pending.method}`));
      }
      this.pending.clear();
      this.emit('disconnect');
    };
    socket.addEventListener('close', disconnect);
    socket.addEventListener('error', disconnect);
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP WebSocket connection timed out.')); }, 10000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP WebSocket connection failed.')); }, { once: true });
    });
    return new CdpConnection(socket);
  }

  call(method, params = {}, sessionId, timeoutMs = 15000) {
    if (!this.connected) return Promise.reject(new Error('CDP connection is closed.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  close() {
    if (!this.connected) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(resolve, 2000);
      this.socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.close();
    });
  }
}

const autoAttach = {
  autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
  filter: [{ type: 'browser', exclude: true }, { type: 'tab', exclude: true }, {}],
};
// Browser-level attachment owns shared/service workers; descendants own frames and dedicated workers.
// Attaching the same service worker through both paths can keep startup paused in Chromium.
const childAutoAttach = { ...autoAttach, filter: [
  { type: 'browser', exclude: true }, { type: 'tab', exclude: true },
  { type: 'page', exclude: true }, { type: 'service_worker', exclude: true },
  { type: 'shared_worker', exclude: true }, {},
] };
const consoleMethods = new Set(['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded']);
const errorText = error => error instanceof Error ? error.message : String(error);
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

export class NetworkRecorder {
  constructor(protocol, outputDir, options = {}) {
    this.protocol = protocol;
    this.outputDir = outputDir;
    this.maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
    if (!Number.isFinite(this.maxBodyBytes) || this.maxBodyBytes < 0) throw new Error('maxBodyBytes must be a nonnegative finite byte count.');
    this.sessions = new Map();
    this.groups = new Map();
    this.requests = [];
    this.jobs = new Set();
    this.warnings = [];
    this.websocketEvents = 0;
    this.eventSourceMessages = 0;
    this.stopping = false;
    this.stopped = false;
    this.startedAt = new Date().toISOString();
    this.handleEvent = this.handleEvent.bind(this);
  }

  journal(method, params, sessionId) {
    if (!this.events || this.events.writableEnded || this.stopped) return;
    const info = this.sessions.get(sessionId);
    const row = { receivedAt: new Date().toISOString(), sessionId, targetId: info?.targetId, method, params };
    const line = `${JSON.stringify(row)}\n`;
    this.events.write(line);
    if (consoleMethods.has(method)) this.console.write(line);
  }

  warn(kind, error, extra = {}) {
    const warning = { kind, message: errorText(error), ...extra };
    this.warnings.push(warning);
    this.journal('_collector.warning', warning);
  }

  track(promise) {
    let job;
    job = promise.catch(error => this.warn('collector-job', error)).finally(() => this.jobs.delete(job));
    this.jobs.add(job);
    return job;
  }

  async start() {
    await mkdir(path.join(this.outputDir, 'bodies'), { recursive: true });
    this.events = createWriteStream(path.join(this.outputDir, 'events.jsonl'), { flags: 'wx' });
    this.console = createWriteStream(path.join(this.outputDir, 'console.jsonl'), { flags: 'wx' });
    await Promise.all([this.events, this.console].map(stream => new Promise((resolve, reject) => {
      stream.once('open', resolve); stream.once('error', reject);
    })));
    for (const stream of [this.events, this.console]) stream.on('error', error => {
      this.writeError = errorText(error);
    });
    this.protocol.on('event', this.handleEvent);
    this.protocol.on('disconnect', () => {
      if (!this.stopping) this.warn('disconnected', 'Capture connection lost; later traffic was not recorded.');
    });
    this.journal('_collector.started', { maxBodyBytes: this.maxBodyBytes, scope: 'All attachable targets on this browser CDP endpoint.' });
    await this.protocol.call('Target.setDiscoverTargets', { discover: true });
    try { await this.protocol.call('Target.setAutoAttach', autoAttach); }
    catch (error) {
      this.warn('auto-attach-filter-fallback', error);
      const { filter, ...fallback } = autoAttach;
      await this.protocol.call('Target.setAutoAttach', fallback);
    }
    await this.drain();
    return this;
  }

  async configureTarget(sessionId, targetInfo) {
    const info = { ...targetInfo, sessionId, attachedAt: new Date().toISOString(), ready: false };
    const existing = [...this.sessions.values()].find(item => item.targetId === targetInfo.targetId && !item.detachedAt && !item.duplicateOf);
    this.sessions.set(sessionId, info);
    if (existing) {
      info.duplicateOf = existing.sessionId;
      try { await this.protocol.call('Runtime.runIfWaitingForDebugger', {}, sessionId); } catch {}
      try { await this.protocol.call('Target.detachFromTarget', { sessionId }); }
      catch (error) { info.detachError = errorText(error); }
      info.detachedAt = new Date().toISOString();
      return;
    }
    const setup = [];
    let networkReady;
    if (!this.stopping) {
      networkReady = (async () => { try {
        const sizes = { maxTotalBufferSize: Math.max(128 * 1024 * 1024, this.maxBodyBytes * 2), maxResourceBufferSize: Math.max(1024 * 1024, this.maxBodyBytes), maxPostDataSize: 16 * 1024 * 1024 };
        try { await this.protocol.call('Network.enable', { ...sizes, enableDurableMessages: true }, sessionId); }
        catch (error) {
          this.warn('durable-buffer-fallback', error, { targetId: targetInfo.targetId });
          await this.protocol.call('Network.enable', sizes, sessionId);
        }
        info.networkEnabled = true;
        info.networkEnabledAt = new Date().toISOString();
      } catch (error) {
        info.networkEnabled = false;
        this.warn('network-unavailable', error, { targetId: targetInfo.targetId, type: targetInfo.type });
      } })();
      setup.push(networkReady);
      setup.push((async () => { try { await this.protocol.call('Target.setAutoAttach', childAutoAttach, sessionId); }
      catch {
        const { filter, ...fallback } = autoAttach;
        try { await this.protocol.call('Target.setAutoAttach', fallback, sessionId); }
        catch (error) { info.childAutoAttachError = errorText(error); }
      } })());
    }
    // Worker scripts may fetch immediately at startup. Their Network.enable reply is
    // available while paused, so arm it fully before releasing their first instruction.
    if (['worker', 'shared_worker', 'service_worker'].includes(targetInfo.type)) await networkReady;
    // Always release a target, including during shutdown or after an unsupported domain.
    // A new popup can defer Network.enable's reply until its renderer is resumed.
    // Queue Network/child commands before resume, but do not await their replies first.
    try { await this.protocol.call('Runtime.runIfWaitingForDebugger', {}, sessionId); }
    catch (error) { info.resumeError = errorText(error); }
    await Promise.all(setup);
    // Runtime.enable may wait for the first execution context of a paused popup.
    // Arm Network/child attachment first, resume, then enable buffered console reporting.
    if (!this.stopping) for (const method of ['Runtime.enable', 'Log.enable']) {
      try { await this.protocol.call(method, {}, sessionId); }
      catch (error) { info[`${method}Error`] = errorText(error); }
    }
    info.ready = true;
    this.journal('_collector.targetReady', info, sessionId);
  }

  group(sessionId, requestId) {
    const key = `${sessionId}:${requestId}`;
    if (!this.groups.has(key)) this.groups.set(key, { key, aliases: [key], hops: [], requestExtra: [], responseExtra: [], unmatchedHttpEvents: [] });
    return this.groups.get(key);
  }

  resolveMigratedGroup(sessionId, p, group) {
    if (group.hops.length) return group;
    const incoming = this.sessions.get(sessionId);
    if (!incoming) return group;
    const candidates = this.requests.filter(request => {
      if (request.requestId !== p.requestId || request.state !== 'pending') return false;
      const origin = this.sessions.get(request.sessionId);
      if (!origin || origin.browserContextId !== incoming.browserContextId) return false;
      if (p.response?.url && p.response.url !== request.request.url) return false;
      const workerScript = ['worker', 'shared_worker'].includes(incoming.type) && request.type === 'Script' && incoming.url === request.request.url;
      const frameDocument = incoming.type === 'iframe' && request.type === 'Document' && request.frameId === incoming.targetId;
      return workerScript || frameDocument;
    });
    // Cross-process document/worker loads can start in the parent session and finish in
    // the new target. Link only a unique pending request with matching target context
    // and worker URL or frame identity; a requestId alone is insufficient.
    if (candidates.length !== 1) return group;
    const request = candidates[0];
    const original = this.group(request.sessionId, request.requestId);
    original.requestExtra.push(...group.requestExtra);
    original.responseExtra.push(...group.responseExtra);
    original.unmatchedHttpEvents.push(...group.unmatchedHttpEvents);
    const alias = `${sessionId}:${p.requestId}`;
    if (!original.aliases.includes(alias)) original.aliases.push(alias);
    this.groups.set(alias, original);
    request.eventSessionIds = [...new Set([...(request.eventSessionIds ?? [request.sessionId]), sessionId])];
    this.journal('_collector.requestMigrated', { id: request.id, requestId: request.requestId, fromSessionId: request.sessionId, toSessionId: sessionId }, sessionId);
    return original;
  }

  handleEvent(message) {
    const { method, params: p = {}, sessionId } = message;
    if (method === 'Target.attachedToTarget') {
      this.track(this.configureTarget(p.sessionId, p.targetInfo));
    }
    if (method === 'Target.detachedFromTarget') {
      const info = this.sessions.get(p.sessionId);
      if (info) info.detachedAt = new Date().toISOString();
    }
    if (method === 'Target.targetInfoChanged') {
      for (const info of this.sessions.values()) if (info.targetId === p.targetInfo.targetId) Object.assign(info, p.targetInfo);
    }
    if (method.startsWith('Target.') || method.startsWith('Network.') || consoleMethods.has(method) || method === 'Debugger.paused' || method === 'Debugger.resumed') {
      this.journal(method, p, sessionId);
    }
    if (method.startsWith('Network.webSocket')) this.websocketEvents++;
    if (method === 'Network.eventSourceMessageReceived') this.eventSourceMessages++;
    if (!method.startsWith('Network.') || !p.requestId) return;
    let group = this.group(sessionId, p.requestId);
    if (method !== 'Network.requestWillBeSent') group = this.resolveMigratedGroup(sessionId, p, group);
    if (method === 'Network.requestWillBeSentExtraInfo') { group.requestExtra.push(p); return; }
    if (method === 'Network.responseReceivedExtraInfo') { group.responseExtra.push(p); return; }
    if (method === 'Network.requestWillBeSent') {
      const previous = group.hops.at(-1);
      if (previous && p.redirectResponse) {
        previous.response = p.redirectResponse;
        previous.finishedTimestamp = p.timestamp;
        previous.state = 'redirect';
        previous.bodyUnavailable = 'Redirect bodies are not independently retrievable through this requestId.';
      }
      const request = {
        id: this.requests.length + 1, requestId: p.requestId, sessionId,
        targetId: this.sessions.get(sessionId)?.targetId,
        targetType: this.sessions.get(sessionId)?.type, hop: group.hops.length,
        request: p.request, type: p.type, frameId: p.frameId, loaderId: p.loaderId,
        documentURL: p.documentURL, initiator: p.initiator,
        wallTime: p.wallTime, timestamp: p.timestamp, state: 'pending',
      };
      group.hops.push(request);
      this.requests.push(request);
      if (p.request.hasPostData && p.request.postData === undefined) {
        this.track(this.protocol.call('Network.getRequestPostData', { requestId: p.requestId }, sessionId)
          .then(result => { request.request.postData = result.postData; })
          .catch(error => { request.postDataUnavailable = errorText(error); }));
      }
      return;
    }
    const request = group.hops.at(-1);
    if (!request) {
      if (['Network.responseReceived', 'Network.dataReceived', 'Network.loadingFinished', 'Network.loadingFailed'].includes(method)) group.unmatchedHttpEvents.push(method);
      return;
    }
    if (method === 'Network.responseReceived') {
      request.response = p.response;
      delete request.responseFromExtraInfo;
      request.responseTimestamp = p.timestamp;
      request.hasExtraInfo = p.hasExtraInfo;
      request.type = p.type;
    } else if (method === 'Network.requestServedFromCache') request.servedFromCache = true;
    else if (method === 'Network.loadingFinished') {
      request.finishedTimestamp = p.timestamp;
      request.encodedDataLength = p.encodedDataLength;
      request.bodySessionId = sessionId;
      request.state = 'finished';
      this.track(this.captureBody(request));
    } else if (method === 'Network.loadingFailed') {
      request.finishedTimestamp = p.timestamp;
      request.state = 'failed';
      request.failure = p;
      request.bodyUnavailable = p.errorText;
    }
  }

  async captureBody(request) {
    if (this.maxBodyBytes === 0) { request.bodyUnavailable = 'Body recording disabled (maxBodyBytes=0).'; return; }
    if (request.encodedDataLength > this.maxBodyBytes) {
      request.bodyUnavailable = `Encoded response exceeds maxBodyBytes=${this.maxBodyBytes}.`;
      return;
    }
    try {
      const result = await this.protocol.call('Network.getResponseBody', { requestId: request.requestId }, request.bodySessionId ?? request.sessionId);
      const body = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
      if (body.length > this.maxBodyBytes) {
        request.bodyUnavailable = `Decoded response (${body.length} bytes) exceeds maxBodyBytes=${this.maxBodyBytes}.`;
        return;
      }
      const file = `bodies/${String(request.id).padStart(6, '0')}.body`;
      await writeFile(path.join(this.outputDir, file), body);
      request.body = { file, bytes: body.length, base64Encoded: Boolean(result.base64Encoded) };
      this.journal('_collector.bodySaved', { id: request.id, requestId: request.requestId, ...request.body }, request.sessionId);
    } catch (error) {
      request.bodyUnavailable = errorText(error);
      this.journal('_collector.bodyUnavailable', { id: request.id, requestId: request.requestId, reason: request.bodyUnavailable }, request.sessionId);
    }
  }

  async drain() {
    // Jobs can enqueue child-target jobs while a parent is being configured.
    while (this.jobs.size) await Promise.all([...this.jobs]);
  }

  async readyTarget(targetId, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = [...this.sessions.values()].find(info => info.targetId === targetId && !info.detachedAt && info.ready);
      if (info) return info.sessionId;
      if (!this.protocol.connected) throw new Error('CDP disconnected while waiting for target.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Target ${targetId} was not auto-attached within ${timeoutMs} ms.`);
  }

  materialize() {
    for (const group of new Set(this.groups.values())) {
      for (const [index, hop] of group.hops.entries()) {
        // ExtraInfo can arrive before/after the base event, and may be absent on some hops.
        // Preserve ambiguous groups rather than silently assigning another redirect's cookies.
        delete hop.requestExtraInfo;
        delete hop.responseExtraInfo;
        delete hop.extraInfoAmbiguous;
        if (group.requestExtra.length === group.hops.length) hop.requestExtraInfo = group.requestExtra[index];
        if (group.responseExtra.length === group.hops.length) hop.responseExtraInfo = group.responseExtra[index];
        if (!hop.response && hop.responseExtraInfo && hop.state === 'finished') {
          const extra = hop.responseExtraInfo;
          const contentType = Object.entries(extra.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
          hop.response = { url: hop.request.url, status: extra.statusCode, headers: extra.headers, mimeType: contentType?.split(';')[0] ?? '' };
          hop.responseFromExtraInfo = true;
        }
        if ((group.requestExtra.length && group.requestExtra.length !== group.hops.length) ||
            (group.responseExtra.length && group.responseExtra.length !== group.hops.length)) {
          hop.extraInfoAmbiguous = true;
        }
      }
    }
    return this.requests;
  }

  async flush() {
    await this.drain();
    if (this.writeError) throw new Error(`Capture output failed: ${this.writeError}`);
    const requests = this.materialize();
    const api = new Map();
    for (const request of requests) {
      if (!['Fetch', 'XHR'].includes(request.type)) continue;
      let url;
      try { url = new URL(request.request.url); } catch { continue; }
      const key = `${request.request.method} ${url.origin}${url.pathname}`;
      if (!api.has(key)) api.set(key, { method: request.request.method, endpoint: `${url.origin}${url.pathname}`, count: 0, statuses: [], requestIds: [] });
      const item = api.get(key);
      item.count++;
      item.requestIds.push(request.id);
      if (request.response && !item.statuses.includes(request.response.status)) item.statuses.push(request.response.status);
    }
    const summary = {
      startedAt: this.startedAt, stoppedAt: this.stoppedAt ?? null,
      requestCount: requests.length,
      states: Object.fromEntries(['pending', 'finished', 'redirect', 'failed'].map(state => [state, requests.filter(r => r.state === state).length])),
      bodiesSaved: requests.filter(r => r.body).length,
      bodiesUnavailable: requests.filter(r => r.bodyUnavailable).map(r => ({ id: r.id, url: r.request.url, reason: r.bodyUnavailable })),
      maxBodyBytes: this.maxBodyBytes,
      websocketEvents: this.websocketEvents, eventSourceMessages: this.eventSourceMessages,
      targets: [...this.sessions.values()], warnings: this.warnings,
      unmatchedHttpEvents: [...new Set(this.groups.values())].filter(g => !g.hops.length && g.unmatchedHttpEvents.length).map(g => ({ key: g.key, methods: [...new Set(g.unmatchedHttpEvents)] })),
      scope: 'Events from attachable CDP targets on the connected browser, after target Network.enable completed. Browser-process/internal/previous traffic is not guaranteed.',
      sensitiveData: 'Raw local capture may contain credentials and private content. Redact before sharing.',
    };
    const extras = [...new Set(this.groups.values())].filter(g => g.requestExtra.length || g.responseExtra.length)
      .map(g => ({ key: g.key, aliases: g.aliases, requestExtraInfo: g.requestExtra, responseExtraInfo: g.responseExtra }));
    await Promise.all([
      writeJson(path.join(this.outputDir, 'requests.json'), requests),
      writeJson(path.join(this.outputDir, 'extra-info.json'), extras),
      writeJson(path.join(this.outputDir, 'api-index.json'), [...api.values()]),
      writeJson(path.join(this.outputDir, 'capture-summary.json'), summary),
    ]);
    await this.exportHar(requests);
    return summary;
  }

  async exportHar(requests) {
    const headers = object => Object.entries(object ?? {}).flatMap(([name, value]) => String(value).split('\n').map(value => ({ name, value })));
    const entries = [];
    for (const r of requests) {
      const req = r.request;
      const res = r.response ?? {};
      const reqHeaders = { ...req.headers, ...r.requestExtraInfo?.headers };
      const resHeaders = { ...res.headers, ...r.responseExtraInfo?.headers };
      let queryString = [];
      try { queryString = [...new URL(req.url).searchParams].map(([name, value]) => ({ name, value })); } catch {}
      const content = { size: r.body?.bytes ?? -1, mimeType: res.mimeType ?? '' };
      if (r.body) {
        const bytes = await readFile(path.join(this.outputDir, r.body.file));
        content.text = bytes.toString(r.body.base64Encoded ? 'base64' : 'utf8');
        if (r.body.base64Encoded) content.encoding = 'base64';
      }
      const total = Math.max(0, ((r.finishedTimestamp ?? r.responseTimestamp ?? r.timestamp) - r.timestamp) * 1000);
      const wait = Math.min(total, Math.max(0, ((r.responseTimestamp ?? r.finishedTimestamp ?? r.timestamp) - r.timestamp) * 1000));
      entries.push({
        startedDateTime: new Date((r.wallTime ?? Date.now() / 1000) * 1000).toISOString(), time: total,
        request: { method: req.method, url: req.url, httpVersion: res.protocol ?? '', headers: headers(reqHeaders), queryString, cookies: [], headersSize: -1, bodySize: req.postData === undefined ? -1 : Buffer.byteLength(req.postData),
          ...(req.postData !== undefined ? { postData: { mimeType: Object.entries(reqHeaders).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '', text: req.postData } } : {}) },
        response: { status: res.status ?? 0, statusText: res.statusText ?? '', httpVersion: res.protocol ?? '', headers: headers(resHeaders), cookies: [], content, redirectURL: Object.entries(resHeaders).find(([key]) => key.toLowerCase() === 'location')?.[1] ?? '', headersSize: -1, bodySize: r.encodedDataLength ?? -1 },
        cache: {}, timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait, receive: Math.max(0, total - wait) },
        _requestId: r.requestId, _sessionId: r.sessionId, _targetId: r.targetId, _state: r.state,
        ...(r.bodyUnavailable ? { _bodyUnavailable: r.bodyUnavailable } : {}),
        ...(r.failure ? { _failure: r.failure } : {}),
      });
    }
    await writeJson(path.join(this.outputDir, 'network.cdp.har'), { log: { version: '1.2', creator: { name: 'browser-debugger CDP recorder', version: '1.0.0' }, entries, comment: 'All captured CDP HTTP hops; WS/SSE frames and exact protocol timing remain in events.jsonl. Timings here are derived; unknown values use -1.' } });
  }

  async stop() {
    if (this.stopped) return this.lastSummary;
    this.stopping = true;
    if (this.protocol.connected) {
      // Release paused children before detaching this independent recorder connection.
      await Promise.all([...this.sessions.entries()].filter(([, info]) => !info.detachedAt).map(async ([sessionId]) => {
        try { await this.protocol.call('Runtime.runIfWaitingForDebugger', {}, sessionId, 2000); } catch {}
      }));
    }
    await this.drain();
    await this.protocol.close();
    this.protocol.off('event', this.handleEvent);
    await this.drain();
    this.stoppedAt = new Date().toISOString();
    this.lastSummary = await this.flush();
    this.journal('_collector.stopped', { requestCount: this.requests.length });
    await Promise.all([this.events, this.console].map(stream => new Promise((resolve, reject) => {
      if (stream.destroyed) return this.writeError ? reject(new Error(this.writeError)) : resolve();
      stream.once('error', reject);
      stream.end(resolve);
    })));
    this.stopped = true;
    return this.lastSummary;
  }
}
