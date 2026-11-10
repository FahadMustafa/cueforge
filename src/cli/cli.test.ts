import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importFile } from '../app/session/session';
import { nodeIo, run, type QcJsonReport } from './cli';

const FIXTURES = resolve(__dirname, '../../fixtures');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cueforge-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    args,
    nodeIo(
      (line) => out.push(line),
      (line) => err.push(line),
    ),
  );
  return { code, out, err };
}

/** Copy a fixture into the temp dir so default output paths land there. */
async function fixture(rel: string): Promise<string> {
  const dest = join(dir, basename(rel));
  await copyFile(join(FIXTURES, rel), dest);
  return dest;
}

async function write(name: string, text: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, text);
  return path;
}

async function cueCount(path: string): Promise<number> {
  const loaded = await importFile(basename(path), await readFile(path), { allowPro: true });
  return loaded.doc.cues.length;
}

const OVERLAP_SRT = `1
00:00:01,000 --> 00:00:04,000
First cue

2
00:00:03,000 --> 00:00:05,000
Second cue
`;

/** typical fixture per readable format (imsc files are read as TTML). */
const READABLE = [
  'srt/typical.srt',
  'vtt/typical.vtt',
  'sbv/typical.sbv',
  'ass/typical.ass',
  'ttml/typical.ttml',
  'imsc/typical.ttml',
  'scc/typical.scc',
  'stl/typical.stl',
  'itt/typical.itt',
  'mcc/typical.mcc',
  'ebuttd/typical.xml',
];

const WRITABLE: [id: string, ext: string][] = [
  ['srt', '.srt'],
  ['vtt', '.vtt'],
  ['sbv', '.sbv'],
  ['ass', '.ass'],
  ['ttml', '.ttml'],
  ['scc', '.scc'],
  ['stl', '.stl'],
  ['itt', '.itt'],
  ['imsc101', '.ttml'],
  ['imsc11', '.ttml'],
  ['mcc', '.mcc'],
  ['ebuttd', '.xml'],
];

describe('convert', () => {
  it.each(READABLE)('reads %s and writes srt with the same cue count', async (rel) => {
    const input = await fixture(rel);
    const out = join(dir, 'out.srt');
    const r = await cli('convert', input, '--to', 'srt', '-o', out);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(r.out).toEqual([out]);
    expect(await cueCount(out)).toBe(await cueCount(input));
  });

  it.each(WRITABLE)('writes %s next to the input', async (id, ext) => {
    // srt → srt would target the input itself, so that row starts from vtt.
    const input = await fixture(id === 'srt' ? 'vtt/typical.vtt' : 'srt/typical.srt');
    const r = await cli('convert', input, '--to', id);
    const expected = join(dir, `typical${ext}`);
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(r.out).toEqual([expected]);
    expect(await cueCount(expected)).toBe(await cueCount(input));
  });

  it('round-trips EBU-STL bytes through srt and back', async () => {
    const input = await fixture('stl/typical.stl');
    const srt = join(dir, 'mid.srt');
    const back = join(dir, 'back.stl');
    expect((await cli('convert', input, '--to', 'srt', '-o', srt)).code).toBe(0);
    expect((await cli('convert', srt, '--to', 'stl', '-o', back)).code).toBe(0);
    const bytes = await readFile(back);
    expect(bytes.subarray(3, 11).toString('latin1')).toMatch(/^STL\d\d\.01$/);
    const original = await importFile('a.stl', await readFile(input), { allowPro: true });
    const roundTripped = await importFile('b.stl', bytes, { allowPro: true });
    expect(roundTripped.doc.cues.map((c) => [c.startMs, c.endMs])).toEqual(
      original.doc.cues.map((c) => [c.startMs, c.endMs]),
    );
  });

  it('reports conversion losses on stderr', async () => {
    const input = await fixture('srt/typical.srt');
    const r = await cli('convert', input, '--to', 'sbv');
    expect(r.code).toBe(0);
    expect(r.err.length).toBeGreaterThan(0);
    expect(r.err.every((l) => l.startsWith('warning: '))).toBe(true);
  });

  it('refuses to overwrite an existing file without --force', async () => {
    const input = await fixture('srt/typical.srt');
    const target = await write('typical.vtt', 'keep me');
    const r = await cli('convert', input, '--to', 'vtt');
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/already exists.*--force/);
    expect(await readFile(target, 'utf8')).toBe('keep me');

    const forced = await cli('convert', input, '--to', 'vtt', '--force');
    expect(forced.code).toBe(0);
    expect(await readFile(target, 'utf8')).toMatch(/^WEBVTT/);
  });

  it('rejects an unknown target format', async () => {
    const input = await fixture('srt/typical.srt');
    const r = await cli('convert', input, '--to', 'docx');
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/Unknown format "docx"/);
  });

  it('fails when the target charset cannot represent the text', async () => {
    const input = await fixture('srt/arabic.srt');
    const r = await cli('convert', input, '--to', 'scc');
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/cannot represent/);
  });
});

describe('qc', () => {
  it('prints a JSON report with the documented shape', async () => {
    const input = await write('overlap.srt', OVERLAP_SRT);
    const r = await cli('qc', input, '--json');
    expect(r.code).toBe(1);
    expect(r.out).toHaveLength(1);
    const report = JSON.parse(r.out[0]!) as QcJsonReport;
    expect(report).toEqual({
      file: input,
      format: 'srt',
      preset: 'generic',
      presetBuiltin: true,
      presetVerified: false,
      cueCount: 2,
      counts: { error: 1, warning: report.counts.warning },
      issues: expect.any(Array) as unknown,
    });
    expect(Object.keys(report)).toEqual([
      'file',
      'format',
      'preset',
      'presetBuiltin',
      'presetVerified',
      'cueCount',
      'counts',
      'issues',
    ]);
    const overlap = report.issues.find((i) => i.ruleId === 'overlap');
    expect(overlap).toEqual({
      ruleId: 'overlap',
      cueIndex: expect.any(Number) as unknown,
      severity: 'error',
      message: expect.any(String) as unknown,
      fixable: true,
    });
    for (const issue of report.issues) {
      expect(Object.keys(issue)).toEqual(['ruleId', 'cueIndex', 'severity', 'message', 'fixable']);
    }
  });

  it('exits 0 on a clean file and prints a human summary', async () => {
    const input = await fixture('srt/minimal.srt');
    const r = await cli('qc', input);
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/0 errors, 0 warnings/);
  });

  it('exits 1 and lists issues when an error-severity issue is found', async () => {
    const input = await write('overlap.srt', OVERLAP_SRT);
    const r = await cli('qc', input);
    expect(r.code).toBe(1);
    expect(r.out.join('\n')).toMatch(/error\s+overlap/);
  });

  it('runs a named built-in preset', async () => {
    const input = await fixture('srt/minimal.srt');
    const r = await cli('qc', input, '--preset', 'netflix-latin', '--json');
    const report = JSON.parse(r.out[0]!) as QcJsonReport;
    expect(report.preset).toBe('netflix-latin');
    expect(report.presetBuiltin).toBe(true);
    expect(report.presetVerified).toBe(true);
    const human = await cli('qc', input, '--preset', 'netflix-latin');
    expect(human.out[0]).toContain(', preset netflix-latin (Verified): ');
  });

  it('never lets a ruleset file pass as a built-in or Verified preset', async () => {
    const input = await fixture('srt/minimal.srt');
    const ruleset = await write(
      'rules.json',
      JSON.stringify({ name: 'netflix-latin', verified: true, rules: {} }),
    );
    const r = await cli('qc', input, '--preset', ruleset, '--json');
    const report = JSON.parse(r.out[0]!) as QcJsonReport;
    expect(report.preset).toBe('netflix-latin');
    expect(report.presetBuiltin).toBe(false);
    expect(report.presetVerified).toBe(false);
    const human = await cli('qc', input, '--preset', ruleset);
    expect(human.out[0]).toContain(`custom preset "netflix-latin" from ${ruleset} (Draft): `);
  });

  it('runs a custom ruleset file', async () => {
    const input = await fixture('srt/minimal.srt');
    const ruleset = await write(
      'strict.json',
      JSON.stringify({
        name: 'tiny-lines',
        verified: false,
        rules: { 'max-chars-per-line': { enabled: true, severity: 'error', max: 5 } },
      }),
    );
    const r = await cli('qc', input, '--preset', ruleset, '--json');
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out[0]!) as QcJsonReport;
    expect(report.preset).toBe('tiny-lines');
    expect(report.issues.every((i) => i.ruleId === 'max-chars-per-line')).toBe(true);
    expect(report.counts.error).toBeGreaterThan(0);
  });

  it('fails loud on an invalid ruleset', async () => {
    const input = await fixture('srt/minimal.srt');
    const ruleset = await write(
      'bad.json',
      JSON.stringify({ name: 'bad', verified: 'yes', rules: { nope: {} } }),
    );
    const r = await cli('qc', input, '--preset', ruleset);
    expect(r.code).toBe(2);
    const err = r.err.join('\n');
    expect(err).toMatch(/verified must be a boolean/);
    expect(err).toMatch(/unknown rule id: nope/);
  });

  it('fails on a ruleset that is not JSON', async () => {
    const input = await fixture('srt/minimal.srt');
    const ruleset = await write('bad.json', '{ nope');
    const r = await cli('qc', input, '--preset', ruleset);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/Invalid ruleset/);
  });

  it('fails on an unknown preset name', async () => {
    const input = await fixture('srt/minimal.srt');
    const r = await cli('qc', input, '--preset', 'hbo');
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/Unknown preset "hbo"/);
  });
});

describe('fix', () => {
  it('writes <name>.fixed.<ext>, reports counts, and leaves the input untouched', async () => {
    const input = await write('overlap.srt', OVERLAP_SRT);
    const r = await cli('fix', input);
    const output = join(dir, 'overlap.fixed.srt');
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(r.out[0]).toBe(output);
    expect(r.out[1]).toMatch(/^Resolved [1-9]\d* issues?, \d+ remaining/);
    expect(await readFile(input, 'utf8')).toBe(OVERLAP_SRT);
    const after = await cli('qc', output, '--json');
    expect((JSON.parse(after.out[0]!) as QcJsonReport).counts.error).toBe(0);
  });

  it('writes binary STL back as STL', async () => {
    const input = await fixture('stl/typical.stl');
    const r = await cli('fix', input, '-o', join(dir, 'out.stl'));
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(await cueCount(join(dir, 'out.stl'))).toBeGreaterThan(0);
  });
});

describe('shift', () => {
  it.each([
    ['500', 1500],
    ['-500', 500],
    ['+250', 1250],
  ])('shifts by %s ms', async (ms, firstStart) => {
    const input = await fixture('srt/minimal.srt');
    const r = await cli('shift', input, '--ms', ms);
    const output = join(dir, 'minimal.shifted.srt');
    expect(r.code, r.err.join('\n')).toBe(0);
    expect(r.out).toEqual([output]);
    const loaded = await importFile('x.srt', await readFile(output), { allowPro: true });
    expect(loaded.doc.cues[0]!.startMs).toBe(firstStart);
  });

  it('accepts --ms=-500', async () => {
    const input = await fixture('srt/minimal.srt');
    expect((await cli('shift', input, '--ms=-500')).code).toBe(0);
  });

  it('warns when cues are clamped at zero', async () => {
    const input = await fixture('srt/minimal.srt');
    const r = await cli('shift', input, '--ms', '-2000');
    expect(r.code).toBe(0);
    expect(r.err.join('\n')).toMatch(/clamped/);
  });

  it('rejects a non-integer offset', async () => {
    const input = await fixture('srt/minimal.srt');
    const r = await cli('shift', input, '--ms', '1.5');
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/--ms/);
  });
});

describe('formats and presets', () => {
  it('lists every format with read/write support', async () => {
    const r = await cli('formats');
    expect(r.code).toBe(0);
    const rows = r.out.slice(1).map((l) => l.split('\t'));
    expect(rows.map((row) => row[0])).toEqual(WRITABLE.map(([id]) => id));
    expect(rows.find((row) => row[0] === 'stl')).toEqual([
      'stl',
      'EBU-STL',
      '.stl',
      'binary',
      'yes',
      'yes',
    ]);
  });

  it('lists built-in presets with Verified/Draft', async () => {
    const r = await cli('presets');
    expect(r.code).toBe(0);
    expect(r.out).toContain('netflix-latin\tVerified');
    expect(r.out).toContain('generic\tDraft');
  });
});

describe('usage and errors', () => {
  it('prints help and version', async () => {
    const help = await cli('--help');
    expect(help.code).toBe(0);
    expect(help.out.join('\n')).toMatch(/Usage: cueforge <command>/);
    const version = await cli('--version');
    expect(version.code).toBe(0);
    expect(version.out[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each([
    [[], /Usage/],
    [['transcribe', 'a.srt'], /Unknown command "transcribe"/],
    [['convert', 'a.srt'], /--to/],
    [['shift', 'a.srt'], /--ms/],
    [['qc'], /input/],
    [['qc', 'a.srt', '--to', 'vtt'], /--to.*not valid for "qc"/],
    [['qc', 'a.srt', '--bogus'], /bogus/],
    [['formats', 'extra'], /Unexpected argument/],
  ])('exits 2 on usage error %j', async (args, message) => {
    const r = await cli(...args);
    expect(r.code).toBe(2);
    expect(r.out).toEqual([]);
    expect(r.err.join('\n')).toMatch(message);
  });

  it('exits 2 on a missing file', async () => {
    const r = await cli('qc', join(dir, 'nope.srt'));
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/Cannot read/);
  });

  it('exits 2 when a non-empty file yields no cues, and writes nothing', async () => {
    const input = await fixture('stl/corrupt.stl');
    const r = await cli('convert', input, '--to', 'srt');
    expect(r.code).toBe(2);
    expect(r.out).toEqual([]);
    expect(r.err.join('\n')).toMatch(/^error: No subtitles were found/m);
    expect(await readFile(join(dir, 'corrupt.srt')).catch(() => null)).toBeNull();
  });

  it('exits 2 on an unknown extension', async () => {
    const input = await write('notes.docx', 'hello');
    const r = await cli('convert', input, '--to', 'srt');
    expect(r.code).toBe(2);
    const msg = r.err.join('\n');
    expect(msg).toMatch(/Unrecognized subtitle format for "notes.docx"/);
    expect(msg).toContain('.srt, .vtt');
    expect(msg).toContain('.mcc');
    expect(msg).not.toMatch(/Pro/);
  });

  describe('read-only default output', () => {
    const roError = (code: string) => Object.assign(new Error(`${code}: read-only`), { code });
    /** Real fs, but writes into `ro` fail with `code` and cwd is `cwd`. */
    function roIo(ro: string, cwd: string, code: string, out: string[], err: string[]) {
      const base = nodeIo(
        (l) => out.push(l),
        (l) => err.push(l),
      );
      return {
        ...base,
        cwd: () => cwd,
        writeFile: (p: string, d: string | Uint8Array) =>
          p.startsWith(ro) ? Promise.reject(roError(code)) : base.writeFile(p, d),
      };
    }

    it.each(['EROFS', 'EACCES', 'EPERM'])('falls back to the cwd on %s', async (code) => {
      const input = await fixture('srt/typical.srt');
      const cwd = await mkdtemp(join(tmpdir(), 'cueforge-cwd-'));
      const out: string[] = [];
      const err: string[] = [];
      const c = await run(['convert', input, '--to', 'vtt'], roIo(dir, cwd, code, out, err));
      const expected = join(cwd, 'typical.vtt');
      expect(c).toBe(0);
      expect(out).toEqual([expected]);
      expect(err.join('\n')).toBe(
        `warning: "${dir}" is read-only; wrote ${expected} in the current directory instead.`,
      );
      expect(await readFile(expected, 'utf8')).toMatch(/^WEBVTT/);
      await rm(cwd, { recursive: true, force: true });
    });

    it('applies --force rules to the fallback and still fails when -o is given', async () => {
      const input = await fixture('srt/typical.srt');
      const cwd = await mkdtemp(join(tmpdir(), 'cueforge-cwd-'));
      await writeFile(join(cwd, 'typical.vtt'), 'keep me');
      const run1 = (...a: string[]) => {
        const out: string[] = [];
        const err: string[] = [];
        return run(a, roIo(dir, cwd, 'EROFS', out, err)).then((code) => ({ code, err }));
      };
      const refused = await run1('convert', input, '--to', 'vtt');
      expect(refused.code).toBe(2);
      expect(refused.err.join('\n')).toMatch(/already exists.*--force/);
      expect(await readFile(join(cwd, 'typical.vtt'), 'utf8')).toBe('keep me');
      expect((await run1('convert', input, '--to', 'vtt', '--force')).code).toBe(0);
      const explicit = await run1('convert', input, '--to', 'vtt', '-o', join(dir, 'x.vtt'));
      expect(explicit.code).toBe(2);
      expect(explicit.err.join('\n')).toMatch(/Cannot write/);
      await rm(cwd, { recursive: true, force: true });
    });

    it('fails when the fallback is not writable either', async () => {
      const input = await fixture('srt/typical.srt');
      const out: string[] = [];
      const err: string[] = [];
      const c = await run(
        ['convert', input, '--to', 'vtt'],
        roIo('/', '/nonexistent', 'EROFS', out, err),
      );
      expect(c).toBe(2);
      expect(out).toEqual([]);
    });
  });
});
