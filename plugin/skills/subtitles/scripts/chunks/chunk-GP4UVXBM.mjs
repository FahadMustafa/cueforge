// src/core/timing/timing.ts
var STANDARD_FPS = [23.976, 24, 25, 29.97, 30];
function canonicalFps(fps) {
  for (const std of STANDARD_FPS) {
    if (Math.abs(fps - std) < 0.02) return std;
  }
  return fps;
}
var clamp0 = (ms) => {
  if (!Number.isFinite(ms)) {
    throw new RangeError("Resulting cue times are out of range. Choose a smaller timing change.");
  }
  return ms < 0 ? 0 : ms;
};
function mapCueTimes(doc, fn) {
  const cues = doc.cues.map((cue) => {
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.endMs < cue.startMs) {
      throw new RangeError("Cue times must be finite, with the end at or after the start.");
    }
    const startMs = fn(cue.startMs);
    const endMs = fn(cue.endMs);
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs < startMs) {
      throw new RangeError("Resulting cue times are out of range. Choose a smaller timing change.");
    }
    return { ...cue, startMs, endMs };
  });
  return { ...doc, cues };
}
function shiftCues(doc, offsetMs) {
  if (!Number.isFinite(offsetMs)) {
    throw new RangeError("The shift offset must be a finite number of milliseconds.");
  }
  return mapCueTimes(doc, (ms) => clamp0(Math.round(ms + offsetMs)));
}

export {
  canonicalFps,
  shiftCues
};
