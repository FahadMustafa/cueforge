import { describe, expect, it } from 'vitest';
import { joinMs, splitMs } from './timecode';

describe('splitMs', () => {
  it('splits zero', () => {
    expect(splitMs(0)).toEqual({ hours: 0, minutes: 0, seconds: 0, millis: 0 });
  });

  it('splits a sub-second value', () => {
    expect(splitMs(500)).toEqual({ hours: 0, minutes: 0, seconds: 0, millis: 500 });
  });

  it('splits hours/minutes/seconds/millis', () => {
    // 1h 02m 03s 004ms = 3_723_004 ms
    expect(splitMs(3_723_004)).toEqual({ hours: 1, minutes: 2, seconds: 3, millis: 4 });
  });

  it('supports hour fields above 99', () => {
    expect(splitMs(100 * 3_600_000)).toEqual({ hours: 100, minutes: 0, seconds: 0, millis: 0 });
  });

  it('floors fractional milliseconds', () => {
    expect(splitMs(1.9)).toEqual({ hours: 0, minutes: 0, seconds: 0, millis: 1 });
  });

  it('throws on negative input', () => {
    expect(() => splitMs(-1)).toThrow();
  });
});

describe('joinMs', () => {
  it('recombines components', () => {
    expect(joinMs({ hours: 1, minutes: 2, seconds: 3, millis: 4 })).toBe(3_723_004);
  });

  it('round-trips with splitMs across many values', () => {
    for (const ms of [0, 1, 999, 1000, 59_999, 3_599_999, 3_600_000, 3_723_004, 360_000_000]) {
      expect(joinMs(splitMs(ms))).toBe(ms);
    }
  });
});
