import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '../../src/cli/cli';
import {
  buildPlugin,
  checkPlugin,
  LIMITS,
  pngSize,
  proseWords,
} from '../../scripts/build-plugin.mjs';

const ROOT = resolve(__dirname, '../..');
const SCRIPTS = 'skills/subtitles/scripts';
const ICON = '.claude-plugin/icon.png';
/**
 * In the private repo plugin/ is hand-written source; in the public repo (which has
 * no public-repo/ folder) plugin/ is the committed build, scripts included.
 */
const COMMITTED_BUILD = !existsSync(join(ROOT, 'public-repo'));

/** All files under `dir` as `relative path -> bytes`, sorted by path. */
async function tree(dir: string): Promise<Map<string, Buffer>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
  return new Map(
    await Promise.all(files.map(async (f) => [f, await readFile(join(dir, f))] as const)),
  );
}

describe('scripts/build-plugin.mjs', () => {
  let tmp: string;
  let out: string;
  let work: string;
  let entry: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'cueforge-plugin-'));
    out = join(tmp, 'cueforge');
    work = join(tmp, 'work');
    await mkdir(work);
    entry = join(out, SCRIPTS, 'cueforge.mjs');
    await buildPlugin({ outDir: out });
  }, 60_000);

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** Run the built CLI with the real node binary from a directory outside the repo. */
  const node = (...args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], { cwd: work, encoding: 'utf8' });

  it('ships the plugin files with a manifest matching the CLI version', async () => {
    const manifest = JSON.parse(
      await readFile(join(out, '.claude-plugin/plugin.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: 'cueforge',
      version: VERSION,
      author: { name: 'Fahad Mustafa', url: 'https://cue-forge.com' },
      license: 'MIT',
    });
    expect(manifest.displayName).toBeTruthy();
    expect(manifest.description).toBeTruthy();
    expect(await readFile(join(out, 'LICENSE'), 'utf8')).toMatch(/^MIT License/);
    expect(proseWords(await readFile(join(out, 'README.md'), 'utf8'))).toBeGreaterThanOrEqual(40);
    const icon = await readFile(join(out, ICON));
    expect(pngSize(icon)).toEqual({ width: 512, height: 512 });
    expect(icon.length).toBeLessThan(LIMITS.iconBytes);
  });

  it.runIf(COMMITTED_BUILD)('commits a plugin/ identical to a fresh build', async () => {
    const committed = await tree(join(ROOT, 'plugin'));
    const fresh = await tree(out);
    expect([...committed.keys()]).toEqual([...fresh.keys()]);
    for (const [path, bytes] of fresh) {
      expect(committed.get(path)?.equals(bytes), `${path} differs; run npm run build:plugin`).toBe(
        true,
      );
    }
  });

  it('meets the directory rules for every file', async () => {
    const entries = await readdir(out, { recursive: true, withFileTypes: true });
    const files = entries.filter((e) => e.isFile());
    expect(entries.filter((e) => e.isSymbolicLink())).toEqual([]);
    expect(files.length).toBeLessThanOrEqual(512);
    const top = await readdir(out);
    for (const banned of ['bin', 'package.json', 'package-lock.json']) {
      expect(top).not.toContain(banned);
    }
    for (const e of files) {
      const path = join(e.parentPath, e.name);
      const rel = relative(out, path);
      const bytes = await readFile(path);
      if (rel === ICON) continue; // the one image, checked above
      expect(bytes.length, rel).toBeLessThan(262_144);
      expect(['.DS_Store', 'Thumbs.db'], rel).not.toContain(e.name);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      expect(text, rel).not.toContain('\0');
      expect(text, rel).not.toMatch(/\bnpx\b/);
      if (rel.endsWith('.mjs')) {
        expect(rel.startsWith(SCRIPTS), rel).toBe(true);
        expect(text, rel).not.toMatch(/\bfetch\(|node:https?\b|node:net\b/);
        expect(Math.max(...text.split('\n').map((l) => l.length)), rel).toBeLessThan(1000);
      }
    }
  });

  it('has a SKILL.md the model can route on', async () => {
    const skill = await readFile(join(out, 'skills/subtitles/SKILL.md'), 'utf8');
    const [, front = '', body = ''] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill) ?? [];
    expect(front).toMatch(/^name: subtitles$/m);
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(100);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(body.split('\n').length).toBeLessThan(500);
    expect(body).toContain('${CLAUDE_SKILL_DIR}/scripts/cueforge.mjs');

    // Every format id and preset the CLI knows is documented.
    const ids = node('formats')
      .stdout.trim()
      .split('\n')
      .slice(1)
      .map((l) => l.split('\t')[0]);
    const presets = node('presets')
      .stdout.trim()
      .split('\n')
      .map((l) => l.split('\t')[0]);
    for (const id of [...ids, ...presets]) expect(body).toContain(`\`${id}\``);
  });

  it('runs formats, convert and qc --json under real node', async () => {
    const formats = node('formats');
    expect(formats.status, formats.stderr).toBe(0);
    expect(formats.stdout).toMatch(/^mcc\tMCC \(CEA-708\)\t\.mcc\ttext\tyes\tyes$/m);

    const vtt = join(work, 'typical.vtt');
    const toVtt = node('convert', join(ROOT, 'fixtures/srt/typical.srt'), '--to', 'vtt', '-o', vtt);
    expect(toVtt.status, toVtt.stderr).toBe(0);
    expect(toVtt.stdout).toBe(`${vtt}\n`);
    expect(await readFile(vtt, 'utf8')).toMatch(/^WEBVTT/);

    const qc = node(
      'qc',
      join(ROOT, 'fixtures/srt/typical.srt'),
      '--preset',
      'netflix-latin',
      '--json',
    );
    expect(qc.status, qc.stderr).toBe(0);
    expect(JSON.parse(qc.stdout)).toMatchObject({
      format: 'srt',
      preset: 'netflix-latin',
      presetBuiltin: true,
      presetVerified: true,
      cueCount: 45,
      counts: { error: 0, warning: 0 },
      issues: [],
    });
  });

  it('round-trips binary EBU-STL through the lazy codec chunk', async () => {
    const ok = (...args: string[]) => {
      const r = node(...args);
      expect(r.status, r.stderr).toBe(0);
    };
    const [a, b, c] = ['a.srt', 'b.stl', 'c.srt'].map((n) => join(work, n)) as [
      string,
      string,
      string,
    ];
    ok('convert', join(ROOT, 'fixtures/stl/typical.stl'), '--to', 'srt', '-o', a);
    ok('convert', a, '--to', 'stl', '-o', b);
    ok('convert', b, '--to', 'srt', '-o', c);
    expect((await readFile(b)).subarray(3, 11).toString('latin1')).toMatch(/^STL(25|30)\.01$/);
    expect(await readFile(c, 'utf8')).toBe(await readFile(a, 'utf8'));
  });

  it('fails loudly on each directory-rule breach', async () => {
    const bad = join(tmp, 'bad');
    await cp(out, bad, { recursive: true });
    await mkdir(join(bad, 'bin'));
    await writeFile(join(bad, 'package.json'), '{}');
    await writeFile(join(bad, '.DS_Store'), 'x');
    await writeFile(join(bad, 'big.txt'), 'a\n'.repeat(LIMITS.fileBytes / 2));
    await writeFile(join(bad, SCRIPTS, 'min.mjs'), `var a=1;${'a+=1;'.repeat(300)}`);
    await writeFile(join(bad, SCRIPTS, 'net.mjs'), 'await fetch("https://example.com");\n');
    await writeFile(join(bad, 'run.md'), 'npx cueforge\n');
    await writeFile(join(bad, 'blob.txt'), new Uint8Array([0xff, 0xfe, 0x00]));
    const icon = await readFile(join(out, ICON));
    await writeFile(join(bad, 'cut.png'), icon.subarray(0, icon.length - 4));
    const wide = Buffer.from(icon);
    wide.writeUInt32BE(1024, 16); // IHDR width
    await writeFile(join(bad, ICON), wide);
    await symlink(join(bad, 'LICENSE'), join(bad, 'link'));
    const manifestPath = join(bad, '.claude-plugin/plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: '9.9.9' }));
    await writeFile(
      join(bad, 'README.md'),
      'Too short.\n\n```sh\n' + 'word '.repeat(50) + '\n```\n',
    );

    const err = await checkPlugin(bad).then(
      () => null,
      (e: unknown) => String(e),
    );
    for (const expected of [
      'bin: not allowed at the plugin root',
      'package.json: not allowed at the plugin root',
      '.DS_Store: system file',
      'big.txt: 262144 bytes',
      'min.mjs: a 1508-character line looks minified',
      'net.mjs: uses a network API',
      'run.md: mentions a package launcher',
      'blob.txt: not UTF-8 text',
      'cut.png: not a complete PNG',
      '.claude-plugin/icon.png: 1024x512 is not square',
      'link: symlinks are not allowed',
      'differs from the CLI VERSION',
      'README.md: 2 words outside code blocks',
    ]) {
      expect(err).toContain(expected);
    }
  });
});
