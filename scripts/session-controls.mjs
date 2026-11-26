import path from 'node:path';
import os from 'node:os';

export class BrowserControlError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BrowserControlError';
    this.code = code;
    this.details = details;
  }
}

export function stateDirectory(override) {
  return path.resolve(override ?? process.env.BROWSER_DEBUGGER_STATE_DIR ?? (
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Codex', 'browser-debugger')
      : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'browser-debugger')
  ));
}

export function profileDirectory({ profileDir, profileName, stateDir, workDir, browser }) {
  if (profileDir !== undefined && profileName !== undefined) {
    throw new BrowserControlError('INVALID_OPTIONS', 'Use profileDir or profileName, not both.');
  }
  if (profileName !== undefined) {
    if (typeof profileName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profileName)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(profileName)) {
      throw new BrowserControlError('INVALID_PROFILE_NAME', 'profileName must contain 1-64 letters, digits, underscores or hyphens and cannot be a reserved device name.');
    }
    return path.join(stateDirectory(stateDir), 'profiles', browser, profileName);
  }
  return path.resolve(profileDir ?? path.join(workDir, `profile-${browser}`));
}

export function selectPage(pages, targetUrl) {
  const live = pages.filter(page => !page.isClosed());
  const candidates = targetUrl === undefined
    ? live.filter(page => /^https?:/i.test(page.url()))
    : live.filter(page => page.url() === new URL(targetUrl).href);
  const matches = targetUrl === undefined && !candidates.length ? live : candidates;
  if (matches.length === 1) return matches[0];
  throw new BrowserControlError(matches.length ? 'AMBIGUOUS_PAGE' : 'TARGET_NOT_FOUND',
    matches.length ? 'Multiple tabs match. Specify the exact targetUrl before operating.' : 'No matching tab exists.',
    { candidateCount: matches.length });
}

async function visibleMatch(page, selector) {
  const matches = page.locator(selector);
  const count = await matches.count();
  for (let index = 0; index < count; index++) if (await matches.nth(index).isVisible()) return true;
  return false;
}

// Passive checks only: never enter credentials, solve a challenge or dismiss a warning.
export async function inspectPage(page, options = {}) {
  const result = { state: 'observed', ready: null, url: page.url(), title: await page.title(), evidence: [] };
  const blocked = (code, evidence, manualActionRequired) => ({
    ...result, state: 'blocked', ready: false, code, manualActionRequired, evidence: [evidence],
  });
  if (options.blockedSelector && await visibleMatch(page, options.blockedSelector)) {
    return blocked('ACCESS_BLOCKED', `Visible blockedSelector: ${options.blockedSelector}`, false);
  }
  if (options.loginSelector && await visibleMatch(page, options.loginSelector)) {
    return blocked('LOGIN_REQUIRED', `Visible loginSelector: ${options.loginSelector}`, true);
  }
  if (/^(chrome|edge)-error:/.test(result.url)) {
    return blocked('BROWSER_ERROR', 'The browser is displaying an error page.', true);
  }
  let incompleteFrames = 0;
  for (const frame of page.frames()) {
    try {
      if (frame !== page.mainFrame() && !await (await frame.frameElement()).isVisible()) continue;
      const signals = await frame.evaluate(() => {
        const visible = element => {
          const style = getComputedStyle(element), box = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
        };
        const fields = [...document.querySelectorAll('input')].filter(visible);
        return {
          text: (document.body?.innerText ?? '').slice(0, 50000),
          heading: document.querySelector('h1')?.innerText ?? '',
          loginFields: fields.some(field => field.type === 'password' || /username|tel|one-time-code/.test(field.autocomplete) || field.type === 'tel' || /login|user|sms|phone|mobile/i.test(field.id)),
          challengeVisible: [...document.querySelectorAll('iframe[src*="hcaptcha.com"], iframe[src*="recaptcha"][title*="challenge"], [id="challenge-running"]')].some(visible),
        };
      });
      if ((/非法访问/.test(signals.text) && /正常浏览器/.test(signals.text))
        || /^(access denied|request blocked|forbidden)$/i.test(signals.heading.trim())) {
        return blocked('ACCESS_BLOCKED', 'The visible page reports that access is blocked.', false);
      }
      if (signals.challengeVisible || /^(verify you are human|验证您是真人|安全验证)$/i.test(signals.heading.trim())
        || /^(just a moment|attention required)/i.test(result.title)) {
        return blocked('VERIFICATION_REQUIRED', 'A visible verification challenge is present.', true);
      }
      if (/\/(?:mini_)?(?:login|signin|sign-in)(?:[./?_-]|$)/i.test(frame.url()) && signals.loginFields) {
        return blocked('LOGIN_REQUIRED', 'A visible sign-in page contains authentication fields.', true);
      }
    } catch { incompleteFrames++; }
  }
  const conditions = [];
  if (options.readySelector) conditions.push({ type: 'selector', matched: await visibleMatch(page, options.readySelector) });
  if (options.readyText) conditions.push({ type: 'text', matched: await page.getByText(options.readyText, { exact: true }).filter({ visible: true }).count() > 0 });
  if (conditions.length) {
    result.ready = conditions.every(condition => condition.matched);
    result.state = result.ready ? 'ready' : 'not_ready';
    result.code = result.ready ? undefined : 'READY_CONDITION_MISSING';
    result.evidence = conditions;
  }
  if (incompleteFrames) {
    result.incompleteFrames = incompleteFrames;
    result.state = 'uncertain';
    result.ready = false;
    result.code = 'FRAME_INSPECTION_INCOMPLETE';
  }
  return result;
}

export async function ensurePageReady(page, options = {}) {
  if (options.readyTimeoutMs !== undefined && (!Number.isInteger(options.readyTimeoutMs) || options.readyTimeoutMs < 1 || options.readyTimeoutMs > 60000)) {
    throw new BrowserControlError('INVALID_OPTIONS', 'readyTimeoutMs must be an integer between 1 and 60000.');
  }
  let status = await inspectPage(page, options);
  if (status.state === 'not_ready') {
    const timeout = options.readyTimeoutMs ?? 10000;
    const waits = [];
    if (options.readySelector) waits.push(page.locator(options.readySelector).filter({ visible: true }).first().waitFor({ state: 'visible', timeout }));
    if (options.readyText) waits.push(page.getByText(options.readyText, { exact: true }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout }));
    await Promise.allSettled(waits);
    status = await inspectPage(page, options);
  }
  if (status.state === 'blocked' || status.state === 'not_ready' || status.state === 'uncertain') {
    throw new BrowserControlError(status.code, `Unattended operation stopped: ${status.code}.`, status);
  }
  return status;
}
