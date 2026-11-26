import readline from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BrowserControlError } from './session-controls.mjs';

export function errorResult(error) {
  return { code: error.code ?? 'OPERATION_FAILED', message: error.message ?? String(error), ...(error.details ? { details: error.details } : {}) };
}

export async function runTask(session, script, signal) {
  if (typeof script !== 'string' || !path.isAbsolute(script)) {
    throw new BrowserControlError('INVALID_SCRIPT_PATH', 'A task script requires an absolute path.');
  }
  const moduleUrl = pathToFileURL(script);
  moduleUrl.searchParams.set('run', randomUUID());
  const task = await import(moduleUrl.href);
  if (typeof task.default !== 'function') throw new BrowserControlError('INVALID_TASK', 'Task module must export a default async function.');
  return task.default({ session, page: session.page, context: session.context, outputDir: session.outputDir, signal });
}

// No HTTP server, remote listener or eval endpoint. The calling tool owns stdin.
export async function runPipe({ session, input = process.stdin, output = process.stdout, signal, readiness = {} }) {
  if (signal?.aborted) return;
  const lines = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  const stop = () => lines.close();
  signal?.addEventListener('abort', stop, { once: true });
  const reply = value => output.write(`${JSON.stringify(value)}\n`);
  try {
    for await (const line of lines) {
      if (signal?.aborted) break;
      if (!line.trim()) continue;
      let request;
      try {
        try { request = JSON.parse(line); }
        catch { throw new BrowserControlError('INVALID_JSON', 'Each command must be one JSON object per line.'); }
        if (!request || Array.isArray(request) || typeof request !== 'object') throw new BrowserControlError('INVALID_COMMAND', 'A command must be a JSON object.');
        const check = { ...readiness, ...request.readiness };
        let result;
        switch (request.op) {
          case 'navigate': {
            if (typeof request.url !== 'string' || !/^https?:\/\//i.test(request.url)) throw new BrowserControlError('INVALID_URL', 'navigate requires an HTTP(S) URL.');
            result = await session.navigate(request.url, check);
            break;
          }
          case 'inspect': result = await session.inspect(check); break;
          case 'snapshot': {
            const maxChars = request.maxChars ?? 12000;
            if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 50000) throw new BrowserControlError('INVALID_OPTIONS', 'maxChars must be an integer between 1 and 50000.');
            result = { url: session.page.url(), title: await session.page.title(), text: (await session.page.locator('body').innerText()).slice(0, maxChars) };
            break;
          }
          case 'select':
            if (typeof request.url !== 'string') throw new BrowserControlError('INVALID_URL', 'select requires an exact URL.');
            await session.selectPage(request.url); result = { url: session.page.url() }; break;
          case 'screenshot': result = await session.screenshot({ path: request.path, fullPage: Boolean(request.fullPage) }); break;
          case 'run': {
            if (session.unattended) await session.ensureReady(check);
            result = await runTask(session, request.script, signal);
            break;
          }
          case 'flush': result = await session.flush(); break;
          case 'close': reply({ id: request.id ?? null, ok: true, result: { closing: true } }); return;
          default: throw new BrowserControlError('UNKNOWN_OPERATION', 'Supported operations: navigate, inspect, snapshot, select, screenshot, run, flush, close.');
        }
        reply({ id: request.id ?? null, ok: true, result: result ?? null });
      } catch (error) { reply({ id: request?.id ?? null, ok: false, error: errorResult(error) }); }
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    lines.close();
  }
}
