import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Read real playback state in every currently attached frame. Does not play, seek,
// change playbackRate, or fabricate the site's progress/heartbeat requests.
export async function inspectMedia(page) {
  const media = [], errors = [];
  const frames = page.frames();
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const frame = frames[frameIndex];
    try {
      const items = await frame.locator('video,audio').evaluateAll(elements => elements.map((v, index) => ({
        index, tag: v.tagName.toLowerCase(), title: v.title || document.title,
        currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
        duration: Number.isFinite(v.duration) ? v.duration : null,
        paused: v.paused, ended: v.ended, seeking: v.seeking, readyState: v.readyState,
        playbackRate: v.playbackRate, source: v.currentSrc || v.src,
        placeholder: v.tagName === 'AUDIO' && !(v.getAttribute('src') || '').trim() &&
          !Array.from(v.querySelectorAll('source')).some(s => (s.getAttribute('src') || '').trim()),
        width: v.getBoundingClientRect().width, height: v.getBoundingClientRect().height,
        tracks: Array.from(v.textTracks || []).map(t => ({ kind: t.kind, language: t.language, mode: t.mode,
          activeCues: Array.from(t.activeCues || []).map(c => ({ startTime: c.startTime, endTime: c.endTime, text: c.text || '' })) })),
      })));
      media.push(...items.map(item => ({ frameIndex, frameUrl: frame.url(), ...item })));
    } catch (error) { errors.push({ frameIndex, frameUrl: frame.url(), error: String(error.message) }); }
  }
  return { recordedAt: new Date().toISOString(), media, errors };
}

// Sample the actual rendered video and currently available cues while a page is
// playing normally. The caller chooses/starts playback through the observed UI.
// Each JSONL entry records media time, wall time, frame scope, and any omissions.
export async function captureMediaEvidence(page, options) {
  const { outputDir, seconds = 60, intervalSeconds = 10, pollMs = 500, signal, onSample } = options ?? {};
  if (!outputDir) throw new Error('outputDir is required.');
  if (![seconds, intervalSeconds, pollMs].every(Number.isFinite) || seconds <= 0 || intervalSeconds < .1 || pollMs < 50)
    throw new Error('seconds > 0, intervalSeconds >= 0.1 and pollMs >= 50 are required.');
  const directory = path.resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const runId = randomUUID();
  const manifestPath = path.join(directory, `media-${runId}.jsonl`);
  const last = new Map(), frameIds = new WeakMap();
  let nextFrame = 0, samples = 0, images = 0;
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    signal?.throwIfAborted();
    const snapshot = await inspectMedia(page);
    const frames = page.frames();
    const evidence = [];
    for (const item of snapshot.media) {
      const frame = frames[item.frameIndex];
      if (!frame || frame.isDetached() || frame.url() !== item.frameUrl) {
        snapshot.errors.push({ frameIndex: item.frameIndex, error: 'Frame changed after inspection; sample omitted.' });
        continue;
      }
      if (!frameIds.has(frame)) frameIds.set(frame, ++nextFrame);
      const key = `${frameIds.get(frame)}:${item.index}:${item.source}`;
      if (item.placeholder || item.seeking || item.readyState < 2 || item.currentTime <= 0 ||
          (last.has(key) && item.currentTime - last.get(key) < intervalSeconds)) continue;
      const record = { ...item, image: null };
      if (item.tag === 'video' && item.width > 0 && item.height > 0) {
        const file = `video-${runId}-${String(images + 1).padStart(5, '0')}.jpg`;
        try {
          const element = frame.locator('video,audio').nth(item.index);
          await element.screenshot({ path: path.join(directory, file), type: 'jpeg', quality: 80, timeout: 3000 });
          record.image = file; images++;
        } catch (error) { record.imageError = String(error.message); }
      }
      last.set(key, item.currentTime);
      evidence.push(record);
    }
    if (evidence.length || snapshot.errors.length) {
      const sample = { recordedAt: snapshot.recordedAt, evidence, errors: snapshot.errors };
      await appendFile(manifestPath, `${JSON.stringify(sample)}\n`, 'utf8'); samples++;
      if (onSample) await onSample(sample);
    }
    const playable = snapshot.media.filter(item => !item.placeholder);
    if (playable.length && playable.every(item => item.ended)) break;
    const remaining = seconds * 1000 - (Date.now() - started);
    if (remaining > 0) await delay(Math.min(pollMs, remaining), undefined, { signal });
  }
  return { manifestPath, samples, images, elapsedSeconds: (Date.now() - started) / 1000 };
}
