import path from 'node:path';
import { doctor, openSession } from './browser-session.mjs';
import { errorResult, runPipe, runTask } from './browser-pipe.mjs';

function parse(argv) {
  const result = { command: argv[0] ?? 'help' };
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (['--headless', '--unattended'].includes(key)) { result[key.slice(2)] = true; continue; }
    if (key === '--headed') { result.headless = false; continue; }
    if (!key.startsWith('--') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Expected a value after ${key}`);
    result[key.slice(2)] = argv[++i];
  }
  return result;
}

const usage = `Browser debugger (Node.js 22+)
  node scripts/browser.mjs doctor
  node scripts/browser.mjs browsers
  node scripts/browser.mjs doctor --browser chrome
  node scripts/browser.mjs capture --url https://example.com --seconds 60 --out C:/path/work/capture
  node scripts/browser.mjs capture --endpoint http://127.0.0.1:9222 --seconds 60
  node scripts/browser.mjs run --script C:/path/work/task.mjs --out C:/path/work/capture
  node scripts/browser.mjs pipe --unattended --profile-name shop --work C:/path/work/browser
Options: --browser auto|edge|chrome|chromium|brave|vivaldi|opera|opera-gx (default: auto),
  also: chrome-beta|chrome-dev|chrome-canary|edge-beta|edge-dev|edge-canary,
  --headless|--headed, --unattended,
  --profile ABS_PATH | --profile-name NAME [--state-dir ABS_PATH],
  --target-url EXACT_URL, --ready-selector CSS, --ready-text TEXT,
  --login-selector CSS, --blocked-selector CSS,
  --work ABS_PATH, --executable ABS_PATH, --max-body-bytes NUMBER.
pipe reads JSONL commands from stdin; see references/unattended.md.
Named profiles persist across task directories; no personal-profile cookies are imported.
Unattended mode defaults to headless and stops on detected login/challenge/access blockers.
run scripts export a default async function({ session, page, context, outputDir }).
The capture starts before --url navigation. Ctrl+C stops and flushes the capture.
The launched dedicated browser closes on completion; an attached existing browser stays open.`;

async function main() {
  const args = parse(process.argv.slice(2));
  if (args.command === 'help') { console.log(usage); return; }
  if (['doctor', 'browsers'].includes(args.command)) {
    for (const key of Object.keys(args)) if (!['command', 'browser', 'executable'].includes(key)) throw new Error(`Unknown option for ${args.command}: --${key}`);
    const status = await doctor({ browser: args.browser, executablePath: args.executable });
    console.log(JSON.stringify(status, null, 2));
    if (args.command === 'doctor' && !status.ready) process.exitCode = 1;
    return;
  }
  if (!['capture', 'run', 'pipe'].includes(args.command)) throw new Error(usage);
  const allowed = new Set(['command', 'url', 'seconds', 'out', 'endpoint', 'script', 'browser', 'headless', 'profile', 'profile-name', 'state-dir', 'work', 'executable', 'max-body-bytes', 'target-url', 'unattended', 'ready-selector', 'ready-text', 'login-selector', 'blocked-selector']);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`);
  const seconds = Number(args.seconds ?? 60);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('--seconds must be nonnegative.');
  if (args.command === 'run' && !args.script) throw new Error('run requires --script ABS_PATH.');
  if (args['max-body-bytes'] !== undefined && (!Number.isInteger(Number(args['max-body-bytes'])) || Number(args['max-body-bytes']) < 0)) throw new Error('--max-body-bytes must be a nonnegative integer.');
  const readiness = { readySelector: args['ready-selector'], readyText: args['ready-text'], loginSelector: args['login-selector'], blockedSelector: args['blocked-selector'] };
  const session = await openSession({
    endpoint: args.endpoint, browser: args.browser, headless: args.headless, unattended: args.unattended,
    profileDir: args.profile, profileName: args['profile-name'], stateDir: args['state-dir'], workDir: args.work, outputDir: args.out,
    targetUrl: args['target-url'], initialUrl: args.url,
    executablePath: args.executable,
    ...(args['max-body-bytes'] !== undefined ? { maxBodyBytes: Number(args['max-body-bytes']) } : {}),
  });
  console.log(JSON.stringify({ event: 'session_ready', ready: true, pageReady: null, outputDir: session.outputDir, profileDir: session.profileDir, browserSelection: session.browserSelection, endpoint: session.endpoint, captureStartedAt: session.recorder.startedAt }));
  let interrupted = false;
  let wake;
  const controller = new AbortController();
  const signal = () => { interrupted = true; controller.abort(); wake?.(); };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  try {
    if (args.url && session.page.url() !== new URL(args.url).href) await session.page.goto(args.url, { waitUntil: 'domcontentloaded' });
    if (args.unattended && (args.url || args['target-url'])) {
      console.log(JSON.stringify({ event: 'page_status', ...await session.ensureReady(readiness) }));
    }
    if (interrupted) return;
    if (args.command === 'run') {
      if (args.unattended && !args.url && !args['target-url']) await session.ensureReady(readiness);
      const result = await runTask(session, path.resolve(args.script), controller.signal);
      if (result !== undefined) console.log(JSON.stringify({ event: 'task_result', result }));
    } else if (args.command === 'pipe') {
      await runPipe({ session, signal: controller.signal, readiness });
    } else if (!interrupted) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, seconds * 1000);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  } finally {
    const summary = await session.close();
    process.off('SIGINT', signal);
    process.off('SIGTERM', signal);
    console.log(JSON.stringify({ event: 'session_closed', saved: session.outputDir, requestCount: summary.requestCount, warnings: summary.warnings.length }));
  }
}

main().catch(error => { console.error(JSON.stringify({ event: 'error', error: errorResult(error) })); process.exitCode = 1; });
