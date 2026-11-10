import { describe, expect, it } from 'vitest';
import {
  DROP_FRAME_FPS,
  durationFrames,
  frameDurationMs,
  frameToMsGeneral,
  isDropFrameFamily,
  msToFrameGeneral,
  msToTimecode,
  stepFrame,
  supportsDropFrame,
} from './timecode';
import { frameToMs, frameToTimecode, msToFrame } from '../formats/scc/cea608';

describe('supportsDropFrame', () => {
  it('is true only for 29.97', () => {
    expect(DROP_FRAME_FPS).toBe(29.97);
    expect(supportsDropFrame(29.97)).toBe(true);
    expect(supportsDropFrame(30)).toBe(false);
    expect(supportsDropFrame(23.976)).toBe(false);
  });
});

describe('isDropFrameFamily', () => {
  it('accepts the canonical 29.97 label and the exact 30000/1001 rate', () => {
    expect(isDropFrameFamily(29.97)).toBe(true);
    expect(isDropFrameFamily(30000 / 1001)).toBe(true);
  });

  it('rejects the other standard rates', () => {
    for (const fps of [23.976, 24, 25, 30, 24000 / 1001]) {
      expect(isDropFrameFamily(fps)).toBe(false);
    }
  });

  it('does not widen supportsDropFrame (the exact rate still reads non-drop)', () => {
    expect(supportsDropFrame(30000 / 1001)).toBe(false);
  });
});

describe('frameDurationMs', () => {
  it('uses the exact timebase per fps', () => {
    expect(frameDurationMs(25)).toBe(40);
    expect(frameDurationMs(24)).toBeCloseTo(41.6667, 3);
    expect(frameDurationMs(30)).toBeCloseTo(33.3333, 3);
    expect(frameDurationMs(23.976)).toBeCloseTo(41.7083, 3); // 1001/24
    expect(frameDurationMs(29.97)).toBeCloseTo(33.3667, 3); // 1001/30
  });
});

describe('msToFrameGeneral / frameToMsGeneral', () => {
  it('round-trips frames for 24/25/30 and 23.976', () => {
    expect(msToFrameGeneral(1000, 25)).toBe(25);
    expect(frameToMsGeneral(26, 25)).toBe(1040);
    expect(msToFrameGeneral(1000, 24)).toBe(24);
    expect(frameToMsGeneral(24, 24)).toBe(1000);
    expect(msToFrameGeneral(2000, 30)).toBe(60);
    expect(frameToMsGeneral(60, 30)).toBe(2000);
    expect(msToFrameGeneral(1001, 23.976)).toBe(24);
    expect(frameToMsGeneral(24, 23.976)).toBe(1001);
  });

  it('matches the SCC 30000/1001 mapping for 29.97', () => {
    for (const ms of [0, 500, 1001, 60000, 3600000]) {
      expect(msToFrameGeneral(ms, 29.97)).toBe(msToFrame(ms));
    }
    for (const frame of [0, 15, 30, 1798, 17982]) {
      expect(frameToMsGeneral(frame, 29.97)).toBe(frameToMs(frame));
    }
  });
});

describe('durationFrames', () => {
  it('counts whole frames spanned by a duration', () => {
    expect(durationFrames(0, 25)).toBe(0);
    expect(durationFrames(1000, 25)).toBe(25);
    expect(durationFrames(40, 25)).toBe(1);
    expect(durationFrames(833, 24)).toBe(20); // Netflix 833ms min ~= 20 frames @ 24
    expect(durationFrames(833, 25)).toBe(21); // 20.825 rounds up at 25
  });

  it('uses the SCC 30000/1001 mapping for 29.97', () => {
    for (const ms of [0, 500, 1001, 83]) {
      expect(durationFrames(ms, 29.97)).toBe(msToFrame(ms));
    }
  });
});

describe('stepFrame', () => {
  it('moves exactly one frame and clamps at 0 (25fps)', () => {
    expect(stepFrame(1000, 25, false, 1)).toBe(1040); // frame 25 -> 26
    expect(stepFrame(1000, 25, false, -1)).toBe(960); // frame 25 -> 24
    expect(stepFrame(0, 25, false, -1)).toBe(0); // clamp
  });

  it('steps 29.97 via the SCC mapping, independent of drop-frame', () => {
    expect(stepFrame(1001, 29.97, false, 1)).toBe(stepFrame(1001, 29.97, true, 1));
    expect(stepFrame(1001, 29.97, true, 1)).toBe(frameToMs(31)); // frame 30 -> 31
  });
});

describe('msToTimecode', () => {
  it('formats non-drop timecode for 24/25/30', () => {
    expect(msToTimecode(1000, 25, false)).toBe('00:00:01:00');
    expect(msToTimecode(1040, 25, false)).toBe('00:00:01:01');
    expect(msToTimecode(3661000, 30, false)).toBe('01:01:01:00');
    expect(msToTimecode(0, 24, false)).toBe('00:00:00:00');
  });

  it('delegates 29.97 to the SCC formatter (drop-frame uses ;)', () => {
    expect(msToTimecode(1001, 29.97, true)).toBe(frameToTimecode(msToFrame(1001), true));
    expect(msToTimecode(1001, 29.97, true)).toBe('00:00:01;00');
    expect(msToTimecode(1001, 29.97, false)).toBe('00:00:01:00');
  });
});
