import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { openSession } from './browser-session.mjs';
import { profileDirectory } from './session-controls.mjs';
const browserOptions = { browser: process.env.BROWSER_DEBUGGER_TEST_BROWSER ?? 'auto', executablePath: process.env.BROWSER_DEBUGGER_TEST_EXECUTABLE };
import { runPipe } from './browser-pipe.mjs';

const root = path.resolve(process.argv[2] ?? path.join(process.cwd(), 'work', `unattended-test-${Date.now()}`));
await mkdir(root, { recursive: true });
const stateDir = path.join(root, 'persistent-state');
let publications = 0;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://fixture.test').pathname;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (pathname === '/seed-local-session') {
    response.setHeader('Set-Cookie', 'fixture_session=local-only; HttpOnly; Max-Age=86400; SameSite=Lax; Path=/');
    response.end('<title>Local fixture setup</title><p>Test session seeded</p>');
  } else if (pathname === '/app' && !request.headers.cookie?.includes('fixture_session=local-only')) {
    response.writeHead(302, { Location: '/login' }); response.end();
  } else if (pathname === '/app') {
    response.end(`<title>Local signed-in app</title><h1 id="account">Signed in fixture</h1><a href="/login">登录</a>
      <input id="listing" placeholder="Listing title"><button id="publish">Publish fixture</button><p id="status"></p>
      <script>document.querySelector('#publish').onclick=async()=>{const result=await(await fetch('/api/publish',{method:'POST',body:document.querySelector('#listing').value})).json();document.querySelector('#status').textContent='Published fixture '+result.count}</script>`);
  } else if (pathname === '/api/publish') {
    for await (const chunk of request) { /* Consume the local fixture request. */ }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ count: ++publications }));
  } else if (pathname === '/login') {
    response.end('<title>Sign in</title><h1>Sign in</h1><form><input id="username" autocomplete="username"><input type="password"><button>Log in</button></form>');
  } else if (pathname === '/challenge') {
    response.end('<title>Verification</title><h1>Verify you are human</h1><button>Verify</button>');
  } else if (pathname === '/blocked') {
    response.end('<title>Access issue</title><h1>非法访问</h1><p>为了保障您的体验，请使用正常浏览器访问闲鱼~</p>');
  } else if (pathname === '/frame-login') {
    response.end('<title>App with login dialog</title><iframe src="/login"></iframe>');
  } else if (pathname === '/frame-hidden') {
    response.end('<title>Public page</title><h1 id="public">Public fixture</h1><iframe style="display:none" src="/login"></iframe>');
  } else if (pathname === '/delayed') {
    response.end('<title>Loading fixture</title><p hidden>Loaded fixture</p><script>setTimeout(()=>{const p=document.createElement("p");p.textContent="Loaded fixture";document.body.append(p)},100)</script>');
  } else response.end('<title>Neutral fixture</title><h1 id="public">Public fixture</h1><a href="/login">Log in</a>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const cli = fileURLToPath(new URL('./browser.mjs', import.meta.url));
const children = new Set();

function start(args) {
  const child = spawn(process.execPath, [cli, ...args, '--browser', browserOptions.browser, ...(browserOptions.executablePath ? ['--executable', browserOptions.executablePath] : [])], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  children.add(child);
  const events = [], waiters = new Set();
  let pending = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    pending += chunk;
    let boundary;
    while ((boundary = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
      try {
        const event = JSON.parse(line); events.push(event);
        for (const waiter of [...waiters]) if (waiter.match(event)) waiter.resolve(event);
      } catch { /* Non-protocol task logging is not treated as a reply. */ }
    }
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { children.delete(child); resolve({ code, stderr, events }); });
  });
  const wait = (match, timeout = 40000) => {
    const existing = events.find(match); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timed out waiting for CLI event; stderr: ${stderr}`)); }, timeout);
      const waiter = { match, resolve: event => { clearTimeout(timer); waiters.delete(waiter); resolve(event); } };
      waiters.add(waiter);
    });
  };
  return { child, wait, done, send: request => { const reply = wait(event => event.id === request.id); child.stdin.write(`${JSON.stringify(request)}\n`); return reply; } };
}

let session, attached;
try {
  await runPipe({ session: {}, input: new PassThrough(), output: new PassThrough(), signal: AbortSignal.abort() });
  assert.throws(() => profileDirectory({ profileName: '../Default', stateDir, workDir: root, browser: 'edge' }), { code: 'INVALID_PROFILE_NAME' });
  assert.throws(() => profileDirectory({ profileDir: root, profileName: 'other', stateDir, workDir: root, browser: 'edge' }), { code: 'INVALID_OPTIONS' });
  session = await openSession({ ...browserOptions, headless: true, unattended: true, profileName: 'fixture', stateDir, workDir: path.join(root, 'first-task') });
  await session.navigate(`${base}/seed-local-session`);
  await session.page.evaluate(() => localStorage.setItem('fixture-state', 'persisted'));
  assert.equal((await session.navigate(`${base}/app`, { readySelector: '#account' })).state, 'ready');
  const expectedProfile = session.profileDir;
  await session.close();

  session = await openSession({ ...browserOptions, headless: true, unattended: true, profileName: 'fixture', stateDir, workDir: path.join(root, 'different-task') });
  assert.equal(session.profileDir, expectedProfile);
  assert.equal((await session.navigate(`${base}/app`, { readySelector: '#account' })).state, 'ready');
  assert.equal(await session.page.evaluate(() => localStorage.getItem('fixture-state')), 'persisted');
  const second = await session.newPage(); await second.goto(`${base}/neutral`);
  await assert.rejects(openSession({ endpoint: session.endpoint, workDir: path.join(root, 'ambiguous') }), { code: 'AMBIGUOUS_PAGE' });
  assert.equal(await session.page.title(), 'Local signed-in app', 'A failed attachment must preserve the owning browser.');
  attached = await openSession({ endpoint: session.endpoint, targetUrl: `${base}/app`, workDir: path.join(root, 'targeted') });
  assert.equal(attached.page.url(), `${base}/app`);
  await attached.close();
  assert.equal(await second.title(), 'Neutral fixture');
  await assert.rejects(session.selectPage(`${base}/absent`), { code: 'TARGET_NOT_FOUND' });
  assert.equal(session.page.url(), `${base}/app`, 'A missing target must not change the active page.');
  await assert.rejects(session.navigate(`${base}/login`), { code: 'LOGIN_REQUIRED' });
  await assert.rejects(session.navigate(`${base}/challenge`), { code: 'VERIFICATION_REQUIRED' });
  await assert.rejects(session.navigate(`${base}/blocked`), { code: 'ACCESS_BLOCKED' });
  await session.page.goto(`${base}/frame-login`);
  await session.page.frameLocator('iframe').locator('#username').waitFor();
  await assert.rejects(session.ensureReady(), { code: 'LOGIN_REQUIRED' });
  await session.page.goto(`${base}/frame-hidden`);
  assert.equal((await session.ensureReady({ readySelector: '#public' })).state, 'ready', 'Hidden login frames and login navigation links must not block a public page.');
  await assert.rejects(session.ensureReady({ readySelector: '#nonexistent', readyTimeoutMs: 100 }), { code: 'READY_CONDITION_MISSING' });
  await assert.rejects(session.ensureReady({ readySelector: '#nonexistent', readyTimeoutMs: 0 }), { code: 'INVALID_OPTIONS' });
  assert.equal((await session.navigate(`${base}/delayed`, { readyText: 'Loaded fixture', readyTimeoutMs: 2000 })).state, 'ready', 'Readiness must wait for visible text even when an earlier copy is hidden.');
  await session.close();
  console.log('Verified cross-task session persistence, unambiguous tab selection and passive blockers.');

  const taskScript = path.join(root, 'publish-fixture.mjs');
  await writeFile(taskScript, `export default async ({session,page}) => {
    await session.ensureReady({readySelector:'#account'});
    await page.locator('#listing').fill('Local test listing 60');
    await page.getByRole('button',{name:'Publish fixture',exact:true}).click();
    await page.getByText('Published fixture 1',{exact:true}).waitFor();
    return {published:true,title:await page.locator('#listing').inputValue()};
  };`);
  const pipe = start(['pipe', '--unattended', '--profile-name', 'fixture', '--state-dir', stateDir, '--url', `${base}/app`, '--ready-selector', '#account', '--work', path.join(root, 'pipe-task')]);
  await pipe.wait(event => event.event === 'page_status' && event.state === 'ready');
  const malformed = pipe.wait(event => event.id === null && event.error?.code === 'INVALID_JSON');
  pipe.child.stdin.write('invalid-json\n'); await malformed;
  const published = await pipe.send({ id: 1, op: 'run', script: taskScript });
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.equal(published.result.published, true);
  const snapshot = await pipe.send({ id: 2, op: 'snapshot' });
  assert.ok(snapshot.result.text.includes('Published fixture 1'));
  const screenshot = await pipe.send({ id: 3, op: 'screenshot' });
  assert.equal(screenshot.ok, true, JSON.stringify(screenshot));
  assert.equal((await readFile(screenshot.result.path)).subarray(1, 4).toString(), 'PNG');
  const blocked = await pipe.send({ id: 4, op: 'navigate', url: `${base}/login`, readiness: { readySelector: undefined } });
  assert.equal(blocked.error.code, 'LOGIN_REQUIRED');
  const prevented = await pipe.send({ id: 5, op: 'run', script: taskScript });
  assert.equal(prevented.error.code, 'LOGIN_REQUIRED');
  assert.equal(publications, 1, 'A blocked task must not run or repeat its side effect.');
  const recovered = await pipe.send({ id: 6, op: 'navigate', url: `${base}/app` });
  assert.equal(recovered.result.state, 'ready', JSON.stringify(recovered));
  await pipe.send({ id: 7, op: 'close' });
  assert.equal((await pipe.done).code, 0);
  const eof = start(['pipe', '--unattended', '--profile-name', 'fixture', '--state-dir', stateDir, '--work', path.join(root, 'eof-task')]);
  await eof.wait(event => event.event === 'session_ready');
  eof.child.stdin.end();
  assert.equal((await eof.done).code, 0, 'EOF must flush the session and release the named profile.');
  console.log('Verified a real CLI pipe: reused authentication, execution, screenshots, error recovery and blocked-task prevention.');

  const sentinel = path.join(root, 'must-not-run.txt');
  const forbidden = path.join(root, 'must-not-run.mjs');
  await writeFile(forbidden, `import {writeFile} from 'node:fs/promises'; export default async()=>writeFile(${JSON.stringify(sentinel)},'unexpected');`);
  const failed = start(['run', '--unattended', '--profile-name', 'isolated', '--state-dir', stateDir, '--url', `${base}/app`, '--ready-selector', '#account', '--script', forbidden, '--work', path.join(root, 'not-authenticated')]);
  const failedResult = await failed.done;
  assert.equal(failedResult.code, 1);
  assert.ok(failedResult.stderr.includes('LOGIN_REQUIRED'));
  await assert.rejects(access(sentinel), { code: 'ENOENT' });
  assert.equal(publications, 1);
  const report = {
    passed: true, testedAt: new Date().toISOString(), outputDir: root,
    checks: ['named profile persists HttpOnly login cookie across work directories', 'localStorage persistence', 'separate profile isolation', 'invalid profile path rejected', 'targeted attach preserves other tabs', 'ambiguous/missing target fails safely', 'visible login page and iframe detected', 'hidden login iframe ignored', 'ordinary login link ignored', 'verification and access block detected', 'required ready selector enforced', 'delayed ready text with hidden duplicate', 'unbounded readiness timeout rejected', 'real stdin JSONL process persistence', 'real local publication exactly once', 'screenshot artifact exists', 'blocked task not executed', 'pipe recovers after malformed JSON and blocked command', 'EOF closes and flushes browser', 'pre-aborted pipe returns immediately', 'nonzero unattended CLI exit without running task'],
  };
  await writeFile(path.join(root, 'test-result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (attached && !attached.closed) await attached.close().catch(() => {});
  if (session && !session.closed) await session.close().catch(() => {});
  for (const child of children) child.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
