// Event coalescing is expected in Ink. Completion counts actual writes, not matches.
export const distinctFrameCount = frames => new Set(frames.map(frame => frame.frameId)).size;
export async function waitForDistinctFrames(frames, { target = 16, timeoutMs = 5000, pollMs = 10 } = {}) {
  const until = performance.now() + timeoutMs;
  while (distinctFrameCount(frames) < target && performance.now() < until) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  if (distinctFrameCount(frames) < target) throw new Error(`need ${target} distinct streamed frames; got ${distinctFrameCount(frames)}`);
}
// Rendering can drain more than one pending write between producer checks. Measure
// the first target actual writes, retaining every event coalesced into those writes.
export function selectFrameSamples(frames, target = 16) {
  const ids = new Set();
  for (const frame of frames) {
    ids.add(frame.frameId);
    if (ids.size === target) break;
  }
  if (ids.size < target) throw new Error(`need ${target} distinct streamed frames; got ${ids.size}`);
  return frames.filter(frame => ids.has(frame.frameId));
}
