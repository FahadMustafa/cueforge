import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

/**
 * The public CLI release ships exactly the import closure of src/cli/main.ts,
 * so it must stay clear of licensing, transcription, React and app UI code.
 */
const APP_ALLOWLIST = ['src/app/editor/uid.ts', 'src/app/session/session.ts'];

describe('src/cli/main.ts bundle', () => {
  let dir: string;
  let inputs: string[];
  let bundle: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cueforge-bundle-'));
    bundle = join(dir, 'cueforge.mjs');
    const result = await build({
      entryPoints: [join(ROOT, 'src/cli/main.ts')],
      absWorkingDir: ROOT,
      bundle: true,
      outfile: bundle,
      metafile: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
    });
    inputs = Object.keys(result.metafile.inputs);
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps forbidden modules out of the import closure', () => {
    expect(inputs).toContain('src/cli/main.ts');
    expect(inputs).not.toContain('src/core/license.ts');
    expect(inputs.filter((p) => p.startsWith('src/core/transcribe/'))).toEqual([]);
    expect(inputs.filter((p) => p.endsWith('.tsx'))).toEqual([]);
    expect(inputs.filter((p) => p.includes('node_modules/'))).toEqual([]);
    expect(inputs.filter((p) => p.startsWith('src/app/')).sort()).toEqual(APP_ALLOWLIST);
  });

  it('runs under the real node binary, including lazy Pro codecs', async () => {
    const node = (...args: string[]) => {
      const r = spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      return r;
    };

    expect(node('formats').stdout).toMatch(/^stl\tEBU-STL\t\.stl\tbinary\tyes\tyes$/m);

    const out = join(dir, 'typical.srt');
    const r = node('convert', join(ROOT, 'fixtures/stl/typical.stl'), '--to', 'srt', '-o', out);
    expect(r.stdout).toBe(`${out}\n`);
    expect(r.stderr).toMatch(/^warning: /m);
    expect(await readFile(out, 'utf8')).toMatch(/^1\r?\n\d\d:\d\d:\d\d,\d{3} --> /);
  }, 60_000);
});
