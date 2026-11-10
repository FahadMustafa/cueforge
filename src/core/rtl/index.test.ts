import { describe, expect, it } from 'vitest';
import {
  ALM,
  LRM,
  RLM,
  TATWEEL,
  convertDigits,
  digitStyle,
  hasRtl,
  isCombiningMark,
  isLatinLetter,
  isRtl,
  isTatweel,
  stripTatweel,
  visibleLength,
} from './index';

const cp = (ch: string): number => ch.codePointAt(0)!;

describe('bidi marks', () => {
  it('exposes the bidi control characters by code point', () => {
    expect(RLM).toBe('‏');
    expect(LRM).toBe('‎');
    expect(ALM).toBe('؜');
    expect(TATWEEL).toBe('ـ');
  });
});

describe('isRtl', () => {
  it.each([
    ['Arabic letter', cp('م'), true],
    ['Hebrew letter', cp('א'), true],
    ['Persian letter (Arabic script)', cp('پ'), true],
    ['Thaana letter', cp('ހ'), true],
    ['Latin letter', cp('A'), false],
    ['Western digit', cp('5'), false],
    ['space', cp(' '), false],
    ['period', cp('.'), false],
  ])('%s', (_label, code, expected) => {
    expect(isRtl(code)).toBe(expected);
  });
});

describe('hasRtl', () => {
  it('is true when any strong RTL character is present', () => {
    expect(hasRtl('Hello مرحبا')).toBe(true);
    expect(hasRtl('שלום')).toBe(true);
  });
  it('is false for pure Latin/neutral text', () => {
    expect(hasRtl('Hello world 123!')).toBe(false);
    expect(hasRtl('')).toBe(false);
  });
});

describe('isLatinLetter', () => {
  it.each([
    [cp('A'), true],
    [cp('z'), true],
    [cp('é'), true],
    [cp('م'), false],
    [cp('5'), false],
    [cp('.'), false],
  ])('%i -> %s', (code, expected) => {
    expect(isLatinLetter(code)).toBe(expected);
  });
});

describe('isCombiningMark (zero-width diacritics)', () => {
  it.each([
    ['fatha', cp('َ'), true],
    ['kasra', cp('ِ'), true],
    ['shadda', cp('ّ'), true],
    ['superscript alef', cp('ٰ'), true],
    ['Hebrew point', cp('ְ'), true],
    ['Arabic letter', cp('م'), false],
    ['Latin letter', cp('A'), false],
    ['tatweel (a spacing char)', cp(TATWEEL), false],
  ])('%s', (_label, code, expected) => {
    expect(isCombiningMark(code)).toBe(expected);
  });
});

describe('visibleLength', () => {
  it('counts code points', () => {
    expect(visibleLength('abc')).toBe(3);
  });
  it('counts a surrogate-pair character as one', () => {
    expect(visibleLength('😀')).toBe(1);
  });
  it('treats Arabic diacritics as zero-width', () => {
    // "مَدْرَسَة" — base letters م د ر س ة (5) plus 4 harakat that must not count.
    expect(visibleLength('مَدْرَسَة')).toBe(5);
  });
  it('treats bidi control marks as zero-width', () => {
    expect(visibleLength(`ab${RLM}c${LRM}`)).toBe(3);
  });
});

describe('isTatweel / stripTatweel', () => {
  it('detects the tatweel code point', () => {
    expect(isTatweel(cp(TATWEEL))).toBe(true);
    expect(isTatweel(cp('م'))).toBe(false);
  });
  it('removes tatweel padding without touching other characters', () => {
    expect(stripTatweel('كـــتاب')).toBe('كتاب');
    expect(stripTatweel('plain')).toBe('plain');
  });
});

describe('digitStyle', () => {
  it.each([
    ['western 0-9', cp('5'), 'western'],
    ['arabic-indic ٠-٩', cp('٥'), 'arabic-indic'],
    ['extended arabic-indic (Persian) ۰-۹', cp('۵'), 'extended-arabic-indic'],
    ['non-digit', cp('م'), null],
    ['letter', cp('A'), null],
  ])('%s', (_label, code, expected) => {
    expect(digitStyle(code)).toBe(expected);
  });
});

describe('convertDigits', () => {
  it('normalizes mixed digits to western, preserving value and non-digits', () => {
    expect(convertDigits('سنة ٢٠٢٤ م', 'western')).toBe('سنة 2024 م');
  });
  it('normalizes to arabic-indic', () => {
    expect(convertDigits('Room 12', 'arabic-indic')).toBe('Room ١٢');
  });
  it('normalizes to extended arabic-indic', () => {
    expect(convertDigits('12', 'extended-arabic-indic')).toBe('۱۲');
  });
  it('leaves text with no digits unchanged', () => {
    expect(convertDigits('مرحبا', 'western')).toBe('مرحبا');
  });
});
