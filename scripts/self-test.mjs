import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openSession } from './browser-session.mjs';
import { inspectMedia, captureMediaEvidence } from './media-evidence.mjs';

// Entirely local integration fixture. No external website, account, or upload service.
const root = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'work', `self-test-${Date.now()}`));
const browserOptions = { browser: process.env.BROWSER_DEBUGGER_TEST_BROWSER ?? 'auto', executablePath: process.env.BROWSER_DEBUGGER_TEST_EXECUTABLE };
await mkdir(root, { recursive: true });
const fileA = path.join(root, '测试文件.txt');
const fileB = path.join(root, 'second.txt');
const directory = path.join(root, 'upload-directory');
await mkdir(directory, { recursive: true });
await Promise.all([
  writeFile(fileA, 'local upload fixture 中文'), writeFile(fileB, 'second fixture'),
  writeFile(path.join(directory, 'nested.txt'), 'directory fixture'),
]);

let uploadReceived = false;
const sockets = new Set();
const fixture = `<!doctype html><meta charset="utf-8"><title>Browser debugger integration fixture</title>
<h1>Local browser test</h1>
<input id="direct" type="file" multiple><input id="chooser" type="file" hidden multiple>
<button id="choose" onclick="document.querySelector('#chooser').click()">Choose files</button>
<input id="directory" type="file" webkitdirectory>
<button id="submit" onclick="upload()">Upload chosen files</button>
<a id="download" href="/download">Download</a><a id="popup" href="/popup" target="_blank">Popup</a>
<script>
window.uploadResult=null;
async function upload(){const data=new FormData();for(const file of document.querySelector('#chooser').files)data.append('files',file);window.uploadResult=await(await fetch('/api/upload',{method:'POST',body:data})).json()}
window.fixtureDone=false;
(async()=>{
  console.log('fixture-console-marker');
  await fetch('/api/example?sample=yes',{method:'POST',headers:{'Content-Type':'application/json','X-Probe':'request-extra-info'},body:JSON.stringify({message:'request payload 中文'})});
  await fetch('/redirect');
  await fetch('/large');
  await fetch('/failure').catch(()=>{});
  await new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('GET','/api/xhr');xhr.onload=resolve;xhr.send()});
  await new Promise(resolve=>{const worker=new Worker('/worker.js');worker.onmessage=()=>{worker.terminate();resolve()}});
  await new Promise(resolve=>{const worker=new SharedWorker('/shared-worker.js');worker.port.onmessage=()=>{worker.port.close();resolve()};worker.port.start()});
  window.fixtureStep='register-service-worker';
  const registration=await navigator.serviceWorker.register('/sw.js');
  window.fixtureStep='service-worker-ready';await navigator.serviceWorker.ready;
  window.fixtureStep='service-worker-controller';
  if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
  await fetch('/sw-proxy');window.fixtureStep='websocket';
  await new Promise(resolve=>{const ws=new WebSocket('ws://'+location.host+'/ws');ws.onopen=()=>ws.send('ws-client-marker');ws.onmessage=()=>{ws.close();resolve()}});
  window.fixtureStep='sse';
  await new Promise(resolve=>{const source=new EventSource('/sse');source.onmessage=()=>{source.close();resolve()}});
  window.fixtureStep='iframe';
  const frame=document.createElement('iframe');frame.src=location.origin.replace('127.0.0.1','localhost')+'/frame';
  await new Promise(resolve=>{frame.onload=resolve;document.body.append(frame)});
  window.fixtureDone=true;
})().catch(error=>{window.fixtureError=String(error)});
</script>`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://local.test');
    const json = value => { response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Response-Probe': 'response-extra-info' }); response.end(JSON.stringify(value)); };
    if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(fixture); }
    else if (url.pathname === '/worker.js') { response.setHeader('Content-Type', 'text/javascript'); response.end("fetch('/api/from-worker').then(r=>r.json()).then(data=>postMessage(data));"); }
    else if (url.pathname === '/shared-worker.js') { response.setHeader('Content-Type', 'text/javascript'); response.end("onconnect=event=>fetch('/api/from-shared-worker').then(r=>r.json()).then(data=>event.ports[0].postMessage(data));"); }
    else if (url.pathname === '/sw.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end("self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/sw-proxy')e.respondWith(fetch('/api/from-service-worker'))});");
    } else if (url.pathname === '/frame' || url.pathname === '/popup') {
      const source = url.pathname === '/frame' ? 'frame' : 'popup';
      response.setHeader('Content-Type', 'text/html');
      response.end(`<title>${source}</title><script>fetch('/api/from-${source}').then(()=>window.done=true)</script>`);
    } else if (url.pathname === '/redirect') { response.writeHead(302, { Location: '/api/redirect-target' }); response.end(); }
    else if (url.pathname === '/large') { response.setHeader('Content-Type', 'text/plain'); response.end('L'.repeat(256 * 1024)); }
    else if (url.pathname === '/failure') request.socket.destroy();
    else if (url.pathname === '/download') { response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="fixture.txt"' }); response.end('download-marker'); }
    else if (url.pathname === '/sse') { response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); response.end('id: 1\ndata: sse-marker\n\n'); }
    else if (url.pathname === '/api/upload') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      uploadReceived = body.includes('local upload fixture') && body.includes('second fixture');
      json({ ok: uploadReceived, bytes: Buffer.byteLength(body) });
    } else if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      json({ ok: true, path: url.pathname, body: Buffer.concat(chunks).toString('utf8'), message: 'response payload 中文' });
    } else { response.writeHead(404); response.end('not found'); }
  } catch (error) { response.destroy(error); }
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
server.on('upgrade', (request, socket) => {
  const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('error', () => {});
  socket.once('data', () => {
    const message = Buffer.from('ws-server-marker');
    socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
  });
});
await new Promise(resolve => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let session, attached;
let summary;
try {
  session = await openSession({ ...browserOptions, headless: true, workDir: root, outputDir: path.join(root, 'capture'), maxBodyBytes: 128 * 1024 });
  console.log(`Launched local ${session.browserSelection.id} fixture; output: ${session.outputDir}`);
  const page = session.page;
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  try { await page.waitForFunction(() => window.fixtureDone || window.fixtureError, null, { timeout: 30000 }); }
  catch (error) {
    console.error('Fixture state:', await page.evaluate(() => ({ step: window.fixtureStep, error: window.fixtureError })));
    throw error;
  }
  assert.equal(await page.evaluate(() => window.fixtureError), undefined);
  assert.equal(await page.title(), 'Browser debugger integration fixture');
  await session.upload({ files: [fileA, fileB], selector: '#direct' });
  assert.equal(await page.locator('#direct').evaluate(input => input.files.length), 2);
  await session.upload({ files: [fileA, fileB], trigger: () => page.locator('#choose').click() });
  assert.equal(await page.locator('#chooser').evaluate(input => input.files.length), 2);
  await session.upload({ files: directory, selector: '#directory' });
  assert.equal(await page.locator('#directory').evaluate(input => input.files.length), 1);
  const uploaded = page.waitForResponse(response => response.url().endsWith('/api/upload'));
  await page.locator('#submit').click();
  assert.equal((await (await uploaded).json()).ok, true);
  assert.equal(uploadReceived, true);
  const popupPromise = page.waitForEvent('popup');
  await page.locator('#popup').click();
  const popup = await popupPromise;
  await popup.waitForFunction(() => window.done);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download').click();
  const download = await downloadPromise;
  const downloadPath = path.join(root, download.suggestedFilename());
  await download.saveAs(downloadPath);
  assert.equal(await readFile(downloadPath, 'utf8'), 'download-marker');
  await page.screenshot({ path: path.join(root, 'fixture.png'), fullPage: true });
  assert.ok((await session.cdp('DOM.getDocument')).root.nodeId);
  await session.cdp('Debugger.enable');
  const evaluated = await session.cdp('Runtime.evaluate', { expression: '6 * 7', returnByValue: true });
  assert.equal(evaluated.result.value, 42);
  await session.cdp('Debugger.disable');
  assert.ok((await session.cdp('Browser.getVersion')).product);
  console.log('Verified file input, native chooser event, directory upload, download, screenshot, DOM and Debugger commands.');

  const mediaFrame = page.frames().find(frame => frame.url().endsWith('/frame'));
  await page.locator('iframe').evaluate(frame => { frame.style.height = '300px'; frame.style.width = '500px'; });
  await mediaFrame.evaluate(async () => {
    const audition = document.createElement('audio'); audition.id = 'auditionAudio'; audition.src = ''; audition.hidden = true; document.body.append(audition);
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d'); let tick = 0;
    const paint = setInterval(() => { context.fillStyle = '#007e75'; context.fillRect(0, 0, 320, 180);
      context.fillStyle = 'white'; context.font = '22px sans-serif'; context.fillText(`Media evidence ${++tick}`, 15, 90); }, 50);
    const stream = canvas.captureStream(10), chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    recorder.ondataavailable = event => chunks.push(event.data);
    const stopped = new Promise(resolve => recorder.onstop = resolve);
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 6000)); recorder.stop(); await stopped;
    clearInterval(paint); stream.getTracks().forEach(track => track.stop());
    const video = document.createElement('video'); video.width = 320; video.height = 180; video.muted = true;
    video.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })); document.body.append(video);
    const track = video.addTextTrack('captions', 'Local captions', 'en'); track.mode = 'showing';
    track.addCue(new VTTCue(0, 10, 'media-evidence-caption')); await video.play();
  });
  const mediaState = await inspectMedia(page);
  assert.equal(mediaState.media.length, 2);
  assert.equal(mediaState.media.filter(item => item.placeholder).length, 1);
  const actualVideo = mediaState.media.find(item => item.tag === 'video');
  assert.ok(actualVideo.frameUrl.endsWith('/frame'));
  assert.equal(actualVideo.playbackRate, 1);
  const evidence = await captureMediaEvidence(page, { outputDir: path.join(root, 'media'), seconds: 3.5, intervalSeconds: .3, pollMs: 100 });
  assert.ok(evidence.images >= 2, `Expected progressing media frames, got ${evidence.images}`);
  const manifest = await readFile(evidence.manifestPath, 'utf8');
  assert.ok(manifest.includes('media-evidence-caption'));
  const snapshots = manifest.trim().split('\n').flatMap(line => JSON.parse(line).evidence);
  assert.ok(snapshots.at(-1).currentTime > snapshots[0].currentTime);
  for (const snapshot of snapshots) if (snapshot.image) assert.ok((await readFile(path.join(root, 'media', snapshot.image))).length > 0);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(captureMediaEvidence(page, { outputDir: path.join(root, 'media'), signal: cancelled.signal }), { name: 'AbortError' });
  console.log('Verified nested-frame media inspection, advancing video screenshots/captions, and cancellation.');

  attached = await openSession({ endpoint: session.endpoint, targetUrl: `${base}/`, workDir: root, outputDir: path.join(root, 'attached') });
  attached.page = attached.context.pages().find(page => page.url() === `${base}/`);
  assert.ok(attached.page, 'Select the actual fixture tab rather than browser-internal pages or the popup.');
  const dialogOpened = new Promise(resolve => page.once('dialog', resolve));
  const dialogResult = page.evaluate(() => confirm('attached-observer-dialog'));
  const ownerDialog = await dialogOpened;
  await new Promise(resolve => setTimeout(resolve, 200));
  await ownerDialog.accept();
  assert.equal(await dialogResult, true, 'An attached observer must not automatically dismiss dialogs belonging to the primary client.');
  await attached.page.evaluate(() => fetch('/api/attached').then(r => r.json()));
  await attached.close();
  assert.equal(await page.evaluate(() => 40 + 2), 42, 'Disconnecting the attached client must preserve the original browser.');
  await page.evaluate(() => fetch('/api/after-disconnect').then(r => r.json()));
  const attachedRequests = JSON.parse(await readFile(path.join(root, 'attached', 'requests.json'), 'utf8'));
  assert.ok(attachedRequests.some(r => r.request.url.endsWith('/api/attached')));

  const live = await session.flush();
  assert.ok(live.requestCount > 10);
  await popup.close();
  summary = await session.close();
  const requests = JSON.parse(await readFile(path.join(root, 'capture', 'requests.json'), 'utf8'));
  const find = suffix => requests.filter(r => new URL(r.request.url).pathname === suffix);
  for (const suffix of ['/api/example', '/api/xhr', '/api/from-worker', '/api/from-shared-worker', '/api/from-service-worker', '/api/from-frame', '/api/from-popup', '/api/upload', '/api/redirect-target', '/api/after-disconnect']) {
    assert.ok(find(suffix).length, `Missing capture: ${suffix}`);
  }
  for (const [suffix, expectedType] of [['/api/from-worker', 'worker'], ['/api/from-shared-worker', 'shared_worker'], ['/api/from-service-worker', 'service_worker']]) {
    assert.ok(find(suffix).some(r => r.targetType === expectedType), `Missing independent ${expectedType} target capture`);
  }
  assert.ok(find('/redirect').some(r => r.state === 'redirect' && r.response.status === 302));
  for (const suffix of ['/worker.js', '/shared-worker.js', '/frame']) {
    assert.ok(find(suffix).some(r => r.state === 'finished'), `Missing completion after target migration: ${suffix}`);
  }
  assert.ok(find('/failure').some(r => r.state === 'failed'));
  assert.ok(find('/large').some(r => r.bodyUnavailable?.includes('maxBodyBytes')));
  const example = find('/api/example').find(r => r.body);
  assert.ok(example.request.postData.includes('request payload'));
  assert.equal(example.requestExtraInfo.headers['X-Probe'] ?? example.requestExtraInfo.headers['x-probe'], 'request-extra-info');
  const responseBody = JSON.parse(await readFile(path.join(root, 'capture', example.body.file), 'utf8'));
  assert.equal(responseBody.message, 'response payload 中文');
  const events = (await readFile(path.join(root, 'capture', 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(e => e.method === 'Network.webSocketFrameSent' && e.params.response.payloadData === 'ws-client-marker'));
  assert.ok(events.some(e => e.method === 'Network.webSocketFrameReceived' && e.params.response.payloadData === 'ws-server-marker'));
  assert.ok(events.some(e => e.method === 'Network.eventSourceMessageReceived' && e.params.data === 'sse-marker'));
  assert.ok((await readFile(path.join(root, 'capture', 'console.jsonl'), 'utf8')).includes('fixture-console-marker'));
  const cdpHar = JSON.parse(await readFile(path.join(root, 'capture', 'network.cdp.har'), 'utf8'));
  assert.equal(cdpHar.log.version, '1.2');
  assert.equal(cdpHar.log.entries.length, requests.length);
  const nativeHar = JSON.parse(await readFile(path.join(root, 'capture', 'network.playwright.har'), 'utf8'));
  assert.ok(nativeHar.log.entries.length > 10);
  const schema = JSON.parse(await readFile(path.join(root, 'capture', 'protocol.json'), 'utf8'));
  assert.ok(schema.domains.some(domain => domain.domain === 'Network'));
  assert.equal(summary.warnings.length, 0, JSON.stringify(summary.warnings));
  const report = {
    passed: true, testedAt: new Date().toISOString(), browser: session.version.Browser,
    outputDir: root, requests: requests.length, targets: [...new Set(requests.map(r => r.targetType))],
    checks: ['multiple files', 'file chooser', 'directory upload', 'server upload response', 'download', 'screenshot', 'DOM', 'Debugger', 'raw CDP', 'existing browser attach/disconnect', 'fetch', 'XHR', 'redirect hops', 'network failure', 'response body', 'ExtraInfo headers', 'large-body omission', 'dedicated worker', 'shared worker', 'service worker', 'cross-origin iframe', 'cross-target request completion', 'popup', 'WebSocket sent/received', 'SSE', 'console', 'all-target HAR', 'native HAR', 'live protocol schema', 'nested-frame media state', 'video frames and active captions', 'media cancellation', 'empty audio placeholder filtering'],
  };
  await writeFile(path.join(root, 'test-result.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (attached && !attached.closed) await attached.close().catch(() => {});
  if (session && !session.closed) await session.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
