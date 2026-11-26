import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browserCatalog, discoverBrowsers, normalizeBrowser, resolveBrowser } from './browser-registry.mjs';

function fixture(platform, files, extra = {}) {
  return { platform, env: {}, home: platform === 'win32' ? 'C:\\Users\\tester' : '/home/tester', isExecutable: async file => files.includes(file), readDirectory: async () => [], ...extra };
}

test('aliases and unsupported engines have explicit results', () => {
  assert.equal(normalizeBrowser(), 'auto');
  assert.equal(normalizeBrowser('Google-Chrome'), 'chrome');
  assert.equal(normalizeBrowser('msedge-beta'), 'edge-beta');
  assert.equal(normalizeBrowser('BRAVE-BROWSER'), 'brave');
  for (const name of ['firefox', 'safari', '', 'chrome_typo']) assert.throws(() => normalizeBrowser(name), { code: 'UNSUPPORTED_BROWSER' });
  assert.equal(browserCatalog().length, 13);
  assert.ok(!browserCatalog().find(item => item.id === 'opera-gx').platforms.includes('linux'));
});

test('Windows detects per-user Chrome and Program Files (x86) Edge', async () => {
  const options = fixture('win32', ['C:\\Apps86\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Users\\tester\\Local\\Google\\Chrome\\Application\\chrome.exe'], {
    env: { ProgramFiles: 'C:\\Apps', 'ProgramFiles(x86)': 'C:\\Apps86', LOCALAPPDATA: 'C:\\Users\\tester\\Local' },
  });
  const installed = await discoverBrowsers(options);
  assert.deepEqual(installed.map(item => item.id), ['edge', 'chrome']);
  assert.equal((await resolveBrowser({ ...options, installed })).id, 'edge');
  assert.match((await resolveBrowser({ ...options, installed, browser: 'chrome' })).executablePath, /Local\\Google/);
});

test('explicit Chrome never falls back to available Edge', async () => {
  const options = fixture('win32', ['C:\\Apps\\Microsoft\\Edge\\Application\\msedge.exe'], { env: { ProgramFiles: 'C:\\Apps' } });
  await assert.rejects(resolveBrowser({ ...options, browser: 'chrome' }), { code: 'BROWSER_NOT_FOUND' });
  assert.equal((await resolveBrowser(options)).id, 'edge');
});

test('macOS supports user Applications and prefers stable Chrome for auto', async () => {
  const options = fixture('darwin', ['/home/tester/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
  const installed = await discoverBrowsers(options);
  assert.deepEqual(installed.map(item => item.id), ['chrome', 'brave']);
  assert.equal((await resolveBrowser({ ...options, installed })).id, 'chrome');
  assert.equal((await resolveBrowser({ ...options, installed, browser: 'brave' })).source, 'installed');
});

test('Linux searches absolute PATH entries and package-manager locations', async () => {
  const options = fixture('linux', ['/custom/bin/vivaldi', '/snap/bin/chromium', '/opt/google/chrome-beta/chrome'], { env: { PATH: '.:relative:/custom/bin' } });
  const installed = await discoverBrowsers(options);
  assert.deepEqual(installed.map(item => item.id), ['chromium', 'vivaldi', 'chrome-beta']);
  assert.equal((await resolveBrowser({ ...options, browser: 'chrome-beta', installed })).id, 'chrome-beta');
  assert.equal((await resolveBrowser({ ...options, browser: 'chromium', installed })).executablePath, '/snap/bin/chromium');
});

test('Opera prefers the newest versioned executable using numeric ordering', async () => {
  const root = 'C:\\Local\\Programs\\Opera';
  const latest = `${root}\\100.2.0.0\\opera.exe`;
  const options = fixture('win32', [latest, `${root}\\99.9.0.0\\opera.exe`, `${root}\\opera.exe`], {
    env: { LOCALAPPDATA: 'C:\\Local' },
    readDirectory: async folder => folder === root ? ['99.9.0.0', '100.2.0.0', '..', 'profile'] : [],
  });
  assert.equal((await resolveBrowser({ ...options, browser: 'opera' })).executablePath, latest);
});

test('managed Chromium is used only if its executable exists', async () => {
  const options = fixture('linux', ['/managed/chrome'], { managedExecutablePath: '/managed/chrome' });
  const selected = await resolveBrowser(options);
  assert.equal(selected.id, 'chromium');
  assert.equal(selected.source, 'playwright');
  await assert.rejects(resolveBrowser({ ...options, managedExecutablePath: '/missing/chrome' }), { code: 'BROWSER_NOT_FOUND' });
});

test('custom executable namespaces are deterministic and isolated', async () => {
  const options = fixture('win32', ['C:\\Portable\\chrome.exe', 'C:\\Other\\chrome.exe']);
  const first = await resolveBrowser({ ...options, executablePath: 'C:\\Portable\\chrome.exe' });
  const second = await resolveBrowser({ ...options, executablePath: 'C:\\Other\\chrome.exe' });
  assert.match(first.profileKey, /^custom-[a-f0-9]{12}$/);
  assert.notEqual(first.profileKey, second.profileKey);
  assert.equal(first.profileKey, (await resolveBrowser({ ...options, executablePath: first.executablePath })).profileKey);
  assert.equal((await resolveBrowser({ ...options, browser: 'chrome', executablePath: first.executablePath })).profileKey, 'chrome');
  await assert.rejects(resolveBrowser({ ...options, executablePath: 'relative/chrome.exe' }), { code: 'INVALID_EXECUTABLE' });
  await assert.rejects(resolveBrowser({ ...options, executablePath: 'C:\\Missing\\chrome.exe' }), { code: 'INVALID_EXECUTABLE' });
});

test('real filesystem rejects a directory and missing or non-executable files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'browser-registry-'));
  await mkdir(path.join(root, 'directory'));
  const file = path.join(root, 'browser');
  await writeFile(file, 'fixture, never executed');
  await assert.rejects(resolveBrowser({ executablePath: path.join(root, 'directory') }), { code: 'INVALID_EXECUTABLE' });
  await assert.rejects(resolveBrowser({ executablePath: path.join(root, 'missing') }), { code: 'INVALID_EXECUTABLE' });
  if (process.platform !== 'win32') {
    await chmod(file, 0o600);
    await assert.rejects(resolveBrowser({ executablePath: file }), { code: 'INVALID_EXECUTABLE' });
    await chmod(file, 0o700);
  }
  assert.equal((await resolveBrowser({ executablePath: file })).source, 'custom');
});
