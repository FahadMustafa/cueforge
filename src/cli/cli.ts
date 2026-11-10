/**
 * CueForge command line: convert, check (qc), auto-fix and shift subtitle files
 * locally, on the same DOM-free import/export pipeline the web app uses.
 *
 * {@link run} does all the work over an injected {@link CliIo}, so it is tested
 * without spawning a process; `main.ts` wires the real process and file system.
 * Exit codes: 0 ok, 1 `qc` found an error-severity issue, 2 anything else that
 * went wrong (usage, unreadable input, invalid ruleset, failed export).
 */
import { access, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  exportDocument,
  exportProDocument,
  FileTooLargeError,
  friendlyLoadError,
  importFile,
  UnknownFormatError,
  type LoadedDocument,
} from '../app/session/session';
import type { ParseWarning } from '../core/model/types';
import { PRO_FORMATS, type ProFormatId } from '../core/formats/pro';
import { TEXT_FORMAT_IDS, TEXT_FORMATS, type TextFormatId } from '../core/formats/registry';
import {
  autoFix,
  DEFAULT_PRESET,
  evaluate,
  PRESETS,
  validateRuleset,
  type QCIssue,
  type RuleId,
  type Ruleset,
  type Severity,
} from '../core/qc';
import { shiftCues } from '../core/timing/timing';

export const VERSION = '0.1.0';

/** Everything {@link run} touches outside itself. Paths are passed through as given. */
export interface CliIo {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** The current working directory. A `writeFile` failure may carry a Node `code` (EROFS...). */
  cwd(): string;
  /** Write one line of data (no trailing newline in `line`). */
  stdout(line: string): void;
  /** Write one line of diagnostics (no trailing newline in `line`). */
  stderr(line: string): void;
}

/** A {@link CliIo} over `node:fs`; text is written as UTF-8 without a BOM. */
export function nodeIo(stdout: (line: string) => void, stderr: (line: string) => void): CliIo {
  return {
    readFile: (path) => readFile(path),
    writeFile: (path, data) => writeFile(path, data),
    exists: (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    cwd: () => process.cwd(),
    stdout,
    stderr,
  };
}

/** One issue in {@link QcJsonReport}. */
export interface QcJsonIssue {
  ruleId: RuleId;
  /** The cue's 1-based index in the (repaired) document, or -1 for a document-level issue. */
  cueIndex: number;
  severity: Severity;
  message: string;
  /** Whether `fix` can resolve it on this cue (the engine's per-cue verdict when it has one). */
  fixable: boolean;
}

/** The single JSON object `qc --json` prints to stdout. Key order is stable. */
export interface QcJsonReport {
  /** The input path exactly as passed on the command line. */
  file: string;
  /** Detected source format id (see `cueforge formats`). */
  format: TextFormatId | ProFormatId;
  /** Built-in preset id, or the `name` field of a custom ruleset file. */
  preset: string;
  /** True only when `preset` is one of the built-in presets (never for a ruleset file). */
  presetBuiltin: boolean;
  /** True only for a built-in preset whose `verified` is true; always false for a file. */
  presetVerified: boolean;
  cueCount: number;
  counts: Record<Severity, number>;
  /** Ordered by cue index; document-level issues (-1) first. */
  issues: QcJsonIssue[];
}

type FormatId = TextFormatId | ProFormatId;

interface FormatInfo {
  id: FormatId;
  name: string;
  extensions: readonly string[];
  kind: 'text' | 'binary';
  /** `yes`, or how the format is read when it has no detector of its own. */
  read: string;
}

const FORMATS: readonly FormatInfo[] = [
  ...TEXT_FORMAT_IDS.map((id) => ({ ...TEXT_FORMATS[id], id, kind: 'text' as const, read: 'yes' })),
  // IMSC files are TTML documents: detectImportFormat reads them as `ttml`.
  ...PRO_FORMATS.map((f) => ({
    ...f,
    read: f.id === 'imsc101' || f.id === 'imsc11' ? 'as ttml' : 'yes',
  })),
];

const HELP = `Usage: cueforge <command> [options]

Convert, check and fix subtitle files locally. Nothing is uploaded.

Commands:
  convert <input> --to <format> [-o <output>]
      Convert to another format. Default output: <name>.<target ext> next to the input.
  qc <input> [--preset <name|ruleset.json>] [--json]
      Check against a QC preset (default: ${DEFAULT_PRESET}). --json prints one object:
      { file, format, preset, presetBuiltin, presetVerified, cueCount,
        counts: { error, warning },
        issues: [{ ruleId, cueIndex, severity, message, fixable }] }
  fix <input> [--preset <name|ruleset.json>] [-o <output>]
      Auto-fix QC issues and write the source format. Default output: <name>.fixed.<ext>
  shift <input> --ms <integer> [-o <output>]
      Move every cue by a signed number of milliseconds. Default output: <name>.shifted.<ext>
  formats    List formats: id, name, extensions, text/binary, read, write
  presets    List built-in QC presets (Verified or Draft)

Options:
  -o, --output <path>  Output file path
  --force              Overwrite an existing output file
  -h, --help           Show this help
  -v, --version        Show the version

Results and written paths go to stdout; warnings go to stderr.
Exit codes: 0 ok, 1 qc found an error-severity issue, 2 usage or input error.`;

const OPTIONS = {
  to: { type: 'string' },
  output: { type: 'string', short: 'o' },
  preset: { type: 'string' },
  json: { type: 'boolean' },
  ms: { type: 'string' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type Flag = Exclude<keyof typeof OPTIONS, 'help' | 'version'>;

const COMMANDS: Record<string, { input: boolean; flags: readonly Flag[] }> = {
  convert: { input: true, flags: ['to', 'output', 'force'] },
  qc: { input: true, flags: ['preset', 'json'] },
  fix: { input: true, flags: ['preset', 'output', 'force'] },
  shift: { input: true, flags: ['ms', 'output', 'force'] },
  formats: { input: false, flags: [] },
  presets: { input: false, flags: [] },
};

/** Every failure the CLI reports; all map to exit code 2. */
class CliError extends Error {}

function usage(message: string): CliError {
  return new CliError(`${message}\nRun "cueforge --help" for usage.`);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Run one CLI invocation; resolves to the process exit code. Never throws. */
export async function run(argv: string[], io: CliIo): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (err) {
    io.stderr(`error: ${errorText(err)}`);
    return 2;
  }
}

/** parseArgs refuses `--ms -500` as ambiguous; a negative number there is never a flag. */
function joinNegativeMs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === '--ms' && next !== undefined && /^-\d/.test(next)) {
      out.push(`--ms=${next}`);
      i++;
    } else {
      out.push(argv[i]!);
    }
  }
  return out;
}

async function dispatch(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: joinNegativeMs(argv),
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw usage(errorText(err));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(HELP);
    return 0;
  }
  if (values.version) {
    io.stdout(VERSION);
    return 0;
  }

  const [command, ...args] = positionals;
  if (command === undefined) {
    io.stderr(HELP);
    return 2;
  }
  const spec = COMMANDS[command];
  if (spec === undefined) throw usage(`Unknown command "${command}".`);
  for (const key of Object.keys(values)) {
    if (!spec.flags.includes(key as Flag)) throw usage(`--${key} is not valid for "${command}".`);
  }
  const [input, ...extra] = args;
  if (spec.input && input === undefined) throw usage(`"${command}" needs an <input> file.`);
  const unexpected = spec.input ? extra : args;
  if (unexpected.length > 0) throw usage(`Unexpected argument "${unexpected[0]}".`);

  const output = { path: values.output, force: values.force === true };
  switch (command) {
    case 'formats':
      io.stdout('id\tname\textensions\tkind\tread\twrite');
      for (const f of FORMATS) {
        io.stdout([f.id, f.name, f.extensions.join(','), f.kind, f.read, 'yes'].join('\t'));
      }
      return 0;
    case 'presets':
      for (const [name, ruleset] of Object.entries(PRESETS)) {
        io.stdout(`${name}\t${ruleset.verified ? 'Verified' : 'Draft'}`);
      }
      return 0;
    case 'convert': {
      if (values.to === undefined) throw usage('"convert" needs --to <format>.');
      const target = parseFormat(values.to);
      const loaded = await load(input!, io);
      await save(io, loaded, target, output, defaultPath(input!, '', primaryExt(target)));
      return 0;
    }
    case 'shift': {
      if (values.ms === undefined) throw usage('"shift" needs --ms <integer>.');
      if (!/^[+-]?\d+$/.test(values.ms) || !Number.isSafeInteger(Number(values.ms))) {
        throw usage(`--ms must be a whole number of milliseconds, got "${values.ms}".`);
      }
      const ms = Number(values.ms);
      const loaded = await load(input!, io);
      const clamped = loaded.doc.cues.filter((c) => c.startMs + ms < 0).length;
      if (clamped > 0) {
        io.stderr(`warning: ${clamped} cue(s) would start before 00:00:00 and were clamped to 0.`);
      }
      const shifted = { ...loaded, doc: shiftCues(loaded.doc, ms) };
      await save(
        io,
        shifted,
        loaded.sourceFormat,
        output,
        sameFormatPath(input!, '.shifted', loaded),
      );
      return 0;
    }
    case 'qc': {
      const { name, ruleset, builtin } = await loadRuleset(values.preset, io);
      const loaded = await load(input!, io);
      const report = qcReport(
        input!,
        loaded,
        name,
        builtin,
        ruleset,
        evaluate(loaded.doc, ruleset),
      );
      if (values.json) {
        io.stdout(JSON.stringify(report));
      } else {
        io.stdout(
          `${report.file}: ${report.format}, ${report.cueCount} cues, ${presetLabel(report, values.preset!)}: ${counted(report.counts)}`,
        );
        for (const i of report.issues) {
          const where = i.cueIndex < 0 ? 'document' : `cue ${i.cueIndex}`;
          io.stdout(
            `  ${where}\t${i.severity}\t${i.ruleId}\t${i.message}${i.fixable ? ' [fixable]' : ''}`,
          );
        }
      }
      return report.counts.error > 0 ? 1 : 0;
    }
    case 'fix': {
      const { ruleset } = await loadRuleset(values.preset, io);
      const loaded = await load(input!, io);
      const result = autoFix(loaded.doc, evaluate(loaded.doc, ruleset), { ruleset });
      const remaining = severityCounts(evaluate(result.doc, ruleset));
      const fixed = { ...loaded, doc: result.doc };
      await save(io, fixed, loaded.sourceFormat, output, sameFormatPath(input!, '.fixed', loaded));
      const n = result.resolvedCount;
      io.stdout(
        `Resolved ${n} issue${n === 1 ? '' : 's'}, ${remaining.error + remaining.warning} remaining (${counted(remaining)}).`,
      );
      return 0;
    }
  }
  /* v8 ignore next -- COMMANDS lookup above rejects anything else */
  throw new CliError(`Unhandled command "${command}".`);
}

/** One-line source label; a ruleset file is always "custom" and always Draft. */
function presetLabel(report: QcJsonReport, spec: string): string {
  return report.presetBuiltin
    ? `preset ${report.preset} (${report.presetVerified ? 'Verified' : 'Draft'})`
    : `custom preset "${report.preset}" from ${spec} (Draft)`;
}

function parseFormat(value: string): FormatId {
  const id = value.toLowerCase();
  const found = FORMATS.find((f) => f.id === id);
  if (!found) {
    throw usage(`Unknown format "${value}". Formats: ${FORMATS.map((f) => f.id).join(', ')}.`);
  }
  return found.id;
}

function primaryExt(id: FormatId): string {
  return FORMATS.find((f) => f.id === id)?.extensions[0] ?? `.${id}`;
}

function defaultPath(input: string, suffix: string, ext: string): string {
  return join(dirname(input), basename(input, extname(input)) + suffix + ext);
}

/** fix/shift keep the input's own extension (.ssa, .dfxp, .xml stay as they were). */
function sameFormatPath(input: string, suffix: string, loaded: LoadedDocument): string {
  return defaultPath(input, suffix, extname(input) || primaryExt(loaded.sourceFormat));
}

function warn(io: CliIo, warnings: readonly { message: string }[]): void {
  for (const w of warnings) io.stderr(`warning: ${w.message}`);
}

/** Read, detect, decode, parse and repair; repairs and parse warnings go to stderr. */
async function load(path: string, io: CliIo): Promise<LoadedDocument> {
  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(path);
  } catch (err) {
    throw new CliError(`Cannot read "${path}": ${errorText(err)}`);
  }
  let loaded: LoadedDocument;
  try {
    loaded = await importFile(basename(path), bytes, { allowPro: true });
  } catch (err) {
    const message = friendlyLoadError(err, path);
    if (err instanceof UnknownFormatError) {
      // The CLI reads every format, so the web app's "(Pro)" wording would be wrong here.
      const exts = [...new Set(FORMATS.flatMap((f) => f.extensions))].join(', ');
      throw new CliError(
        `Unrecognized subtitle format for "${basename(path)}". Supported: ${exts}.`,
      );
    }
    throw new CliError(
      err instanceof FileTooLargeError ? message : `${message} (${errorText(err)})`,
    );
  }
  // A non-empty file that parsed to zero cues is unreadable input, not a warning:
  // carrying on would write an empty output and exit 0.
  const empty = loaded.parseWarnings.find((w) => w.code === 'empty-result');
  warn(
    io,
    loaded.parseWarnings.filter((w) => w !== empty),
  );
  warn(io, loaded.repairs);
  if (empty) throw new CliError(empty.message);
  return loaded;
}

/** Serialize to `target`, print conversion warnings, then write without clobbering. */
async function save(
  io: CliIo,
  loaded: LoadedDocument,
  target: FormatId,
  output: { path: string | undefined; force: boolean },
  fallbackPath: string,
): Promise<void> {
  let data: string | Uint8Array | undefined;
  let warnings: ParseWarning[];
  try {
    if ((TEXT_FORMAT_IDS as readonly string[]).includes(target)) {
      const r = exportDocument(loaded, target as TextFormatId);
      ({ text: data, warnings } = r);
    } else {
      const r = await exportProDocument(loaded, target as ProFormatId);
      data = r.kind === 'binary' ? r.bytes : r.text;
      warnings = r.warnings;
    }
  } catch (err) {
    throw new CliError(`Export to ${target} failed: ${errorText(err)}`);
  }
  if (data === undefined) throw new CliError(`Export to ${target} produced no output.`);
  warn(io, warnings);

  const path = output.path ?? fallbackPath;
  if (!output.force && (await io.exists(path))) {
    throw new CliError(`"${path}" already exists; pass --force to overwrite.`);
  }
  try {
    await io.writeFile(path, data);
    io.stdout(path);
    return;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (output.path !== undefined || !['EROFS', 'EACCES', 'EPERM'].includes(String(code))) {
      throw new CliError(`Cannot write "${path}": ${errorText(err)}`);
    }
  }
  // Default output next to a read-only input (e.g. a chat sandbox's uploads folder).
  const alt = join(io.cwd(), basename(path));
  if (!output.force && (await io.exists(alt))) {
    throw new CliError(`"${alt}" already exists; pass --force to overwrite.`);
  }
  try {
    await io.writeFile(alt, data);
  } catch (err) {
    throw new CliError(`Cannot write "${path}" or "${alt}": ${errorText(err)}`);
  }
  io.stderr(
    `warning: "${dirname(path)}" is read-only; wrote ${alt} in the current directory instead.`,
  );
  io.stdout(alt);
}

/** A built-in preset id, or a path to a ruleset JSON file checked by validateRuleset. */
async function loadRuleset(
  spec: string | undefined,
  io: CliIo,
): Promise<{ name: string; ruleset: Ruleset; builtin: boolean }> {
  const name = spec ?? DEFAULT_PRESET;
  if (Object.hasOwn(PRESETS, name))
    return { name, ruleset: PRESETS[name as keyof typeof PRESETS], builtin: true };
  if (!(await io.exists(name))) {
    throw usage(
      `Unknown preset "${name}". Built-in presets: ${Object.keys(PRESETS).join(', ')}; or pass a path to a ruleset JSON file.`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(await io.readFile(name)));
  } catch (err) {
    throw new CliError(`Invalid ruleset "${name}": ${errorText(err)}`);
  }
  const errors = validateRuleset(data);
  if (errors.length > 0) {
    throw new CliError(`Invalid ruleset "${name}":\n  ${errors.join('\n  ')}`);
  }
  const ruleset = data as Ruleset;
  return { name: ruleset.name, ruleset, builtin: false };
}

function severityCounts(issues: readonly QCIssue[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0 };
  for (const i of issues) counts[i.severity]++;
  return counts;
}

function counted(c: Record<Severity, number>): string {
  const s = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `${s(c.error, 'error')}, ${s(c.warning, 'warning')}`;
}

function qcReport(
  file: string,
  loaded: LoadedDocument,
  preset: string,
  builtin: boolean,
  ruleset: Ruleset,
  issues: readonly QCIssue[],
): QcJsonReport {
  return {
    file,
    format: loaded.sourceFormat,
    preset,
    presetBuiltin: builtin,
    presetVerified: builtin && ruleset.verified,
    cueCount: loaded.doc.cues.length,
    counts: severityCounts(issues),
    issues: issues.map((i) => ({
      ruleId: i.ruleId,
      cueIndex: i.cueIndex,
      severity: i.severity,
      message: i.message,
      fixable: i.effectivelyFixable ?? i.fixable,
    })),
  };
}
