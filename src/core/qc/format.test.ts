import { describe, expect, it } from 'vitest';
import type { SubtitleDocument } from '../model/types';
import { docDropFrame, durationLabel, positionLabelFor } from './format';

const NTSC_FPS = 30000 / 1001;

/** A minimal doc with the given frame rate and (optionally) raw metadata. */
const docWith = (
  frameRate?: number,
  raw?: Record<string, unknown>,
): Pick<SubtitleDocument, 'metadata'> => ({
  metadata: { sourceFormat: 'scc', frameRate, raw },
});

describe('positionLabelFor', () => {
  it('renders timecode with ms secondary when the doc declares fps', () => {
    const label = positionLabelFor(docWith(25));
    expect(label(5000)).toBe('00:00:05:00 (5000 ms)');
    expect(label(1040)).toBe('00:00:01:01 (1040 ms)');
  });

  it('auto-derives drop-frame for 29.97', () => {
    expect(positionLabelFor(docWith(29.97))(1001)).toBe('00:00:01;00 (1001 ms)');
  });

  it('falls back to plain ms when the doc has no fps', () => {
    expect(positionLabelFor(docWith())(5003)).toBe('5003 ms');
    expect(positionLabelFor(docWith(undefined))(5003)).toBe('5003 ms');
    expect(positionLabelFor(docWith(undefined, { dropFrame: true }))(5003)).toBe('5003 ms');
  });

  describe('explicit drop-frame mode from the document (cue-forge-w28.9)', () => {
    it('renders non-drop (colon, no skipped numbers) when the doc declares NDF at 29.97', () => {
      // Frame 1800 = NDF 00:01:00:00 but DF 00:01:00;02 — the case where they diverge.
      const label = positionLabelFor(docWith(29.97, { dropFrame: false }));
      expect(label(60060)).toBe('00:01:00:00 (60060 ms)');
      expect(label(1001)).toBe('00:00:01:00 (1001 ms)');
    });

    it('renders drop-frame when the doc declares DF at 29.97', () => {
      expect(positionLabelFor(docWith(29.97, { dropFrame: true }))(60060)).toBe(
        '00:01:00;02 (60060 ms)',
      );
    });

    it('honours the mode at the exact 30000/1001 rate (what the SCC parser records)', () => {
      expect(positionLabelFor(docWith(NTSC_FPS, { dropFrame: false }))(60060)).toBe(
        '00:01:00:00 (60060 ms)',
      );
      expect(positionLabelFor(docWith(NTSC_FPS, { dropFrame: true }))(60060)).toBe(
        '00:01:00;02 (60060 ms)',
      );
    });

    it('keeps the current convention when the mode is unknown', () => {
      // Canonical 29.97 label: drop-frame, as before.
      expect(positionLabelFor(docWith(29.97))(60060)).toBe('00:01:00;02 (60060 ms)');
      expect(positionLabelFor(docWith(29.97, {}))(60060)).toBe('00:01:00;02 (60060 ms)');
      // Exact 30000/1001: non-drop at nominal 30, as before.
      expect(positionLabelFor(docWith(NTSC_FPS))(60060)).toBe('00:01:00:00 (60060 ms)');
    });

    it('ignores the mode at non-29.97 rates', () => {
      expect(positionLabelFor(docWith(25, { dropFrame: true }))(1040)).toBe(
        '00:00:01:01 (1040 ms)',
      );
      expect(positionLabelFor(docWith(25, { dropFrame: false }))(1040)).toBe(
        '00:00:01:01 (1040 ms)',
      );
      expect(positionLabelFor(docWith(24, { dropFrame: true }))(1000)).toBe(
        '00:00:01:00 (1000 ms)',
      );
      expect(positionLabelFor(docWith(30, { dropFrame: true }))(2000)).toBe(
        '00:00:02:00 (2000 ms)',
      );
    });
  });
});

describe('durationLabel', () => {
  it('renders frames with ms secondary when fps is known', () => {
    expect(durationLabel(833, 24)).toBe('20 frames (833 ms)');
    expect(durationLabel(0, 25)).toBe('0 frames (0 ms)');
  });

  it('uses the singular "frame" for exactly one frame', () => {
    expect(durationLabel(40, 25)).toBe('1 frame (40 ms)');
  });

  it('falls back to plain ms when fps is unknown', () => {
    expect(durationLabel(833)).toBe('833 ms');
    expect(durationLabel(833, undefined)).toBe('833 ms');
  });
});

describe('docDropFrame', () => {
  const sccDoc = (raw?: Record<string, unknown>): SubtitleDocument => ({
    cues: [],
    metadata: { sourceFormat: 'scc', frameRate: NTSC_FPS, raw },
    warnings: [],
  });

  it('reads the SCC parser’s explicit boolean', () => {
    expect(docDropFrame(sccDoc({ dropFrame: false }))).toBe(false);
    expect(docDropFrame(sccDoc({ dropFrame: true }))).toBe(true);
  });

  it('is undefined when the source recorded no drop-frame mode', () => {
    expect(docDropFrame(sccDoc())).toBeUndefined();
    expect(docDropFrame(sccDoc({}))).toBeUndefined();
    expect(docDropFrame(sccDoc({ header: 'Scenarist_SCC V1.0' }))).toBeUndefined();
  });

  it('ignores a non-boolean dropFrame value', () => {
    expect(docDropFrame(sccDoc({ dropFrame: 'yes' }))).toBeUndefined();
    expect(docDropFrame(sccDoc({ dropFrame: 1 }))).toBeUndefined();
  });
});
