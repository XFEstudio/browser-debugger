import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BrowserControlError } from './session-controls.mjs';

// Known application locations only: discovery never reads profiles or scans ports.
const definitions = [
  ['edge', 'Microsoft Edge', ['Microsoft/Edge/Application/msedge.exe'], ['Microsoft Edge.app'], ['microsoft-edge', 'microsoft-edge-stable']],
  ['chrome', 'Google Chrome', ['Google/Chrome/Application/chrome.exe'], ['Google Chrome.app'], ['google-chrome', 'google-chrome-stable']],
  ['chromium', 'Chromium', ['Chromium/Application/chrome.exe'], ['Chromium.app'], ['chromium', 'chromium-browser']],
  ['brave', 'Brave', ['BraveSoftware/Brave-Browser/Application/brave.exe'], ['Brave Browser.app'], ['brave-browser', 'brave-browser-stable', 'brave']],
  ['vivaldi', 'Vivaldi', ['Vivaldi/Application/vivaldi.exe'], ['Vivaldi.app'], ['vivaldi', 'vivaldi-stable']],
  ['opera', 'Opera', ['Opera/opera.exe', 'Programs/Opera/opera.exe'], ['Opera.app'], ['opera', 'opera-stable']],
  ['opera-gx', 'Opera GX', ['Opera GX/opera.exe', 'Programs/Opera GX/opera.exe'], ['Opera GX.app'], []],
  ['chrome-beta', 'Google Chrome Beta', ['Google/Chrome Beta/Application/chrome.exe'], ['Google Chrome Beta.app'], ['google-chrome-beta']],
  ['chrome-dev', 'Google Chrome Dev', ['Google/Chrome Dev/Application/chrome.exe'], ['Google Chrome Dev.app'], ['google-chrome-unstable']],
  ['chrome-canary', 'Google Chrome Canary', ['Google/Chrome SxS/Application/chrome.exe'], ['Google Chrome Canary.app'], []],
  ['edge-beta', 'Microsoft Edge Beta', ['Microsoft/Edge Beta/Application/msedge.exe'], ['Microsoft Edge Beta.app'], ['microsoft-edge-beta']],
  ['edge-dev', 'Microsoft Edge Dev', ['Microsoft/Edge Dev/Application/msedge.exe'], ['Microsoft Edge Dev.app'], ['microsoft-edge-dev']],
  ['edge-canary', 'Microsoft Edge Canary', ['Microsoft/Edge SxS/Application/msedge.exe'], ['Microsoft Edge Canary.app'], []],
].map(([id, name, windows, mac, linux]) => ({ id, name, windows, mac, linux }));

const aliases = {
  msedge: 'edge', 'microsoft-edge': 'edge', 'msedge-beta': 'edge-beta',
  'msedge-dev': 'edge-dev', 'msedge-canary': 'edge-canary',
  'google-chrome': 'chrome', googlechrome: 'chrome', 'chrome-stable': 'chrome',
  'brave-browser': 'brave', 'chromium-browser': 'chromium', operagx: 'opera-gx',
};

export function browserCatalog() {
  return definitions.map(({ id, name, linux }) => ({ id, name, platforms: ['win32', 'darwin', ...(linux.length ? ['linux'] : [])] }));
}

export function normalizeBrowser(value = 'auto') {
  const input = String(value).trim().toLowerCase();
  const id = aliases[input] ?? input;
  if (id === 'auto' || definitions.some(item => item.id === id)) return id;
  throw new BrowserControlError('UNSUPPORTED_BROWSER', `Unknown CDP browser "${value}". Choose auto or: ${definitions.map(item => item.id).join(', ')}. Firefox and Safari do not expose the Chromium CDP required by this recorder.`);
}

async function executableFile(file, platform) {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

function environment(options) {
  const platform = options.platform ?? process.platform;
  return { platform, env: options.env ?? process.env, home: options.home ?? homedir(), paths: platform === 'win32' ? path.win32 : path.posix };
}

export async function discoverBrowsers(options = {}) {
  const { platform, env, home, paths } = environment(options);
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw new BrowserControlError('UNSUPPORTED_PLATFORM', `Automatic browser discovery does not support ${platform}; provide --executable with a compatible Chromium browser.`);
  const check = options.isExecutable ?? (file => executableFile(file, platform));
  const list = options.readDirectory ?? (dir => readdir(dir));
  const roots = platform === 'win32'
    ? [...new Set([env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean))]
    : [];
  const searchPath = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(entry => entry && paths.isAbsolute(entry));
  const found = [];
  const seen = new Set();
  for (const definition of definitions) {
    let candidates = [];
    if (platform === 'win32') {
      candidates = roots.flatMap(root => definition.windows.map(relative => paths.join(root, relative)));
      if (['opera', 'opera-gx'].includes(definition.id)) {
        // Opera stores its actual executable in a versioned subdirectory on some installations.
        const folders = [...new Set(candidates.map(file => paths.dirname(file)))];
        const versioned = [];
        for (const folder of folders) {
          let names = [];
          try { names = await list(folder); } catch {}
          for (const name of names.filter(name => /^\d+(?:\.\d+)+$/.test(name)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))) {
            versioned.push(paths.join(folder, name, 'opera.exe'));
          }
        }
        candidates = [...versioned, ...candidates];
      }
    } else if (platform === 'darwin') {
      candidates = ['/Applications', paths.join(home, 'Applications')].flatMap(root => definition.mac.map(app => paths.join(root, app, 'Contents/MacOS', app.replace(/\.app$/, ''))));
      if (definition.id === 'opera-gx') candidates.push(...['/Applications', paths.join(home, 'Applications')].map(root => paths.join(root, 'Opera GX.app/Contents/MacOS/Opera')));
    } else {
      const directories = [...new Set([...searchPath, '/usr/bin', '/usr/local/bin', '/snap/bin'])];
      candidates = directories.flatMap(dir => definition.linux.map(command => paths.join(dir, command)));
      const opt = {
        chrome: '/opt/google/chrome/chrome', 'chrome-beta': '/opt/google/chrome-beta/chrome', 'chrome-dev': '/opt/google/chrome-unstable/chrome',
        edge: '/opt/microsoft/msedge/msedge', 'edge-beta': '/opt/microsoft/msedge-beta/msedge', 'edge-dev': '/opt/microsoft/msedge-dev/msedge',
        brave: '/opt/brave.com/brave/brave-browser', vivaldi: '/opt/vivaldi/vivaldi', opera: '/usr/lib/x86_64-linux-gnu/opera/opera',
      }[definition.id];
      if (opt) candidates.push(opt);
    }
    for (const executablePath of candidates) {
      const key = `${definition.id}:${platform === 'win32' ? executablePath.toLowerCase() : executablePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (await check(executablePath)) {
        found.push({ id: definition.id, name: definition.name, executablePath, source: 'installed' });
        break;
      }
    }
  }
  if (options.managedExecutablePath && !found.some(item => item.id === 'chromium') && await check(options.managedExecutablePath)) {
    found.push({ id: 'chromium', name: 'Playwright Chromium', executablePath: options.managedExecutablePath, source: 'playwright' });
  }
  return found;
}

export async function resolveBrowser(options = {}) {
  const requested = normalizeBrowser(options.browser);
  const { platform, paths } = environment(options);
  if (options.executablePath !== undefined) {
    if (typeof options.executablePath !== 'string' || !paths.isAbsolute(options.executablePath)) throw new BrowserControlError('INVALID_EXECUTABLE', '--executable requires an absolute browser executable path.');
    const executablePath = paths.normalize(options.executablePath);
    const check = options.isExecutable ?? (file => executableFile(file, platform));
    if (!await check(executablePath)) throw new BrowserControlError('INVALID_EXECUTABLE', `Browser executable is missing or not executable: ${executablePath}`);
    const key = platform === 'win32' ? executablePath.toLowerCase() : executablePath;
    const profileKey = requested === 'auto' ? `custom-${createHash('sha256').update(key).digest('hex').slice(0, 12)}` : requested;
    return { requested, id: requested === 'auto' ? 'custom' : requested, name: 'Custom Chromium executable', executablePath, profileKey, source: 'custom' };
  }
  const installed = options.installed ?? await discoverBrowsers(options);
  const order = platform === 'win32' ? definitions.map(item => item.id) : ['chrome', 'edge', ...definitions.map(item => item.id).filter(id => !['chrome', 'edge'].includes(id))];
  const selected = requested === 'auto' ? order.map(id => installed.find(item => item.id === id)).find(Boolean) : installed.find(item => item.id === requested);
  if (!selected) throw new BrowserControlError('BROWSER_NOT_FOUND', `${requested === 'auto' ? 'No supported Chromium browser was found' : `Requested browser "${requested}" was not found`}. Install it, provide --executable ABS_PATH, or install managed Chromium with "npx playwright-core install chromium". An explicit browser never falls back to a different product.`, { requested, available: installed.map(item => item.id) });
  return { ...selected, requested, profileKey: selected.id };
}
