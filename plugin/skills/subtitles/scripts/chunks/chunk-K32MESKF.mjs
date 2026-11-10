import {
  frameToMs,
  frameToTimecode,
  msToFrame
} from "./chunk-RCR4PM7R.mjs";

// src/core/timing/timecode.ts
var DROP_FRAME_FPS = 29.97;
function supportsDropFrame(fps) {
  return fps === DROP_FRAME_FPS;
}
function isDropFrameFamily(fps) {
  return Math.abs(fps - DROP_FRAME_FPS) < 1e-3;
}
var EXACT_FPS = {
  23.976: 24e3 / 1001,
  24: 24,
  25: 25,
  29.97: 3e4 / 1001,
  30: 30
};
var NOMINAL_FPS = {
  23.976: 24,
  24: 24,
  25: 25,
  29.97: 30,
  30: 30
};
function msToFrameGeneral(ms, fps) {
  if (fps === DROP_FRAME_FPS) return msToFrame(ms);
  const exact = EXACT_FPS[fps] ?? fps;
  return Math.round(ms * exact / 1e3);
}
function durationFrames(ms, fps) {
  return msToFrameGeneral(ms, fps);
}
var pad = (n) => String(n).padStart(2, "0");
function msToTimecode(ms, fps, dropFrame) {
  if (fps === DROP_FRAME_FPS) {
    return frameToTimecode(msToFrame(ms), dropFrame);
  }
  const nominal = NOMINAL_FPS[fps] ?? Math.round(fps);
  const frame = msToFrameGeneral(ms, fps);
  const ff = frame % nominal;
  const totalSeconds = Math.floor(frame / nominal);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
}
function dropFrameTimecodeToMs(h, m, s, f) {
  const totalMinutes = h * 60 + m;
  const dropped = 2 * (totalMinutes - Math.floor(totalMinutes / 10));
  const frame = (totalMinutes * 60 + s) * 30 + f - dropped;
  return frameToMs(frame);
}

export {
  DROP_FRAME_FPS,
  supportsDropFrame,
  isDropFrameFamily,
  durationFrames,
  msToTimecode,
  dropFrameTimecodeToMs
};
