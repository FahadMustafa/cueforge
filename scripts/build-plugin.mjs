/**
 * Assemble the Claude plugin (cue-forge-89z1.4): copy the hand-written plugin/
 * tree to dist-plugin/cueforge/ and bundle the CLI into the skill's scripts/
 * folder as readable ESM, then check the Claude directory's submission rules
 * and throw on any breach.
 *
 * The CLI is bundled with esbuild (unminified, code-split) rather than emitted
 * per module by tsc: the QC presets are JSON imports, which plain `node`
 * refuses without import attributes, and esbuild inlines them. The lazy Pro
 * codecs become their own chunks, which keeps every file well under 256 KiB.
 *
 * The same script serves the public repo, whose committed plugin/ folder is the
 * built plugin: `--source plugin` with outDir `plugin` rebuilds its scripts/ in
 * place. Without `.claude-plugin/icon.png` in the source, the site icon is copied in.
 *
 *   node scripts/build-plugin.mjs [outDir] [--source <pluginDir>]
 */
import { cp, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = 'subtitles';
const ENTRY = 'cueforge.mjs';
const SCRIPTS = `skills/${SKILL}/scripts`;
const ICON = '.claude-plugin/icon.png';

export const LIMITS = {
  fileBytes: 256 * 1024,
  files: 512,
  readmeWords: 40,
  descriptionChars: 1024,
  skillBodyLines: 500,
  /** Longest source line allowed in scripts/; a minified file blows straight past it. */
  scriptLineChars: 1000,
  iconBytes: 2 * 1024 * 1024,
  iconMinPx: 512,
  iconMaxPx: 2048,
};

const SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const ROOT_FORBIDDEN = [
  'bin',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
];
const LAUNCHER_RE = /\b(?:npx|pnpx|bunx|pnpm dlx|yarn dlx)\b/;
const NETWORK_RE =
  /\bfetch\(|\bnode:(?:http|https|http2|net|tls|dgram|dns|child_process)\b|\bXMLHttpRequest\b|\bWebSocket\b/;

/**
 * Build the plugin from the hand-written `source` folder into `outDir` (replacing
 * it, or only its scripts/ when the two are the same folder), check it, and
 * return every file with its size.
 */
export async function buildPlugin({
  outDir = join(ROOT, 'dist-plugin', 'cueforge'),
  source = join(ROOT, 'plugin'),
} = {}) {
  outDir = resolve(outDir);
  source = resolve(source);
  const scripts = join(outDir, ...SCRIPTS.split('/'));
  if (outDir === source) {
    await rm(scripts, { recursive: true, force: true });
  } else {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const skip = join(source, ...SCRIPTS.split('/'));
    await cp(source, outDir, {
      recursive: true,
      filter: (src) => src !== skip && !src.startsWith(skip + sep),
    });
  }
  if (!(await exists(join(outDir, ICON)))) {
    await cp(join(ROOT, 'public/icon-512.png'), join(outDir, ICON));
  }

  await build({
    entryPoints: { cueforge: join(ROOT, 'src/cli/main.ts') },
    absWorkingDir: ROOT,
    outdir: scripts,
    outExtension: { '.js': '.mjs' },
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    minify: false,
    logLevel: 'warning',
  });

  return checkPlugin(outDir);
}

/** Check a built plugin folder against the directory rules; throws listing every breach. */
export async function checkPlugin(dir) {
  const errors = [];
  const files = [];

  async function walk(d) {
    for (const name of await readdir(d)) {
      const path = join(d, name);
      const rel = relative(dir, path).split(sep).join('/');
      const st = await lstat(path);
      if (st.isSymbolicLink()) errors.push(`${rel}: symlinks are not allowed`);
      else if (st.isDirectory()) await walk(path);
      else files.push({ path: rel, abs: path, bytes: st.size });
      if (SYSTEM_FILES.has(name)) errors.push(`${rel}: system file`);
    }
  }
  await walk(dir);

  if (files.length > LIMITS.files) errors.push(`${files.length} files (max ${LIMITS.files})`);
  for (const name of ROOT_FORBIDDEN) {
    if (await exists(join(dir, name))) errors.push(`${name}: not allowed at the plugin root`);
  }

  const text = new Map();
  for (const f of files) {
    const bytes = await readFile(f.abs);
    if (f.path.endsWith('.png')) {
      // Complete images are allowed (and exempt from the 256 KiB text-file cap).
      const png = pngSize(bytes);
      if (!png) errors.push(`${f.path}: not a complete PNG`);
      else if (f.path === ICON) errors.push(...checkIcon(png, f.bytes));
      continue;
    }
    if (f.bytes >= LIMITS.fileBytes) errors.push(`${f.path}: ${f.bytes} bytes (max < 262144)`);
    let s;
    try {
      s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      errors.push(`${f.path}: not UTF-8 text`);
      continue;
    }
    if (s.includes('\0')) errors.push(`${f.path}: contains NUL bytes (binary)`);
    if (LAUNCHER_RE.test(s)) errors.push(`${f.path}: mentions a package launcher`);
    if (/\.(?:m?js|cjs)$/.test(f.path)) {
      if (NETWORK_RE.test(s)) errors.push(`${f.path}: uses a network API`);
      const longest = Math.max(...s.split('\n').map((l) => l.length));
      if (longest > LIMITS.scriptLineChars) {
        errors.push(`${f.path}: a ${longest}-character line looks minified`);
      }
    }
    text.set(f.path, s);
  }

  if (!files.some((f) => f.path === ICON)) errors.push(`${ICON}: missing`);
  for (const required of [
    '.claude-plugin/plugin.json',
    'README.md',
    'LICENSE',
    `skills/${SKILL}/SKILL.md`,
    `${SCRIPTS}/${ENTRY}`,
  ]) {
    if (!text.has(required)) errors.push(`${required}: missing`);
  }

  const manifest = text.get('.claude-plugin/plugin.json');
  if (manifest !== undefined) errors.push(...checkManifest(manifest, await cliVersion()));
  const readme = text.get('README.md');
  if (readme !== undefined) {
    const words = proseWords(readme);
    if (words < LIMITS.readmeWords) {
      errors.push(`README.md: ${words} words outside code blocks (min ${LIMITS.readmeWords})`);
    }
  }
  const skill = text.get(`skills/${SKILL}/SKILL.md`);
  if (skill !== undefined) errors.push(...checkSkill(skill));

  if (errors.length > 0) {
    throw new Error(`Plugin check failed for ${dir}:\n  ${errors.join('\n  ')}`);
  }
  return files
    .map(({ path, bytes }) => ({ path, bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

function checkManifest(source, version) {
  let m;
  try {
    m = JSON.parse(source);
  } catch (err) {
    return [`plugin.json: ${err.message}`];
  }
  const errors = [];
  if (m.name !== 'cueforge') errors.push(`plugin.json: name must be "cueforge", got ${m.name}`);
  for (const key of ['displayName', 'version', 'description', 'license']) {
    if (typeof m[key] !== 'string' || m[key] === '') errors.push(`plugin.json: ${key} missing`);
  }
  if (m.license !== 'MIT') errors.push(`plugin.json: license must be "MIT"`);
  if (m.author?.name !== 'Fahad Mustafa' || m.author?.url !== 'https://cue-forge.com') {
    errors.push(
      'plugin.json: author must be { name: "Fahad Mustafa", url: "https://cue-forge.com" }',
    );
  }
  if (m.version !== version) {
    errors.push(`plugin.json: version ${m.version} differs from the CLI VERSION ${version}`);
  }
  return errors;
}

function checkSkill(source) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source.replace(/\r\n/g, '\n'));
  if (!match) return ['SKILL.md: missing YAML frontmatter'];
  const [, front, body] = match;
  // ponytail: one-line `key: value` frontmatter only; use a YAML parser if SKILL.md needs more.
  const field = (key) => new RegExp(`^${key}: *(.+)$`, 'm').exec(front)?.[1]?.trim();
  const errors = [];
  if (field('name') !== SKILL) errors.push(`SKILL.md: name must be "${SKILL}" (the folder name)`);
  const description = field('description');
  if (!description) errors.push('SKILL.md: description missing');
  else if (description.length > LIMITS.descriptionChars) {
    errors.push(
      `SKILL.md: description is ${description.length} chars (max ${LIMITS.descriptionChars})`,
    );
  }
  const lines = body.split('\n').length;
  if (lines >= LIMITS.skillBodyLines) {
    errors.push(`SKILL.md: body is ${lines} lines (max < ${LIMITS.skillBodyLines})`);
  }
  return errors;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Width and height from the IHDR of a complete PNG (signature, IHDR first, chunks
 * that fit, IEND exactly at the end), or null for anything else.
 */
export function pngSize(data) {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length < 8 || !PNG_SIGNATURE.equals(bytes.subarray(0, 8))) return null;
  let size = null;
  for (let off = 8; off + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(off);
    const type = bytes.toString('latin1', off + 4, off + 8);
    const end = off + 12 + length;
    if (end > bytes.length) return null;
    if (off === 8) {
      if (type !== 'IHDR' || length !== 13) return null;
      size = { width: bytes.readUInt32BE(off + 8), height: bytes.readUInt32BE(off + 12) };
    }
    if (type === 'IEND') return end === bytes.length ? size : null;
    off = end;
  }
  return null;
}

function checkIcon({ width, height }, bytes) {
  const errors = [];
  if (width !== height) errors.push(`${ICON}: ${width}x${height} is not square`);
  else if (width < LIMITS.iconMinPx || width > LIMITS.iconMaxPx) {
    errors.push(`${ICON}: ${width} px (need ${LIMITS.iconMinPx} to ${LIMITS.iconMaxPx})`);
  }
  if (bytes >= LIMITS.iconBytes) errors.push(`${ICON}: ${bytes} bytes (max < 2 MB)`);
  return errors;
}

/** Words in Markdown prose, ignoring fenced code blocks. */
export function proseWords(markdown) {
  const prose = markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
  return prose.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** The CLI's `VERSION` constant from src/cli/cli.ts. */
export async function cliVersion() {
  const src = await readFile(join(ROOT, 'src/cli/cli.ts'), 'utf8');
  const v = /^export const VERSION = '([^']+)';$/m.exec(src)?.[1];
  if (!v) throw new Error('src/cli/cli.ts: cannot find export const VERSION');
  return v;
}

const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { positionals, values } = parseArgs({
      options: { source: { type: 'string' } },
      allowPositionals: true,
    });
    const files = await buildPlugin({ outDir: positionals[0], source: values.source });
    for (const f of files) console.log(`${String(f.bytes).padStart(8)}  ${f.path}`);
    console.log(`${files.length} files, all checks passed.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
